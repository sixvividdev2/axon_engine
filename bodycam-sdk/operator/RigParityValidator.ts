import * as THREE from 'three';
import {
  CANONICAL_RIG_PARENT_MAP,
  CanonicalRigNodeName,
  HIT_ZONE_NODE_NAMES,
  OPERATOR_RIG_CONTRACT,
  OperatorId,
  PRIMARY_BONE_NAMES,
  SECONDARY_BONE_NAMES,
  SOCKET_AND_POLE_NAMES,
} from './OperatorTypes';

export type RigValidationMode = 'STRICT' | 'SAFE_FALLBACK';

export interface RigValidationIssue {
  readonly code:
    | 'MISSING_NODE'
    | 'DUPLICATE_NODE'
    | 'INVALID_PARENT'
    | 'NON_UNIT_SCALE'
    | 'BODYCAM_CLEARANCE'
    | 'CHEST_GEAR_CLEARANCE'
    | 'REST_AXIS_PARITY';
  readonly nodeName: string;
  readonly message: string;
}

export interface RigValidationReport {
  readonly valid: boolean;
  readonly operatorId: OperatorId;
  readonly issues: readonly RigValidationIssue[];
  readonly nodeCount: number;
  readonly checkedAtMs: number;
}

export class RigContractViolationError extends Error {
  public readonly report: RigValidationReport;

  constructor(report: RigValidationReport) {
    const summary = report.issues
      .slice(0, 6)
      .map((i) => `[${i.code}] ${i.nodeName}: ${i.message}`)
      .join('; ');
    super(`Rig contract violation for operator "${report.operatorId}": ${summary}`);
    this.name = 'RigContractViolationError';
    this.report = report;
  }
}

const ALL_REQUIRED_NODES: readonly CanonicalRigNodeName[] = [
  ...PRIMARY_BONE_NAMES,
  ...SECONDARY_BONE_NAMES,
  ...SOCKET_AND_POLE_NAMES,
  ...HIT_ZONE_NODE_NAMES,
];

const _worldScale = new THREE.Vector3();
const _nodeWorldA = new THREE.Vector3();
const _nodeWorldB = new THREE.Vector3();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _axisXA = new THREE.Vector3();
const _axisYA = new THREE.Vector3();
const _axisZA = new THREE.Vector3();
const _axisXB = new THREE.Vector3();
const _axisYB = new THREE.Vector3();
const _axisZB = new THREE.Vector3();

function collectNamedNodes(
  root: THREE.Object3D,
): { map: Map<string, THREE.Object3D>; duplicates: string[] } {
  const map = new Map<string, THREE.Object3D>();
  const duplicates: string[] = [];
  root.traverse((obj) => {
    if (!obj.name) return;
    if (map.has(obj.name)) {
      duplicates.push(obj.name);
    } else {
      map.set(obj.name, obj);
    }
  });
  return { map, duplicates };
}

/**
 * Validates a single operator rig root against OPERATOR_RIG_CONTRACT:
 *  - Node completeness across primary, secondary (`sec_*`), sockets/IK poles, and hit zones (`hz_*`)
 *  - Node name uniqueness
 *  - Exact parent-child chains
 *  - Uniform scale `1.0 ± 0.001`
 *  - `socket_bodycam_mount` forward clearance past front plate carrier
 *  - `sec_chest_*` rest clearance (`>= 18 mm`) behind front SAPI plate
 */
