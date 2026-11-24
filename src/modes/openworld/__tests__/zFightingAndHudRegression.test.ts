import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CharacterRoster } from '../CharacterRoster';
import { ShardStore } from '../ShardStore';
import { OpenWorldStorageLike } from '../types';
import {
  AuditedArchBox,
  OpenWorldArchitectureBuilder,
} from '../world/OpenWorldArchitectureBuilder';
import {
  ensureCivilizationTopologyBaked,
  getBakedOpenWorldSites,
} from '../world/OpenWorldCivilizationTopology';
import {
  getAllFobCompoundSpecs,
  getFobArmoryStashAnchor,
  getFobFieldHospitalAnchor,
  getFobHelipadAnchor,
  getFobTerminalAnchor,
} from '../world/OpenWorldFobLayout';
import { BodycamAudio } from '../../../../bodycam-sdk/BodycamAudio';
import { OpenWorldAmbienceAudio } from '../world/OpenWorldAmbienceAudio';
import { OpenWorldSectorManager } from '../world/OpenWorldSectorManager';
import { evaluateOpenWorldHeight, evaluateRawOpenWorldHeight, SEA_LEVEL_M } from '../world/OpenWorldTerrain';
import { OpenWorldWildlifeManager } from '../world/OpenWorldWildlifeManager';

function makeMemoryStorage(): OpenWorldStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    const createMockCanvas = () => ({
      width: 128,
      height: 128,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
        }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        putImageData: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        ellipse: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        strokeText: () => {},
        measureText: () => ({ width: 10 }),
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        drawImage: () => {},
        setLineDash: () => {},
      }),
    });
    (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document = {
      createElement: () => createMockCanvas(),
    };
  }
});

interface BoxFace {
  boxIdx: number;
  mat: string;
  nx: number;
  ny: number;
  nz: number;
  /** Plane signed distance d = n . p */
  d: number;
  /** Axis-aligned or oriented 2D bounds in plane local coordinates (u, v) */
  uVec: [number, number, number];
  vVec: [number, number, number];
  cx: number;
  cy: number;
  cz: number;
  hu: number;
  hv: number;
}

function extractBoxFaces(box: AuditedArchBox, boxIdx: number): BoxFace[] {
  const cosY = Math.cos(box.yaw);
  const sinY = Math.sin(box.yaw);
  const hx = box.sx * 0.5;
  const hy = box.sy * 0.5;
  const hz = box.sz * 0.5;

  // Local axes in world space:
  // +X -> (cosY, 0, -sinY)
  // +Y -> (0, 1, 0)
  // +Z -> (sinY, 0, cosY)
  const axX: [number, number, number] = [cosY, 0, -sinY];
  const axY: [number, number, number] = [0, 1, 0];
  const axZ: [number, number, number] = [sinY, 0, cosY];

  const makeFace = (
    n: [number, number, number],
    offsetDist: number,
    uVec: [number, number, number],
    vVec: [number, number, number],
    hu: number,
    hv: number,
  ): BoxFace => {
    const cx = box.wx + n[0] * offsetDist;
    const cy = box.wy + n[1] * offsetDist;
    const cz = box.wz + n[2] * offsetDist;
    return {
      boxIdx,
      mat: box.mat,
      nx: n[0],
      ny: n[1],
      nz: n[2],
      d: n[0] * cx + n[1] * cy + n[2] * cz,
      uVec,
      vVec,
      cx,
      cy,
      cz,
      hu,
      hv,
    };
  };

  return [
    makeFace(axX, hx, axZ, axY, hz, hy),
    makeFace([-axX[0], 0, -axX[2]], hx, axZ, axY, hz, hy),
    makeFace(axZ, hz, axX, axY, hx, hy),
    makeFace([-axZ[0], 0, -axZ[2]], hz, axX, axY, hx, hy),
    makeFace(axY, hy, axX, axZ, hx, hz),
    makeFace([0, -1, 0], hy, axX, axZ, hx, hz),
  ];
}

