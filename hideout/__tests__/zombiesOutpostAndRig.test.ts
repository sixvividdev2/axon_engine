import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { BodycamPhysicsWorld } from '../../bodycam-sdk';
import {
  InfectedArchetypeId,
  InfectedPoseInput,
  InfectedPoseMode,
  InfectedZombieRigLibrary,
} from '../../combat/InfectedZombieRig';
import { HideoutAirlockBay } from '../HideoutAirlockBay';
import { resolveHideoutRoom } from '../HideoutBunkerWorld';
import { createHideoutMaterials } from '../HideoutMaterials';
import { buildZombiesOutpostWorld } from '../ZombiesOutpostWorld';

/**
 * Minimal headless 2D canvas stub so Three.js CanvasTexture procedural PBR materials
 * instantiate cleanly under Node/Vitest without native canvas bindings.
 */
function installHeadlessCanvasStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const noop = () => {};
  const fakeGrad = { addColorStop: noop };
  const fakeCtx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    strokeText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setLineDash: noop,
    clip: noop,
    drawImage: noop,
    measureText: (txt: string) => ({ width: txt.length * 7 }),
    createLinearGradient: () => fakeGrad,
    createRadialGradient: () => fakeGrad,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w,
      height: h,
    }),
    putImageData: noop,
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const canvasEl = {
          width: 256,
          height: 256,
          getContext: () => ({ ...fakeCtx, canvas: canvasEl }),
        };
        return canvasEl;
      }
      return {};
    },
  };
}

