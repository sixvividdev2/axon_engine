import * as THREE from 'three';
import {
  getTacticalEquipmentDef,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../../data/tacticalEquipment';

export interface BuiltTacticalEquipmentMesh {
  group: THREE.Group;
  bodyGroup: THREE.Group;
  spoonAnchor: THREE.Object3D;
  spoonGroup: THREE.Group;
  pullRingMesh: THREE.Mesh;
  pinAnchor: THREE.Object3D;
  pinPullAxis: THREE.Vector3;
  gripOffset: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
  };
  dispose: () => void;
}

export interface BeltMountTransform {
  position: [number, number, number];
  rotation: [number, number, number];
}

/**
 * Computes exact local attachment transform(s) on `CharacterSkeleton.pelvis` /
 * `TacticalOperatorRig.pelvisGroup` (where character faces -Z, belt sits at y = 0.052,
 * buckle is at (0, 0.052, -0.105), dumpPouch at (-0.165, -0.02, 0.01),
 * and holster at (+0.165, -0.04, -0.005)).
 */
export function getBeltSlotTransforms(
  slot: TacticalBeltSlot,
  pelvisWidthScale = 1.0,
  pelvisDepthScale = 1.0,
): BeltMountTransform[] {
  const w = pelvisWidthScale;
  const d = pelvisDepthScale;

  switch (slot) {
    case 'front_left':
      return [
        {
          position: [-0.098 * w, 0.024, -0.114 * d],
          rotation: [0.16, 0.34, 0.1],
        },
        {
          position: [-0.158 * w, 0.02, -0.088 * d],
          rotation: [0.12, 0.68, 0.14],
        },
      ];
    case 'left_hip':
      return [
        {
          position: [-0.168 * w, 0.026, -0.064 * d],
          rotation: [0.06, 1.15, 0.12],
        },
        {
          position: [-0.162 * w, 0.022, 0.068 * d],
          rotation: [-0.08, 1.95, 0.1],
        },
      ];
    case 'right_hip':
      return [
        {
          position: [0.104 * w, 0.024, -0.112 * d],
          rotation: [0.14, -0.36, -0.1],
        },
        {
          position: [0.162 * w, 0.024, -0.072 * d],
          rotation: [0.08, -0.98, -0.12],
        },
      ];
    case 'rear_belt':
      return [
        {
          position: [-0.068 * w, 0.032, 0.116 * d],
          rotation: [-0.14, Math.PI + 0.18, 0.08],
        },
        {
          position: [0.068 * w, 0.032, 0.116 * d],
          rotation: [-0.14, Math.PI - 0.18, -0.08],
        },
      ];
  }
}

/**
 * Builds a realistic, multi-part PBR 3D mesh for a tactical grenade or utility canister.
 * Used identically for the operator's belt mesh AND thrown 3D projectiles in flight.
 */