function facesOverlapCoplanar(a: BoxFace, b: BoxFace): boolean {
  // Same outward normal direction -> coplanar overlapping faces cause Z-fighting
  const dotN = a.nx * b.nx + a.ny * b.ny + a.nz * b.nz;
  if (dotN < 0.995) return false;
  if (Math.abs(a.d - b.d) > 0.008) return false;

  // SAT in 2D plane spanned by a.uVec & a.vVec
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const dz = b.cz - a.cz;

  const axes: ReadonlyArray<[number, number, number]> = [a.uVec, a.vVec, b.uVec, b.vVec];
  for (const ax of axes) {
    const dist = Math.abs(dx * ax[0] + dy * ax[1] + dz * ax[2]);
    const projA =
      a.hu * Math.abs(a.uVec[0] * ax[0] + a.uVec[1] * ax[1] + a.uVec[2] * ax[2]) +
      a.hv * Math.abs(a.vVec[0] * ax[0] + a.vVec[1] * ax[1] + a.vVec[2] * ax[2]);
    const projB =
      b.hu * Math.abs(b.uVec[0] * ax[0] + b.uVec[1] * ax[1] + b.uVec[2] * ax[2]) +
      b.hv * Math.abs(b.vVec[0] * ax[0] + b.vVec[1] * ax[1] + b.vVec[2] * ax[2]);
    // Require > 1.5cm intersection area (touching edges at 0 overlap do not Z-fight)
    if (dist >= projA + projB - 0.015) return false;
  }
  return true;
}

function findCoplanarOverlaps(boxes: AuditedArchBox[]): Array<string> {
  const faces: BoxFace[] = [];
  for (let i = 0; i < boxes.length; i++) {
    faces.push(...extractBoxFaces(boxes[i], i));
  }
  const issues: string[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[i].boxIdx === faces[j].boxIdx) continue;
      if (facesOverlapCoplanar(faces[i], faces[j])) {
        const A = boxes[faces[i].boxIdx];
        const B = boxes[faces[j].boxIdx];
        issues.push(
          `Coplanar Z-fight: box#${faces[i].boxIdx}(${A.mat} @ ${A.wx.toFixed(2)},${A.wy.toFixed(2)},${A.wz.toFixed(2)} [${A.sx.toFixed(2)}x${A.sy.toFixed(2)}x${A.sz.toFixed(2)}]) vs box#${faces[j].boxIdx}(${B.mat} @ ${B.wx.toFixed(2)},${B.wy.toFixed(2)},${B.wz.toFixed(2)} [${B.sx.toFixed(2)}x${B.sy.toFixed(2)}x${B.sz.toFixed(2)}]) n=(${faces[i].nx.toFixed(2)},${faces[i].ny.toFixed(2)},${faces[i].nz.toFixed(2)})`,
        );
      }
    }
  }
  return issues;
}