describe('Bio-Containment Airlock, 3D Zombies Outpost Lobby & Anatomical Zombie Rig', () => {
  beforeAll(() => {
    installHeadlessCanvasStub();
  });

  describe('Hideout Sector 4 · Bio-Containment Airlock Bay', () => {
    it('resolves Sector 4 coordinates to Bio-Containment Airlock label', () => {
      const room = resolveHideoutRoom(0, 9.5);
      expect(room.id).toBe('zombies_portal');
      expect(room.label).toContain('Bio-Containment Airlock');
    });

    it('builds airlock bay with override switch, chamber trigger, pressurization cycle, and clean dispose', () => {
      const root = new THREE.Group();
      const physics = new BodycamPhysicsWorld();
      const materials = createHideoutMaterials(1);
      const raycastMeshes: THREE.Object3D[] = [];
      const interactableMeshes: THREE.Mesh[] = [];

      const airlock = new HideoutAirlockBay({
        root,
        physics,
        materials,
        raycastMeshes,
        interactableMeshes,
        isSoftwareGl: false,
      });

      // Verify override switch interactable registered
      const overrideMeshes = interactableMeshes.filter(
        (m) => m.userData?.hideoutInteractable?.kind === 'airlock_override',
      );
      expect(overrideMeshes.length).toBeGreaterThanOrEqual(1);

      const switchPos = new THREE.Vector3();
      expect(airlock.getOverrideSwitchWorldPos(switchPos)).toBe(true);
      expect(switchPos.z).toBeGreaterThan(8);

      // Verify walk-in decontamination chamber bounds
      expect(airlock.isInsideAirlockChamber(0, 11.8)).toBe(true);
      expect(airlock.isInsideAirlockChamber(0, 7.2)).toBe(false);
      expect(airlock.isInsideAirlockChamber(3.5, 11.8)).toBe(false);

      // Verify pressurization cycle & animation step without errors
      airlock.triggerPressurizationCycle();
      for (let i = 0; i < 12; i++) {
        airlock.update(0.05);
      }
      airlock.resetCycle();
      airlock.update(0.016);

      // Verify clean GPU disposal & scene detachment
      airlock.dispose();
      materials.dispose();
      expect(airlock.group.parent).toBeNull();
    });
  });

  describe('Standalone 3D Zombies Fortified Quarantine Outpost Lobby', () => {
    it('builds fortified outpost within lighting budget with all physicalized stations and clean dispose', () => {
      const scene = new THREE.Scene();
      const mockRenderer = {
        capabilities: { getMaxAnisotropy: () => 1 },
      } as unknown as THREE.WebGLRenderer;
      const outpost = buildZombiesOutpostWorld(scene, mockRenderer, false);

      // Strict 60+ FPS lighting budget: at most 1 shadow-casting light
      let shadowCasters = 0;
      let instancedMeshCount = 0;
      outpost.root.traverse((obj) => {
        if ((obj as THREE.Light).isLight && obj.castShadow) {
          shadowCasters += 1;
        }
        if ((obj as THREE.InstancedMesh).isInstancedMesh) {
          instancedMeshCount += 1;
        }
      });
      expect(shadowCasters).toBeLessThanOrEqual(1);
      expect(instancedMeshCount).toBeGreaterThanOrEqual(2);

      // All required interactive stations exist
      const kinds = new Set(
        outpost.interactableMeshes
          .map((m) => m.userData?.outpostInteractable?.kind as string | undefined)
          .filter(Boolean),
      );
      expect(kinds.has('outpost_ops_board')).toBe(true);
      expect(kinds.has('outpost_field_radio')).toBe(true);
      expect(kinds.has('outpost_ammo_crate')).toBe(true);
      expect(kinds.has('outpost_equip_bench')).toBe(true);
      expect(kinds.has('outpost_return_airlock')).toBe(true);
      expect(kinds.has('gun_wall_slot')).toBe(true);
      expect(outpost.gunWallSlots.length).toBeGreaterThanOrEqual(6);

      // Return ramp walk-in trigger matches docked armored transport rear ramp
      const returnPos = new THREE.Vector3();
      expect(outpost.getPropInteractPos('outpost_return_airlock', returnPos)).toBe(true);
      expect(outpost.isInsideReturnRamp(0, 10.0)).toBe(true);
      expect(outpost.isInsideReturnRamp(0, 0)).toBe(false);

      // Dynamic 3D briefing board update, weapon rack sync, return seal & animation ticks
      outpost.setBriefingState({
        mapName: 'Der Lichtspielhaus',
        mapSubtitle: 'Quarantine Theater',
        difficultyLabel: 'HARDCORE',
        modifiersSummary: 'HP 1.35x · SPD 1.15x · ATK 1.2x · SPAWN 1.25x',
        weatherLabel: 'Overcast',
        timeOfDayLabel: 'Night',
        botCount: 2,
        lobbyCode: 'QUAR-42',
        lobbyMembersCount: 2,
        lobbyMaxPlayers: 4,
        bestRound: 14,
      });
      outpost.syncGunWallSlots(['m4a1_sbr', 'mp7a2', null, null, null, null, null, null, null, null]);
      outpost.triggerAmmoCratePop();
      outpost.triggerReturnSeal();
      for (let i = 0; i < 10; i++) {
        outpost.update(0.05);
      }

      // Clean GPU teardown
      outpost.dispose();
      expect(outpost.root.parent).toBeNull();
    });
  });

  describe('Realistic Anatomical Infected Zombie Rig & Procedural Animations', () => {
    it('builds all 3 grounded archetypes with multi-segment anatomy, hitbox parity, and zero glowing cube eyes', () => {
      const rigLib = new InfectedZombieRigLibrary();
      const archetypesSeen = new Set<InfectedArchetypeId>();

      for (let i = 1; i <= 24; i++) {
        const id = `zombie_test_${i}`;
        const rig = rigLib.buildZombie(id);
        archetypesSeen.add(rig.archetype);

        // Realistic human scale (~1.76m ± 6%)
        expect(rig.heightScale).toBeGreaterThanOrEqual(0.92);
        expect(rig.heightScale).toBeLessThanOrEqual(1.08);
        expect(rig.restPelvisY).toBeGreaterThan(0.8);

        // Full multi-segment articulated hierarchy
        expect(rig.pelvisGroup.parent).toBe(rig.bodyPivot);
        expect(rig.spineLower.parent).toBe(rig.pelvisGroup);
        expect(rig.spineUpper.parent).toBe(rig.spineLower);
        expect(rig.neckPivot.parent).toBe(rig.spineUpper);
        expect(rig.headGroup.parent).toBe(rig.neckPivot);
        expect(rig.jawPivot.parent).toBe(rig.headGroup);
        expect(rig.leftElbow.parent).toBe(rig.leftShoulder);
        expect(rig.rightElbow.parent).toBe(rig.rightShoulder);
        expect(rig.leftKnee.parent).toBe(rig.leftHip);
        expect(rig.rightKnee.parent).toBe(rig.rightHip);

        // Exact InfectionZombieAI hitbox userData parity
        const hitZones = new Set<string>();
        expect(rig.hitMeshes.length).toBeGreaterThanOrEqual(6);
        for (const m of rig.hitMeshes) {
          expect(m.userData.combatActorType).toBe('zombie');
          expect(m.userData.actorId).toBe(id);
          expect(m.userData.surfaceMaterial).toBe('wood');
          hitZones.add(m.userData.hitZone);
        }
        expect(hitZones.has('head')).toBe(true);
        expect(hitZones.has('thorax')).toBe(true);
        expect(hitZones.has('limb')).toBe(true);

        // Ensure zero cartoonish glowing MeshBasicMaterial eyes exist
        let basicMatMeshes = 0;
        rig.root.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const mat = (obj as THREE.Mesh).material;
            if (!Array.isArray(mat) && (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
              basicMatMeshes += 1;
            }
          }
        });
        expect(basicMatMeshes).toBe(0);
      }

      expect(archetypesSeen.has('quarantine_guard')).toBe(true);
      expect(archetypesSeen.has('hazmat_tech')).toBe(true);
      expect(archetypesSeen.has('infected_civilian')).toBe(true);

      rigLib.dispose();
    });

    it('drives all 6 procedural pose modes cleanly with distinct finite joint angles', () => {
      const rigLib = new InfectedZombieRigLibrary();
      const rig = rigLib.buildZombie('zombie_pose_check');

      const modes: Array<{ label: string; input: InfectedPoseInput }> = [
        {
          label: 'shamble',
          input: {
            mode: 'locomote',
            walkCycle: 1.2,
            speedMps: 1.4,
            tearPhase: 0,
            vaultT: 0,
            windupProgress: 0,
            staggerRatio: 0,
            deathProgress: 0,
            elapsedSec: 1.0,
          },
        },
        {
          label: 'sprint',
          input: {
            mode: 'locomote',
            walkCycle: 2.4,
            speedMps: 4.3,
            tearPhase: 0,
            vaultT: 0,
            windupProgress: 0,
            staggerRatio: 0,
            deathProgress: 0,
            elapsedSec: 2.0,
          },
        },
        {
          label: 'tear',
          input: {
            mode: 'tear',
            walkCycle: 0,
            speedMps: 0,
            tearPhase: 1.8,
            vaultT: 0,
            windupProgress: 0,
            staggerRatio: 0,
            deathProgress: 0,
            elapsedSec: 3.0,
          },
        },
        {
          label: 'vault_mid',
          input: {
            mode: 'vault',
            walkCycle: 0,
            speedMps: 0,
            tearPhase: 0,
            vaultT: 0.52,
            windupProgress: 0,
            staggerRatio: 0,
            deathProgress: 0,
            elapsedSec: 4.0,
          },
        },
        {
          label: 'windup',
          input: {
            mode: 'windup',
            walkCycle: 0.8,
            speedMps: 1.5,
            tearPhase: 0,
            vaultT: 0,
            windupProgress: 0.82,
            staggerRatio: 0,
            deathProgress: 0,
            elapsedSec: 5.0,
          },
        },
        {
          label: 'stagger',
          input: {
            mode: 'stagger',
            walkCycle: 0.8,
            speedMps: 0.5,
            tearPhase: 0,
            vaultT: 0,
            windupProgress: 0,
            staggerRatio: 0.85,
            deathProgress: 0,
            elapsedSec: 6.0,
          },
        },
        {
          label: 'death_final',
          input: {
            mode: 'death',
            walkCycle: 0,
            speedMps: 0,
            tearPhase: 0,
            vaultT: 0,
            windupProgress: 0,
            staggerRatio: 0,
            deathProgress: 1.0,
            elapsedSec: 7.0,
          },
        },
      ];

      const spineSnapshots: Record<string, number> = {};
      const modesSeen = new Set<InfectedPoseMode>();
      for (const entry of modes) {
        modesSeen.add(entry.input.mode);
        rigLib.applyPose(rig, entry.input);

        // Verify all key bones have finite coordinates & rotations
        const bones = [
          rig.bodyPivot,
          rig.pelvisGroup,
          rig.spineLower,
          rig.spineUpper,
          rig.neckPivot,
          rig.headGroup,
          rig.jawPivot,
          rig.leftHip,
          rig.leftKnee,
          rig.rightHip,
          rig.rightKnee,
          rig.leftShoulder,
          rig.leftElbow,
          rig.rightShoulder,
          rig.rightElbow,
        ];
        for (const b of bones) {
          expect(Number.isFinite(b.rotation.x)).toBe(true);
          expect(Number.isFinite(b.rotation.y)).toBe(true);
          expect(Number.isFinite(b.rotation.z)).toBe(true);
          expect(Number.isFinite(b.position.y)).toBe(true);
        }
        spineSnapshots[entry.label] = rig.spineUpper.rotation.x;
      }

      expect(modesSeen.size).toBe(6);
      // Sprinting hunches deeper forward than staggered recoil
      expect(spineSnapshots.sprint).toBeGreaterThan(spineSnapshots.stagger);
      // Death collapse lowers the body pivot toward the floor
      expect(rig.pelvisGroup.position.y).toBeLessThan(rig.restPelvisY * 0.5);

      rigLib.dispose();
    });
  });
});