export function buildTacticalEquipmentMesh(
  equipmentId: TacticalEquipmentId,
  options?: { withBeltClip?: boolean; scale?: number; renderLayer?: number },
): BuiltTacticalEquipmentMesh {
  const def = getTacticalEquipmentDef(equipmentId);
  const group = new THREE.Group();
  group.name = `tactical_item_${def.id}`;
  const bodyGroup = new THREE.Group();
  bodyGroup.name = `tactical_body_${def.id}`;
  group.add(bodyGroup);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m);
    return m;
  };

  const bodyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: def.bodyHex,
      roughness: 0.62,
      metalness: 0.28,
    }),
  );
  const bandMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: def.bandHex,
      roughness: 0.48,
      metalness: 0.16,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );
  const steelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3b4046,
      roughness: 0.42,
      metalness: 0.78,
    }),
  );
  const brassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc8a956,
      roughness: 0.34,
      metalness: 0.84,
    }),
  );
  const corduraMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x252822,
      roughness: 0.9,
      metalness: 0.05,
    }),
  );

  let fuzeY = 0.042;
  let spoonOffsetX = 0.028;

  if (def.id === 'm67_frag') {
    // M67 spherical-ovoid olive fragmentation body
    const sphere = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.036, 14, 12)), bodyMat);
    sphere.scale.set(1, 1.07, 1);
    bodyGroup.add(sphere);

    // Subtle yellow HE identification stripe around upper shoulder
    const band = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0328, 0.0358, 0.011, 14, 1, true)),
      bandMat,
    );
    band.position.y = 0.015;
    bodyGroup.add(band);

    // Threaded steel collar
    const collar = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.013, 0.016, 0.015, 10)),
      steelMat,
    );
    collar.position.y = 0.041;
    bodyGroup.add(collar);
    fuzeY = 0.052;
    spoonOffsetX = 0.029;
  } else if (def.id === 'm84_flash') {
    // M84 hexagonal metallic stun body with twin end caps & vent ports
    const body = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.025, 0.025, 0.105, 6)),
      bodyMat,
    );
    bodyGroup.add(body);

    const topCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.027, 0.027, 0.014, 10)),
      steelMat,
    );
    topCap.position.y = 0.054;
    const botCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.027, 0.027, 0.014, 10)),
      steelMat,
    );
    botCap.position.y = -0.054;
    bodyGroup.add(topCap, botCap);

    // Bright tactical stun stripe
    const band = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0262, 0.0262, 0.016, 6)),
      bandMat,
    );
    band.position.y = 0.022;
    bodyGroup.add(band);

    // Recessed flash vent ring
    const ventMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x0e1114,
        roughness: 0.85,
        metalness: 0.4,
      }),
    );
    for (const vy of [-0.018, 0.0]) {
      const vent = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.0256, 0.0256, 0.008, 6)),
        ventMat,
      );
      vent.position.y = vy;
      bodyGroup.add(vent);
    }

    fuzeY = 0.068;
    spoonOffsetX = 0.028;
  } else if (def.id === 'm18_smoke') {
    // M18 tall cylindrical smoke canister with color smoke band & emitter top
    const canister = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.028, 0.028, 0.118, 14)),
      bodyMat,
    );
    bodyGroup.add(canister);

    const rimTop = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0295, 0.0295, 0.01, 14)),
      steelMat,
    );
    rimTop.position.y = 0.058;
    const rimBot = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0295, 0.0295, 0.009, 14)),
      steelMat,
    );
    rimBot.position.y = -0.058;
    bodyGroup.add(rimTop, rimBot);

    const band = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0288, 0.0288, 0.024, 14)),
      bandMat,
    );
    band.position.y = 0.02;
    bodyGroup.add(band);

    fuzeY = 0.07;
    spoonOffsetX = 0.031;
  } else {
    // AN-M14 heavy thermite incendiary canister with hazard stripes & heat fins
    const canister = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.029, 0.029, 0.116, 12)),
      bodyMat,
    );
    bodyGroup.add(canister);

    const band = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.03, 0.03, 0.022, 12)),
      bandMat,
    );
    band.position.y = 0.018;
    bodyGroup.add(band);

    const lowBand = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 12)),
      bandMat,
    );
    lowBand.position.y = -0.028;
    bodyGroup.add(lowBand);

    const headCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.031, 0.031, 0.014, 12)),
      steelMat,
    );
    headCap.position.y = 0.058;
    bodyGroup.add(headCap);

    fuzeY = 0.072;
    spoonOffsetX = 0.032;
  }

  // Shared top striker head, hinged safety lever spoon group, and brass pull ring
  const fuzeHead = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.024, 0.016, 0.018)),
    steelMat,
  );
  fuzeHead.position.y = fuzeY;
  bodyGroup.add(fuzeHead);

  const spoonHingeX = 0.005;
  const spoonHingeY = fuzeY + 0.007;
  const spoonAnchor = new THREE.Object3D();
  spoonAnchor.name = 'grenade_spoon_anchor';
  spoonAnchor.position.set(spoonHingeX, spoonHingeY, 0);
  bodyGroup.add(spoonAnchor);

  const spoonGroup = new THREE.Group();
  spoonGroup.name = 'grenade_safety_spoon';
  const spoonTop = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.026, 0.005, 0.014)),
    steelMat,
  );
  spoonTop.position.set(spoonOffsetX * 0.45 - spoonHingeX, 0, 0);
  spoonGroup.add(spoonTop);

  const spoonArm = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.005, 0.058, 0.014)),
    steelMat,
  );
  spoonArm.position.set(spoonOffsetX + 0.005 - spoonHingeX, -0.029, 0);
  spoonArm.rotation.z = 0.16;
  spoonGroup.add(spoonArm);
  spoonAnchor.add(spoonGroup);

  const pullRing = new THREE.Mesh(
    trackGeo(new THREE.TorusGeometry(0.013, 0.0022, 6, 12)),
    brassMat,
  );
  pullRing.name = 'grenade_pull_ring';
  pullRing.position.set(-0.017, fuzeY - 0.002, 0.008);
  pullRing.rotation.y = 0.42;
  group.add(pullRing);

  const pinAnchor = new THREE.Object3D();
  pinAnchor.name = 'grenade_pin_anchor';
  pinAnchor.position.set(-0.024, fuzeY - 0.001, 0.011);
  bodyGroup.add(pinAnchor);

  const pinPullAxis = new THREE.Vector3(-0.88, 0.32, 0.34).normalize();
  const gripOffset = {
    position: new THREE.Vector3(
      def.id === 'm67_frag' ? 0.002 : 0.0,
      def.id === 'm67_frag' ? -0.004 : -0.008,
      0.002,
    ),
    rotation: new THREE.Euler(-0.68, 0, Math.PI * 0.5),
  };

  // Optional MOLLE tactical belt retention strap & cradle when worn on operator belt
  if (options?.withBeltClip) {
    const clipBack = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.046, 0.078, 0.014)),
      corduraMat,
    );
    clipBack.position.set(0, 0.008, 0.034);
    bodyGroup.add(clipBack);

    const retentionStrap = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.068, 0.02, 0.068)),
      corduraMat,
    );
    retentionStrap.position.set(0, -0.01, 0.004);
    bodyGroup.add(retentionStrap);

    const buckleLatch = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.02, 0.024, 0.012)),
      steelMat,
    );
    buckleLatch.position.set(0, -0.01, -0.033);
    bodyGroup.add(buckleLatch);
  }

  const sc = options?.scale ?? 1.0;
  if (sc !== 1.0) {
    group.scale.setScalar(sc);
  }

  if (typeof options?.renderLayer === 'number') {
    const layer = options.renderLayer;
    group.traverse((obj) => {
      obj.layers.set(layer);
    });
  }

  return {
    group,
    bodyGroup,
    spoonAnchor,
    spoonGroup,
    pullRingMesh: pullRing,
    pinAnchor,
    pinPullAxis,
    gripOffset,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