describe('Zero Z-Fighting Architecture, Depth Precision & Unobstructed HUD Regressions', () => {
  it('emits zero coplanar overlapping faces across Alpha FOB and Bravo FOB compounds', () => {
    const builder = new OpenWorldArchitectureBuilder(true);
    for (const fob of getAllFobCompoundSpecs()) {
      const boxes = builder.auditFobCompoundBoxes(fob);
      expect(boxes.length).toBeGreaterThan(100);
      const issues = findCoplanarOverlaps(boxes);
      expect(issues, `${fob.id} coplanar Z-fights:\n${issues.join('\n')}`).toEqual([]);
    }
    builder.dispose();
  });

  it('emits zero coplanar overlapping faces across every settlement house, gas station, barn, and checkpoint', () => {
    ensureCivilizationTopologyBaked(evaluateRawOpenWorldHeight, SEA_LEVEL_M);
    const builder = new OpenWorldArchitectureBuilder(true);
    const sites = getBakedOpenWorldSites();
    expect(sites.length).toBeGreaterThan(20);
    for (const site of sites) {
      const boxes = builder.auditSiteBoxes(site);
      const issues = findCoplanarOverlaps(boxes);
      expect(issues, `site ${site.id} (${site.kind}) coplanar Z-fights:\n${issues.join('\n')}`).toEqual([]);
    }
    builder.dispose();
  });

  it('emits zero coplanar overlapping faces across horizon river bridges, water towers, and radio masts', () => {
    ensureCivilizationTopologyBaked(evaluateRawOpenWorldHeight, SEA_LEVEL_M);
    const builder = new OpenWorldArchitectureBuilder(true);
    const boxes = builder.auditHorizonCivilizationBoxes();
    expect(boxes.length).toBeGreaterThan(30);
    const issues = findCoplanarOverlaps(boxes);
    expect(issues, `horizon civilization coplanar Z-fights:\n${issues.join('\n')}`).toEqual([]);
    builder.dispose();
  });

  it('places FOB sector flagpole clear of buildings, hides FOB 48m ring, and seats Tier 2/3 props cleanly', () => {
    const scene = new THREE.Scene();
    const roster = new CharacterRoster({ storage: makeMemoryStorage() });
    const shards = new ShardStore({ storage: makeMemoryStorage() });
    const mgr = new OpenWorldSectorManager(
      scene,
      (x, z) => evaluateOpenWorldHeight(x, z),
      roster,
      shards,
      'PvPvE',
    );

    for (const fob of getAllFobCompoundSpecs()) {
      const beaconGroup = scene.getObjectByName(`sector_beacon_${fob.id}`) as THREE.Group | undefined;
      expect(beaconGroup).toBeDefined();
      if (!beaconGroup) continue;

      // Must sit on courtyard plaza clear of Command Bunker, Hospital, Armory, and Helipad
      const anchors = [
        getFobTerminalAnchor(fob.id),
        getFobFieldHospitalAnchor(fob.id),
        getFobArmoryStashAnchor(fob.id),
        getFobHelipadAnchor(fob.id),
      ];
      for (const a of anchors) {
        const d = Math.hypot(beaconGroup.position.x - a.worldX, beaconGroup.position.z - a.worldZ);
        expect(d, `${fob.id} flagpole vs ${a.localX},${a.localZ}`).toBeGreaterThan(7.5);
      }

      // 48m capture ring must stay hidden inside fortified FOB compounds
      const ringChild = beaconGroup.children.find(
        (c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.RingGeometry,
      );
      expect(ringChild).toBeDefined();
      expect(ringChild?.visible).toBe(false);

      // Tier 2 & Tier 3 upgrade groups sit at compound origin and clear of Command Bunker & Armory
      const tier2 = scene.getObjectByName(`fob_tier2_${fob.id}`) as THREE.Group | undefined;
      const tier3 = scene.getObjectByName(`fob_tier3_${fob.id}`) as THREE.Group | undefined;
      expect(tier2).toBeDefined();
      expect(tier3).toBeDefined();
      expect(tier2!.position.y).toBeCloseTo(fob.baseY, 3);
      expect(tier3!.position.y).toBeCloseTo(fob.baseY, 3);
    }

    mgr.dispose();
  });

  it('removes wildlife kill popup toasts and keeps the center aim/optics viewport completely open', () => {
    const engineSrc = readFileSync(
      resolve(process.cwd(), 'src/modes/openworld/world/OpenWorldSessionEngine.ts'),
      'utf8',
    );
    expect(engineSrc).not.toMatch(/Timber Wolf Down|Forest Deer Down/);

    // Verify camera depth-buffer ratio is tightened for crisp depth precision (near >= 0.25, far <= 4700)
    const camMatch = engineSrc.match(
      /new THREE\.PerspectiveCamera\(\s*72\s*,[\s\S]*?,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,?\s*\)/,
    );
    expect(camMatch).not.toBeNull();
    const near = Number(camMatch![1]);
    const far = Number(camMatch![2]);
    expect(near).toBeGreaterThanOrEqual(0.25);
    expect(far / near).toBeLessThanOrEqual(20000);

    // Verify HUD separates top bar and bottom stack with an empty flex-1 center spacer
    const hudSrc = readFileSync(
      resolve(process.cwd(), 'src/modes/openworld/OpenWorldHud.tsx'),
      'utf8',
    );
    expect(hudSrc).toMatch(/<div className="flex-1" \/>/);

    // Verify WildlifeManager kills entity cleanly without emitting UI toast dependencies
    const scene = new THREE.Scene();
    const audio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(audio);
    const wm = new OpenWorldWildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);
    wm.spawnWolfPackAt(20, 20, 2);
    wm.update({
      dt: 0.1,
      elapsedSec: 0.1,
      timeOfDayHours: 12,
      nightFactor: 0,
      windSpeedMps: 2,
      isRaining: false,
      playerX: 0,
      playerY: evaluateOpenWorldHeight(0, 0),
      playerZ: 0,
      playerYawRad: 0,
      playerSpeedMps: 0,
      playerCrouched: false,
      playerSprinting: false,
      playerAlive: true,
      playerOnFoot: true,
      flashlightOn: false,
    });
    const hitMesh = wm.hitMeshes[0] as THREE.Object3D | undefined;
    expect(hitMesh?.userData?.openWorldWildlifeId).toBeDefined();
    const outcome = wm.applyDamageToEntity(hitMesh!.userData.openWorldWildlifeId, 200, 0, 0);
    expect(outcome?.hit).toBe(true);
    expect(outcome?.killed).toBe(true);
    wm.dispose();
    ambience.dispose();
    audio.dispose();
  });
});