export function validateOperatorRig(
  root: THREE.Object3D,
  operatorId: OperatorId,
  mode: RigValidationMode = 'SAFE_FALLBACK',
): RigValidationReport {
  const issues: RigValidationIssue[] = [];
  root.updateMatrixWorld(true);

  const { map, duplicates } = collectNamedNodes(root);

  for (const dup of duplicates) {
    if ((ALL_REQUIRED_NODES as readonly string[]).includes(dup)) {
      issues.push({
        code: 'DUPLICATE_NODE',
        nodeName: dup,
        message: `Canonical rig node "${dup}" appears more than once in hierarchy.`,
      });
    }
  }

  for (const name of ALL_REQUIRED_NODES) {
    const node = map.get(name);
    if (!node) {
      issues.push({
        code: 'MISSING_NODE',
        nodeName: name,
        message: `Required canonical rig node "${name}" is missing.`,
      });
      continue;
    }

    // Verify exact parent-child chain
    if (name !== 'root') {
      const expectedParent = CANONICAL_RIG_PARENT_MAP[name];
      const actualParent = node.parent?.name ?? '<none>';
      if (actualParent !== expectedParent) {
        issues.push({
          code: 'INVALID_PARENT',
          nodeName: name,
          message: `Expected parent "${expectedParent}", got "${actualParent}".`,
        });
      }
    }

    // Verify uniform unit scale tolerance (1.0 ± 0.001)
    node.getWorldScale(_worldScale);
    const tol = OPERATOR_RIG_CONTRACT.scaleTolerance;
    if (
      Math.abs(_worldScale.x - 1) > tol ||
      Math.abs(_worldScale.y - 1) > tol ||
      Math.abs(_worldScale.z - 1) > tol
    ) {
      issues.push({
        code: 'NON_UNIT_SCALE',
        nodeName: name,
        message: `Expected uniform scale 1.0 ± ${tol}, got (${_worldScale.x.toFixed(4)}, ${_worldScale.y.toFixed(4)}, ${_worldScale.z.toFixed(4)}).`,
      });
    }
  }

  // Verify socket_bodycam_mount clears front plate exterior along -Z (forward in CORDON-04 rig space)
  const spine03 = map.get('spine_03');
  const camMount = map.get('socket_bodycam_mount');
  const frontPlate = map.get('gear_front_plate');
  if (spine03 && camMount) {
    // In CORDON-04 coordinates, -Z is forward out of the operator's chest.
    const camZ = camMount.position.z;
    const plateExteriorZ =
      frontPlate && typeof frontPlate.userData?.exteriorForwardZ === 'number'
        ? (frontPlate.userData.exteriorForwardZ as number)
        : -0.105;
    // camZ must be further forward (more negative) than the plate carrier exterior
    if (camZ > plateExteriorZ - OPERATOR_RIG_CONTRACT.bodycamMountMinForwardClearanceM + 1e-5) {
      issues.push({
        code: 'BODYCAM_CLEARANCE',
        nodeName: 'socket_bodycam_mount',
        message: `socket_bodycam_mount Z (${camZ.toFixed(4)}m) does not clear front plate exterior Z (${plateExteriorZ.toFixed(4)}m) by >= ${OPERATOR_RIG_CONTRACT.bodycamMountMinForwardClearanceM * 1000}mm.`,
      });
    }

    // Verify sec_chest_l / sec_chest_r rest clearance (>= 18 mm behind front plate interior)
    const plateInteriorZ =
      frontPlate && typeof frontPlate.userData?.interiorForwardZ === 'number'
        ? (frontPlate.userData.interiorForwardZ as number)
        : -0.076;
    for (const secName of ['sec_chest_l', 'sec_chest_r'] as const) {
      const secNode = map.get(secName);
      if (!secNode) continue;
      const clearanceM = secNode.position.z - plateInteriorZ;
      if (clearanceM < OPERATOR_RIG_CONTRACT.minChestGearClearanceM - 1e-5) {
        issues.push({
          code: 'CHEST_GEAR_CLEARANCE',
          nodeName: secName,
          message: `Rest clearance ${(clearanceM * 1000).toFixed(1)}mm behind front plate interior is below ${OPERATOR_RIG_CONTRACT.minChestGearClearanceM * 1000}mm.`,
        });
      }
    }
  }

  const report: RigValidationReport = {
    valid: issues.length === 0,
    operatorId,
    issues,
    nodeCount: map.size,
    checkedAtMs: Date.now(),
  };

  if (!report.valid && mode === 'STRICT') {
    throw new RigContractViolationError(report);
  }

  return report;
}

/**
 * Verifies cross-operator rest-axis parity (`dot > 0.999`) across all canonical primary bones,
 * sockets, and IK poles between two rigs (e.g. `MALE` vs `FEMALE`).
 */
export function validateCrossOperatorParity(
  rigA: THREE.Object3D,
  rigB: THREE.Object3D,
  mode: RigValidationMode = 'STRICT',
): RigValidationReport {
  rigA.updateMatrixWorld(true);
  rigB.updateMatrixWorld(true);
  const { map: mapA } = collectNamedNodes(rigA);
  const { map: mapB } = collectNamedNodes(rigB);
  const issues: RigValidationIssue[] = [];

  const parityNodes: readonly string[] = [...PRIMARY_BONE_NAMES, ...SOCKET_AND_POLE_NAMES];
  const minDot = OPERATOR_RIG_CONTRACT.restAxisDotMin;

  for (const name of parityNodes) {
    const a = mapA.get(name);
    const b = mapB.get(name);
    if (!a || !b) {
      issues.push({
        code: 'MISSING_NODE',
        nodeName: name,
        message: `Node "${name}" missing in ${!a ? 'rigA' : 'rigB'} during parity check.`,
      });
      continue;
    }

    a.getWorldQuaternion(_quatA);
    b.getWorldQuaternion(_quatB);

    _axisXA.set(1, 0, 0).applyQuaternion(_quatA);
    _axisYA.set(0, 1, 0).applyQuaternion(_quatA);
    _axisZA.set(0, 0, 1).applyQuaternion(_quatA);

    _axisXB.set(1, 0, 0).applyQuaternion(_quatB);
    _axisYB.set(0, 1, 0).applyQuaternion(_quatB);
    _axisZB.set(0, 0, 1).applyQuaternion(_quatB);

    const dotX = _axisXA.dot(_axisXB);
    const dotY = _axisYA.dot(_axisYB);
    const dotZ = _axisZA.dot(_axisZB);

    if (dotX < minDot || dotY < minDot || dotZ < minDot) {
      issues.push({
        code: 'REST_AXIS_PARITY',
        nodeName: name,
        message: `Rest-axis dot products (${dotX.toFixed(5)}, ${dotY.toFixed(5)}, ${dotZ.toFixed(5)}) below ${minDot}.`,
      });
    }
  }

  // Also ensure root origin parity (< 1mm)
  const rootA = mapA.get('root');
  const rootB = mapB.get('root');
  if (rootA && rootB) {
    rootA.getWorldPosition(_nodeWorldA);
    rootB.getWorldPosition(_nodeWorldB);
    const dist = _nodeWorldA.distanceTo(_nodeWorldB);
    if (dist > 0.001) {
      issues.push({
        code: 'REST_AXIS_PARITY',
        nodeName: 'root',
        message: `Root origin mismatch: ${(dist * 1000).toFixed(2)}mm.`,
      });
    }
  }

  const report: RigValidationReport = {
    valid: issues.length === 0,
    operatorId: 'FEMALE',
    issues,
    nodeCount: parityNodes.length,
    checkedAtMs: Date.now(),
  };

  if (!report.valid && mode === 'STRICT') {
    throw new RigContractViolationError(report);
  }

  return report;
}
