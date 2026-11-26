import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildAnatomicalHeadAssembly,
  FACIAL_MORPH_COUNT,
  FACIAL_MORPH_INDEX,
  getSharedAnatomicalHeadGeometry,
  getSharedBrowStripsGeometry,
  getSharedHairCapGeometry,
  getSharedSkinPoreNormalTexture,
  getSkinTonePalette,
  resolveZombieHairStyleFromSeed,
} from '../character/AnatomicalHeadBuilder';
import {
  DEFAULT_FACE_PRESET_ID,
  FACE_PRESET_IDS,
  FEMALE_FACE_PRESETS,
  getFacePresetsForOperator,
  MALE_FACE_PRESETS,
  normalizeOperatorGearConfig,
} from '../operator/OperatorTypes';
import { TacticalOperatorRigFactory } from '../../combat/TacticalOperatorRig';
import { InfectedZombieRigLibrary } from '../../combat/InfectedZombieRig';
import { CharacterRoster } from '../../src/modes/openworld/CharacterRoster';

function installMockCanvas(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const noop = () => {};
  const grad = { addColorStop: noop };
  const makeCtx = () => ({
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    fillRect: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    clip: noop,
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop,
  });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 256,
          height: 256,
          getContext: () => makeCtx(),
        };
      }
      return {};
    },
  };
}

describe('Anatomical Cube-Sphere Head Overhaul & Multi-Face Roster', () => {
  beforeAll(() => {
    installMockCanvas();
  });

  it('builds seamless 24x24 cube-sphere head geometry with 15 valid morph targets and helmet clearance', () => {
    for (const variant of ['male', 'female', 'zombie'] as const) {
      const presets = variant === 'zombie' ? [DEFAULT_FACE_PRESET_ID] : FACE_PRESET_IDS;
      for (const preset of presets) {
        const geo = getSharedAnatomicalHeadGeometry(variant, preset);
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        const idx = geo.getIndex();

        expect(pos.count).toBeGreaterThan(3000);
        expect(idx).not.toBeNull();
        expect(geo.morphAttributes.position.length).toBe(FACIAL_MORPH_COUNT);

        // Verify zero NaNs across positions, welded normals, and UVs
        for (let i = 0; i < pos.count; i++) {
          expect(Number.isFinite(pos.getX(i))).toBe(true);
          expect(Number.isFinite(pos.getY(i))).toBe(true);
          expect(Number.isFinite(pos.getZ(i))).toBe(true);
          const nLen = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
          expect(nLen).toBeGreaterThan(0.95);
          expect(nLen).toBeLessThan(1.05);
          expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getX(i)).toBeLessThanOrEqual(1);
        }

        // Verify occipital cranium expansion stays cleanly inside MICH / Mil-Tec helmet bounds
        geo.computeBoundingBox();
        const box = geo.boundingBox!;
        expect(box.max.y).toBeLessThanOrEqual(0.212);
        expect(box.max.z).toBeGreaterThan(0.095); // Full rear occipital lobe curves out behind neck
        expect(box.max.z).toBeLessThanOrEqual(0.114); // Strictly clears helmet rear shell
        expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThanOrEqual(0.092);

        // Verify jaw_open & brow_furrow_down morphs have real non-zero displacement
        const jawAttr = geo.morphAttributes.position[FACIAL_MORPH_INDEX.jaw_open];
        const browAttr = geo.morphAttributes.position[FACIAL_MORPH_INDEX.brow_furrow_down];
        let maxJawDelta = 0;
        let maxBrowDelta = 0;
        for (let i = 0; i < pos.count; i++) {
          maxJawDelta = Math.max(maxJawDelta, Math.abs(jawAttr.getY(i) - pos.getY(i)));
          maxBrowDelta = Math.max(maxBrowDelta, Math.abs(browAttr.getY(i) - pos.getY(i)));
        }
        expect(maxJawDelta).toBeGreaterThan(0.008);
        expect(maxBrowDelta).toBeGreaterThan(0.003);
      }
    }
  });

  it('generates separate offset hair cap shells, 3D deforming brow strips, shared pore normal map & wet clearcoat eyes', () => {
    const hoodMat = new THREE.MeshStandardMaterial({ color: 0x22262b });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x15171a });
    const poreA = getSharedSkinPoreNormalTexture();
    const poreB = getSharedSkinPoreNormalTexture();
    expect(poreA).toBe(poreB); // Single cached global pore normal texture

    const assembly = buildAnatomicalHeadAssembly({
      variant: 'male',
      toneSeed: 1,
      facePreset: 'face_01',
      hoodMaterial: hoodMat,
      frameMaterial: frameMat,
      includeGearAndEyewear: true,
    });

    // Separate hair cap mesh with matte roughness & directional normal map
    expect(assembly.hairCapMesh).toBeDefined();
    expect(assembly.hairCapMesh.visible).toBe(true);
    const hairMat = assembly.hairCapMesh.material as THREE.MeshStandardMaterial;
    expect(hairMat.roughness).toBeGreaterThanOrEqual(0.85);
    expect(hairMat.normalMap).not.toBeNull();

    // Raised 3D brow strips share the exact morphTargetInfluences array reference with headMesh
    expect(assembly.browMesh).toBeDefined();
    expect(assembly.browMesh.morphTargetInfluences).toBe(assembly.headMesh.morphTargetInfluences);
    expect(assembly.browMesh.geometry.morphAttributes.position.length).toBe(FACIAL_MORPH_COUNT);
    expect(getSharedBrowStripsGeometry('male', 'face_01').getAttribute('position').count).toBeGreaterThan(40);

    // Skin material uses zoned roughnessMap + global pore normalMap at normalScale (0.15, 0.15)
    const skinMat = assembly.headMesh.material as THREE.MeshStandardMaterial;
    expect(skinMat.roughnessMap).not.toBeNull();
    expect(skinMat.normalMap).toBe(poreA);
    expect(skinMat.normalScale.x).toBeCloseTo(0.15, 3);
    expect(skinMat.normalScale.y).toBeCloseTo(0.15, 3);

    // Eyeballs sit recessed behind supraorbital brow and use MeshPhysicalMaterial with wet clearcoat
    const eyeMat = assembly.eyeBallL.material as THREE.MeshPhysicalMaterial;
    expect(eyeMat.isMeshPhysicalMaterial).toBe(true);
    expect(eyeMat.roughness).toBeCloseTo(0.05, 3);
    expect(eyeMat.clearcoat).toBeCloseTo(1.0, 3);
    expect(assembly.eyeL.position.z).toBeGreaterThan(-0.073); // Recessed inside orbital cavity

    // Headgear clearance hides hair cap under balaclava & compresses slightly under helmets
    assembly.applyHeadgearClearance('mil_tec', 'open_face');
    expect(assembly.hairCapMesh.visible).toBe(true);
    expect(assembly.hairCapMesh.scale.y).toBeLessThan(1.0);

    assembly.applyHeadgearClearance('none', 'balaclava');
    expect(assembly.hairCapMesh.visible).toBe(false);

    assembly.applyHeadgearClearance('none', 'open_face');
    expect(assembly.hairCapMesh.visible).toBe(true);
    expect(assembly.hairCapMesh.scale.y).toBe(1.0);
  });

  it('defines 3 distinct sculpted + textured face presets per gender and supports hot-swapping', () => {
    expect(MALE_FACE_PRESETS.length).toBe(3);
    expect(FEMALE_FACE_PRESETS.length).toBe(3);
    expect(getFacePresetsForOperator('MALE').length).toBe(3);
    expect(getFacePresetsForOperator('FEMALE').length).toBe(3);

    for (const variant of ['male', 'female'] as const) {
      const geos = FACE_PRESET_IDS.map((id) => getSharedAnatomicalHeadGeometry(variant, id));
      const hairGeos = FACE_PRESET_IDS.map((id) => getSharedHairCapGeometry(variant, id));
      const palettes = FACE_PRESET_IDS.map((id) => getSkinTonePalette(0, variant, id));

      // All 3 geometries & palettes are distinct
      expect(new Set(geos).size).toBe(3);
      expect(new Set(hairGeos).size).toBe(3);
      expect(new Set(palettes.map((p) => p.baseHex)).size).toBe(3);
      expect(new Set(palettes.map((p) => p.irisHex)).size).toBe(3);
      expect(new Set(palettes.map((p) => p.hairHex)).size).toBe(3);
    }

    // Hot-swap updates geometry + textures while preserving morphTargetInfluences reference
    const hoodMat = new THREE.MeshStandardMaterial();
    const frameMat = new THREE.MeshStandardMaterial();
    const femaleHead = buildAnatomicalHeadAssembly({
      variant: 'female',
      toneSeed: 0,
      facePreset: 'face_01',
      hoodMaterial: hoodMat,
      frameMaterial: frameMat,
    });
    const refInfluences = femaleHead.morphTargetInfluences;
    const initialGeo = femaleHead.headMesh.geometry;

    femaleHead.applyFacePreset('face_03');
    expect(femaleHead.getFacePreset()).toBe('face_03');
    expect(femaleHead.headMesh.geometry).not.toBe(initialGeo);
    expect(femaleHead.headMesh.morphTargetInfluences).toBe(refInfluences);
    expect(femaleHead.browMesh.morphTargetInfluences).toBe(refInfluences);
    expect(femaleHead.femaleBunMesh).not.toBeNull();
  });

  it('normalizes facePreset in OperatorGearConfig and persists chosen face on Open World characters', () => {
    const legacy = normalizeOperatorGearConfig({ helmetType: 'none', faceGear: 'open_face' });
    expect(legacy.facePreset).toBe('face_01');

    const explicit = normalizeOperatorGearConfig({ facePreset: 'face_03' });
    expect(explicit.facePreset).toBe('face_03');

    const invalid = normalizeOperatorGearConfig({ facePreset: 'unknown_face' });
    expect(invalid.facePreset).toBe('face_01');

    const roster = new CharacterRoster();
    const created = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'SPECTRE-01',
      shardMode: 'PvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'female',
      facePreset: 'face_02',
      activate: true,
    });
    expect(created.ok).toBe(true);
    expect(created.character?.operatorGear.facePreset).toBe('face_02');
  });

  it('varies AI operator faces across all 3 presets per gender and mixes tattered-hair and bald infected zombies', () => {
    const rigFactory = new TacticalOperatorRigFactory();
    const malePresets = new Set<string>();
    const femalePresets = new Set<string>();

    for (let i = 0; i < 9; i++) {
      const mRig = rigFactory.buildOperator('bot', `ai_m_${i}`, 'team_a', 'MALE');
      malePresets.add(mRig.headAssembly.getFacePreset());
      const fRig = rigFactory.buildOperator('bot', `ai_f_${i}`, 'team_b', 'FEMALE');
      femalePresets.add(fRig.headAssembly.getFacePreset());
    }
    expect(malePresets.size).toBe(3);
    expect(femalePresets.size).toBe(3);
    rigFactory.dispose();

    // Zombies produce a genuine mix of tattered hair caps and bald necrotic skulls
    const zombieLib = new InfectedZombieRigLibrary();
    let tatteredCount = 0;
    let baldCount = 0;
    for (let i = 0; i < 24; i++) {
      const z = zombieLib.buildZombie(`zombie_actor_${i}`);
      if (z.headAssembly.zombieHairStyle === 'tattered') {
        tatteredCount++;
        expect(z.headAssembly.hairCapMesh.visible).toBe(true);
      } else {
        baldCount++;
        expect(z.headAssembly.hairCapMesh.visible).toBe(false);
      }
    }
    expect(tatteredCount).toBeGreaterThan(4);
    expect(baldCount).toBeGreaterThan(4);
    expect(getSharedHairCapGeometry('zombie', 'face_01', 'bald')).toBeNull();
    expect(getSharedHairCapGeometry('zombie', 'face_01', 'tattered')).not.toBeNull();
    expect(['tattered', 'bald']).toContain(resolveZombieHairStyleFromSeed(42));
    zombieLib.dispose();
  });

  it('keeps female operators free of facial-hair artifacts (zero stubble, lowered neck gaiter, shorter sideburns)', () => {
    const hoodMat = new THREE.MeshStandardMaterial({ color: 0x22262b });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x15171a });

    for (const preset of FACE_PRESET_IDS) {
      const palette = getSkinTonePalette(0, 'female', preset);
      expect(palette.stubbleAlpha).toBe(0);

      const femaleHead = buildAnatomicalHeadAssembly({
        variant: 'female',
        toneSeed: 0,
        facePreset: preset,
        hoodMaterial: hoodMat,
        frameMaterial: frameMat,
        includeGearAndEyewear: true,
      });

      const cuff = femaleHead.faceGearGroups.neckGaiter.getObjectByName('neck_gaiter_cuff') as THREE.Mesh;
      expect(cuff).toBeDefined();
      // Neck gaiter upper cuff sits neatly around the neck below the chin rather than riding up to the lower lip
      expect(cuff.position.y).toBeLessThanOrEqual(0.025);
      expect(cuff.position.z).toBeGreaterThanOrEqual(0);
    }

    // Female hair cap sideburn zone stays noticeably higher than male short crop sideburns
    const minSideburnY = (variant: 'male' | 'female', preset: (typeof FACE_PRESET_IDS)[number]): number => {
      const geo = getSharedHairCapGeometry(variant, preset)!;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      let minY = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const az = Math.atan2(Math.abs(x), -z);
        if (az >= 1.05 && az <= 1.32) {
          minY = Math.min(minY, y);
        }
      }
      return minY;
    };

    const maleSideburnMinY = minSideburnY('male', 'face_02');
    for (const preset of FACE_PRESET_IDS) {
      expect(minSideburnY('female', preset)).toBeGreaterThan(maleSideburnMinY);
    }
  });
});

