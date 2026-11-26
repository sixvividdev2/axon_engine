import * as THREE from 'three';
import {
  CharacterSkeleton,
  operatorAssetLoader,
  OperatorGearConfig,
  OperatorId,
  OperatorUniformId,
  poseStandingNpcGesture,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import { loadoutStore } from '../data/loadoutStore';
import type { CharacterRosterState, CharacterSlotId } from '../src/modes/openworld';
import { bodyTypeToOperatorId, PMC_FACTIONS } from '../src/modes/openworld/types';

export type BunkerNpcRole =
  | 'armorer'
  | 'ops_commander'
  | 'quartermaster'
  | 'contract_officer'
  | 'roster_operator'
  | 'outpost_commander'
  | 'outpost_squadmate';

export type BunkerNpcGesture =
  | 'tinker'
  | 'briefing'
  | 'clipboard'
  | 'radio_check'
  | 'rifle_ready'
  | 'at_ease';

export interface BunkerNpcDefinition {
  id: string;
  role: BunkerNpcRole;
  displayName: string;
  callsign: string;
  position: THREE.Vector3;
  facingYawRad: number;
  operatorId: OperatorId;
  uniformId: OperatorUniformId;
  gear?: Partial<OperatorGearConfig>;
  gesture: BunkerNpcGesture;
  heldWeaponId?: string | null;
  rosterSlotId?: CharacterSlotId;
  approachLines: readonly string[];
}

export interface BunkerNpcCaption {
  npcId: string;
  speaker: string;
  text: string;
  remainingSec: number;
}

export interface BunkerNpcInteractMeta {
  npcId: string;
  role: BunkerNpcRole;
  displayName: string;
  callsign: string;
  rosterSlotId?: CharacterSlotId;
  maxDistanceM: number;
}

export const NPC_GAZE_MAX_YAW_RAD = THREE.MathUtils.degToRad(44);
export const NPC_GAZE_MAX_PITCH_RAD = THREE.MathUtils.degToRad(18);
export const NPC_GAZE_RANGE_M = 6.8;
export const NPC_CAPTION_TRIGGER_RANGE_M = 4.2;
export const NPC_CAPTION_COOLDOWN_SEC = 18.0;
export const NPC_CAPTION_DISPLAY_SEC = 4.4;

/**
 * Pure deterministic gaze angle solver (clamped to anatomical neck/head limits).
 * Exported for unit testing.
 */
export function computeNpcGazeAngles(
  npcPos: { x: number; y: number; z: number },
  npcFacingYawRad: number,
  targetPos: { x: number; y: number; z: number },
  maxRangeM = NPC_GAZE_RANGE_M,
): { inRange: boolean; targetYawRad: number; targetPitchRad: number; distM: number } {
  const dx = targetPos.x - npcPos.x;
  const dz = targetPos.z - npcPos.z;
  const dy = targetPos.y - (npcPos.y + 1.62);
  const horizDist = Math.hypot(dx, dz);
  const distM = Math.hypot(horizDist, dy);
  if (distM > maxRangeM || horizDist < 0.08) {
    return { inRange: false, targetYawRad: 0, targetPitchRad: 0, distM };
  }

  // CharacterSkeleton local forward is -Z; world forward at yaw Y is (-sin(Y), 0, -cos(Y)).
  const worldYawToTarget = Math.atan2(-dx, -dz);
  let relYaw = worldYawToTarget - npcFacingYawRad;
  while (relYaw > Math.PI) relYaw -= Math.PI * 2;
  while (relYaw < -Math.PI) relYaw += Math.PI * 2;

  // Ignore players directly behind the NPC's back (> 115°)
  if (Math.abs(relYaw) > THREE.MathUtils.degToRad(115)) {
    return { inRange: false, targetYawRad: 0, targetPitchRad: 0, distM };
  }

  const clampedYaw = THREE.MathUtils.clamp(relYaw, -NPC_GAZE_MAX_YAW_RAD, NPC_GAZE_MAX_YAW_RAD);
  const rawPitch = Math.atan2(dy, Math.max(0.35, horizDist));
  const clampedPitch = THREE.MathUtils.clamp(
    rawPitch,
    -NPC_GAZE_MAX_PITCH_RAD,
    NPC_GAZE_MAX_PITCH_RAD,
  );
  return { inRange: true, targetYawRad: clampedYaw, targetPitchRad: clampedPitch, distM };
}

interface ActiveNpcInstance {
  def: BunkerNpcDefinition;
  group: THREE.Group;
  skeleton: CharacterSkeleton;
  weaponMount: THREE.Group | null;
  weaponAssembly: WeaponModelAssembly | null;
  proxyMesh: THREE.Mesh;
  curHeadYaw: number;
  curHeadPitch: number;
  curTorsoYaw: number;
  phaseOffset: number;
  lastCaptionAtSec: number;
  nextLineIndex: number;
  visible: boolean;
}

/**
 * Interactive 3D Bunker & Infection Outpost NPC System.
 * Renders full anatomical procedural operators (`operatorAssetLoader.loadProceduralOperator`),
 * drives damped head/eye gaze tracking + role-specific procedural idle gestures, emits
 * proximity radio/voice captions with cooldown, and registers invisible `[F]` interact proxies.
 */
export class BunkerNpcSystem {
  public readonly group = new THREE.Group();
  private readonly npcs = new Map<string, ActiveNpcInstance>();
  private readonly interactableMeshes: THREE.Mesh[];
  private readonly proxyGeo: THREE.BoxGeometry;
  private readonly proxyMat: THREE.MeshBasicMaterial;
  private readonly maxAniso: number;
  private readonly isSoftwareGl: boolean;
  private readonly rosterSlotFingerprints = new Map<CharacterSlotId, string>();

  private elapsedSec = 0;
  private activeCaption: BunkerNpcCaption | null = null;
  private outpostSquadCount = -1;

  constructor(
    parentRoot: THREE.Group,
    interactableMeshes: THREE.Mesh[],
    options?: { maxAnisotropy?: number; isSoftwareGl?: boolean },
  ) {
    this.group.name = 'BunkerNpcSystem';
    parentRoot.add(this.group);
    this.interactableMeshes = interactableMeshes;
    this.maxAniso = options?.maxAnisotropy ?? 4;
    this.isSoftwareGl = options?.isSoftwareGl ?? false;
    this.proxyGeo = new THREE.BoxGeometry(0.74, 1.82, 0.62);
    this.proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  }

  public spawnNpc(def: BunkerNpcDefinition): void {
    this.removeNpc(def.id);

    const loaded = operatorAssetLoader.loadProceduralOperator(def.operatorId, {
      maxAnisotropy: this.maxAniso,
      uniformId: def.uniformId,
      previewMode: true,
      gear: {
        uniformId: def.uniformId,
        glovesEnabled: true,
        helmetType: def.role === 'armorer' || def.role === 'quartermaster' ? 'none' : 'mich',
        nvgMount: def.role === 'outpost_squadmate' ? 'arnvg' : 'none',
        faceGear: def.role === 'outpost_squadmate' ? 'balaclava' : 'open_face',
        eyewear: def.role === 'armorer' ? 'clear_glasses' : 'none',
        ...def.gear,
      },
    });

    const skel = loaded.skeleton;
    skel.setFirstPersonHeadShadowOnly(false);

    const npcGroup = new THREE.Group();
    npcGroup.name = `BunkerNpc_${def.id}`;
    npcGroup.position.copy(def.position);
    npcGroup.rotation.y = def.facingYawRad;
    npcGroup.add(skel.root);

    skel.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = !this.isSoftwareGl;
        obj.receiveShadow = true;
      }
    });

    // Optional held weapon mounted on chest low-ready pivot (hands solved onto grip/handguard via 2-bone IK)
    let weaponMount: THREE.Group | null = null;
    let weaponAssembly: WeaponModelAssembly | null = null;
    if (def.heldWeaponId && def.heldWeaponId !== 'unarmed') {
      const prof = resolveWeaponProfile(def.heldWeaponId);
      const build = loadoutStore.getActiveWeaponBuild(prof.id);
      const asm = WeaponModelFactory.build({
        id: prof.id,
        holdClass: prof.holdClass,
        barrelLengthM: prof.barrelLengthM,
        visualStyle: prof.visualStyle,
        finish: prof.finish,
        railType: prof.railType,
        isRevolver: prof.isRevolver,
        boreAxisHeightM: prof.boreAxisHeightM,
        rightHandSocket: prof.rightHandSocket,
        leftHandSocket: prof.leftHandSocket,
        muzzleOffset: prof.muzzleOffset,
        laserOffset: prof.laserOffset,
        supportsSuppressor: prof.supportsSuppressor,
        renderLayer: 0,
      });
      WeaponAssembler.applyAttachments(
        asm,
        prof.massKg,
        prof.barrelLengthM,
        prof.magCapacity,
        build.attachments,
        { thirdPersonMode: true },
      );
      weaponMount = new THREE.Group();
      weaponMount.name = `NpcWeaponMount_${def.id}`;
      weaponMount.add(asm.group);
      skel.chest.add(weaponMount);
      weaponAssembly = asm;
    }

    // Invisible raycast interact proxy attached to the NPC group
    const proxyMesh = new THREE.Mesh(this.proxyGeo, this.proxyMat);
    proxyMesh.position.set(0, 0.96, 0);
    const meta: BunkerNpcInteractMeta = {
      npcId: def.id,
      role: def.role,
      displayName: def.displayName,
      callsign: def.callsign,
      rosterSlotId: def.rosterSlotId,
      maxDistanceM: 3.1,
    };
    proxyMesh.userData.bunkerNpc = meta;
    npcGroup.add(proxyMesh);
    this.interactableMeshes.push(proxyMesh);
    this.group.add(npcGroup);

    const phaseOffset = (this.npcs.size + 1) * 1.37;
    // Immediately apply anatomical initial pose so frame 0 never shows bind pose or inverted arms
    poseStandingNpcGesture(skel, def.gesture, phaseOffset, {
      weaponMount,
    });

    this.npcs.set(def.id, {
      def,
      group: npcGroup,
      skeleton: skel,
      weaponMount,
      weaponAssembly,
      proxyMesh,
      curHeadYaw: 0,
      curHeadPitch: 0,
      curTorsoYaw: 0,
      phaseOffset,
      lastCaptionAtSec: -999,
      nextLineIndex: 0,
      visible: true,
    });
  }

  public removeNpc(npcId: string): void {
    const inst = this.npcs.get(npcId);
    if (!inst) return;
    const idx = this.interactableMeshes.indexOf(inst.proxyMesh);
    if (idx >= 0) this.interactableMeshes.splice(idx, 1);
    if (inst.weaponMount) {
      inst.skeleton.chest.remove(inst.weaponMount);
    }
    if (inst.weaponAssembly) {
      inst.weaponAssembly.dispose();
    }
    inst.skeleton.dispose();
    this.group.remove(inst.group);
    this.npcs.delete(npcId);
  }

  /**
   * Spawns all core Hideout bunker NPCs:
   * - Armorer Technician by Arsenal Prep Table
   * - Ops Commander at Ready Room War Table
   * - Quartermaster & Contract Officer in Perimeter Ops Wing
   */
  public populateHideoutCoreNpcs(): void {
    this.spawnNpc({
      id: 'npc_armorer',
      role: 'armorer',
      displayName: 'Armorer Technician',
      callsign: 'ARMORER · VANCE',
      position: new THREE.Vector3(2.48, 0, -1.94),
      facingYawRad: Math.PI, // faces +Z across the Prep Table toward player
      operatorId: 'MALE',
      uniformId: 'infection',
      gear: {
        helmetType: 'none',
        eyewear: 'clear_glasses',
        faceGear: 'open_face',
        facePreset: 'face_02',
      },
      gesture: 'tinker',
      heldWeaponId: null,
      approachLines: [
        'Bench is prepped. Bring any receiver over if you want optics zeroed or rails swapped.',
        'Fresh magazines stacked in the crate. Test your zero down in Bay 3 before lifting off.',
        'Bolt tolerances look tight on your primary. Press [F] to open the Gunsmith workbench.',
      ],
    });

    this.spawnNpc({
      id: 'npc_ops_commander',
      role: 'ops_commander',
      displayName: 'Ops Commander',
      callsign: 'OPS COMMANDER · KOVACS',
      position: new THREE.Vector3(-12.78, 0, -0.15),
      facingYawRad: -Math.PI * 0.5, // faces +X toward Ready Room war table & player
      operatorId: 'FEMALE',
      uniformId: 'ffa',
      gear: {
        helmetType: 'none',
        faceGear: 'open_face',
        eyewear: 'none',
        facePreset: 'face_01',
      },
      gesture: 'briefing',
      heldWeaponId: null,
      approachLines: [
        'Tactical uplinks are live on the war table. Combat Ops on center deck, Perimeter Ops on the north desk.',
        'Helicopter crew is fueled on Pad Zero-One. Lock your sector and we launch immediately.',
        'Sector Four airlock leads straight to the Infection Outpost — convoy driver is idling outside.',
      ],
    });

    this.spawnNpc({
      id: 'npc_quartermaster',
      role: 'quartermaster',
      displayName: 'Quartermaster',
      callsign: 'QUARTERMASTER · HALE',
      position: new THREE.Vector3(-14.68, 0, -8.85),
      facingYawRad: -Math.PI * 0.5, // faces +X into Perimeter Wing floor
      operatorId: 'MALE',
      uniformId: 'team_a',
      gear: {
        helmetType: 'none',
        eyewear: 'clear_glasses',
        facePreset: 'face_03',
      },
      gesture: 'clipboard',
      heldWeaponId: null,
      approachLines: [
        'Armory stash lockers are logged and sealed. Drop salvage here so it survives a field wipe.',
        'Need plates or reserve mags? Step up to the counter and I will pull your locker manifest.',
        'Your Arsenal locker back in the main room holds your personal gear grid anytime.',
      ],
    });

    this.spawnNpc({
      id: 'npc_contract_officer',
      role: 'contract_officer',
      displayName: 'Contract Officer',
      callsign: 'DISPATCH · SERRANO',
      position: new THREE.Vector3(-8.22, 0, -9.15),
      facingYawRad: Math.PI * 0.5, // faces -X into Perimeter Wing floor
      operatorId: 'FEMALE',
      uniformId: 'team_b',
      gear: {
        helmetType: 'mil_tec',
        helmetColor: 'desert_tan',
        eyewear: 'tinted_visor',
        facePreset: 'face_02',
      },
      gesture: 'radio_check',
      heldWeaponId: null,
      approachLines: [
        'Three roster alcoves on the north wall. Walk up to any staged operator to switch callsigns.',
        'Helipad hatch is right behind me. Say the word and Valkyrie 2-1 inserts you into the Perimeter.',
        'Check your medevac balance before lifting off — bankruptcy means permanent loss.',
      ],
    });
  }

  /**
   * Synchronizes the 3 Perimeter Ops Roster Operator alcoves along the Perimeter Wing North wall.
   * Empty slots show no NPC rig; populated slots render the operator's exact M/F body, uniform, gear & primary gun.
   */
  public syncPerimeterRosterAlcoves(roster: CharacterRosterState): void {
    const slotCoords: Record<CharacterSlotId, { x: number; z: number }> = {
      slot_0: { x: -14.2, z: -13.15 },
      slot_1: { x: -11.5, z: -13.15 },
      slot_2: { x: -8.8, z: -13.15 },
    };

    for (const slotId of ['slot_0', 'slot_1', 'slot_2'] as const) {
      const npcId = `npc_roster_${slotId}`;
      const ch = roster.slots[slotId];
      if (!ch) {
        if (this.rosterSlotFingerprints.get(slotId) !== 'EMPTY') {
          this.rosterSlotFingerprints.set(slotId, 'EMPTY');
          this.removeNpc(npcId);
        }
        continue;
      }

      const primaryWeapon =
        ch.equippedKit.primaryWeaponId || ch.arsenal.equippedWeaponId || 'm4a1';
      const fp = [
        ch.characterId,
        ch.callsign,
        ch.bodyType,
        ch.operatorGear.uniformId,
        ch.operatorGear.helmetType,
        ch.operatorGear.helmetColor,
        ch.operatorGear.nvgMount,
        ch.operatorGear.faceGear,
        ch.operatorGear.eyewear,
        ch.operatorGear.facePreset,
        primaryWeapon,
        roster.activeSlotId === slotId ? 'ACTIVE' : 'STANDBY',
      ].join('|');

      if (this.rosterSlotFingerprints.get(slotId) === fp) continue;
      this.rosterSlotFingerprints.set(slotId, fp);

      const coord = slotCoords[slotId];
      const faction = PMC_FACTIONS[ch.pmcFaction];
      this.spawnNpc({
        id: npcId,
        role: 'roster_operator',
        displayName: `${ch.callsign} (${faction.shortName})`,
        callsign: `${ch.callsign.toUpperCase()} · ${ch.shardMode}`,
        position: new THREE.Vector3(coord.x, 0.12, coord.z),
        facingYawRad: Math.PI, // faces +Z out of alcove into Perimeter Wing
        operatorId: bodyTypeToOperatorId(ch.bodyType),
        uniformId: ch.operatorGear.uniformId,
        gear: ch.operatorGear,
        gesture: roster.activeSlotId === slotId ? 'rifle_ready' : 'at_ease',
        heldWeaponId: primaryWeapon,
        rosterSlotId: slotId,
        approachLines: [
          `${ch.callsign} standing by on ${ch.shardMode} shard. Kit checked and plates seated.`,
          `Bankroll at $${ch.cash.toLocaleString()}. Ready to board the helicopter on your call.`,
          `${faction.name} roster slot hot. Press [F] to take point or deploy.`,
        ],
      });
    }
  }

  /**
   * Populates the 3D Infection Outpost with the Outpost Commander + 0..3 dynamic AI Squadmates.
   */
  public populateOutpostCommander(): void {
    this.spawnNpc({
      id: 'npc_outpost_commander',
      role: 'outpost_commander',
      displayName: 'Outpost Commander',
      callsign: 'OUTPOST CMD · VOLKOV',
      position: new THREE.Vector3(5.05, 0, -4.55),
      facingYawRad: 0.72, // angled toward yard center & ops map board
      operatorId: 'MALE',
      uniformId: 'infection',
      gear: {
        helmetType: 'mich',
        helmetColor: 'black',
        eyewear: 'clear_glasses',
        facePreset: 'face_03',
      },
      gesture: 'radio_check',
      heldWeaponId: null,
      approachLines: [
        'Quarantine perimeter is holding, barely. Pick our breach site on the map board.',
        'Infected waves are getting faster every night. Check your rack mags before rolling out.',
        'APC driver is staged at the south gate if you need to cycle back to the Hideout.',
      ],
    });
  }

  public syncOutpostSquadmates(botCount: number): void {
    const clamped = Math.max(0, Math.min(3, Math.floor(botCount)));
    if (clamped === this.outpostSquadCount) return;
    this.outpostSquadCount = clamped;

    const slots: Array<{
      pos: [number, number, number];
      yaw: number;
      callsign: string;
      name: string;
      op: OperatorId;
      uniform: OperatorUniformId;
      weapon: string;
    }> = [
      {
        pos: [-1.45, 0, -4.95],
        yaw: Math.PI + 0.25,
        callsign: 'SQUADMATE · REAPER 1',
        name: 'Allied Rifleman (Reaper 1)',
        op: 'MALE',
        uniform: 'infection',
        weapon: 'm4a1',
      },
      {
        pos: [-6.75, 0, -2.35],
        yaw: -Math.PI * 0.42,
        callsign: 'SQUADMATE · NOVA 2',
        name: 'Allied Breacher (Nova 2)',
        op: 'FEMALE',
        uniform: 'ffa',
        weapon: 'mp5',
      },
      {
        pos: [6.85, 0, -1.65],
        yaw: Math.PI * 0.44,
        callsign: 'SQUADMATE · ATLAS 3',
        name: 'Allied Marksman (Atlas 3)',
        op: 'MALE',
        uniform: 'team_a',
        weapon: 'akm_762',
      },
    ];

    for (let i = 0; i < 3; i++) {
      const id = `npc_outpost_squad_${i}`;
      if (i >= clamped) {
        this.removeNpc(id);
        continue;
      }
      const s = slots[i];
      this.spawnNpc({
        id,
        role: 'outpost_squadmate',
        displayName: s.name,
        callsign: s.callsign,
        position: new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]),
        facingYawRad: s.yaw,
        operatorId: s.op,
        uniformId: s.uniform,
        gesture: 'rifle_ready',
        heldWeaponId: s.weapon,
        approachLines: [
          'Magazines topped off and suppressor tight. Watching your six on breach.',
          'Thermal pings beyond the north wire. Ready to move when Commander gives the signal.',
          'Allied fireteam locked in. Say when and we roll into the hot zone.',
        ],
      });
    }
  }

  public getRegisteredRoles(): BunkerNpcRole[] {
    const roles: BunkerNpcRole[] = [];
    for (const inst of this.npcs.values()) {
      roles.push(inst.def.role);
    }
    return roles;
  }

  public getNpcCount(): number {
    return this.npcs.size;
  }

  public getNpcWorldPos(npcId: string, outPos: THREE.Vector3): boolean {
    const inst = this.npcs.get(npcId);
    if (!inst) return false;
    outPos.copy(inst.def.position);
    outPos.y += 1.38;
    return true;
  }

  public getActiveCaption(): BunkerNpcCaption | null {
    return this.activeCaption ? { ...this.activeCaption } : null;
  }

  /**
   * Manually triggers a radio/voice line from a specific NPC (e.g., on `[F]` interaction).
   */
  public triggerNpcLine(npcId: string, overrideText?: string): void {
    const inst = this.npcs.get(npcId);
    if (!inst) return;
    const text =
      overrideText ??
      inst.def.approachLines[inst.nextLineIndex % inst.def.approachLines.length];
    inst.nextLineIndex += 1;
    inst.lastCaptionAtSec = this.elapsedSec;
    this.activeCaption = {
      npcId: inst.def.id,
      speaker: inst.def.callsign,
      text,
      remainingSec: NPC_CAPTION_DISPLAY_SEC,
    };
  }

  public update(dt: number, playerHeadPos?: THREE.Vector3): void {
    const clampedDt = Math.min(dt, 0.05);
    this.elapsedSec += clampedDt;

    if (this.activeCaption) {
      this.activeCaption.remainingSec -= clampedDt;
      if (this.activeCaption.remainingSec <= 0) {
        this.activeCaption = null;
      }
    }

    for (const inst of this.npcs.values()) {
      if (!inst.visible) continue;
      const skel = inst.skeleton;
      const t = this.elapsedSec + inst.phaseOffset;

      // 1. Damped Head & Torso Gaze Tracking toward player camera
      const gaze = playerHeadPos
        ? computeNpcGazeAngles(inst.def.position, inst.def.facingYawRad, playerHeadPos)
        : { inRange: false, targetYawRad: 0, targetPitchRad: 0, distM: 999 };
      const goalYaw = gaze.inRange ? gaze.targetYawRad : Math.sin(t * 0.45) * 0.08;
      const goalPitch = gaze.inRange ? gaze.targetPitchRad : Math.sin(t * 0.32) * 0.025;
      const goalTorso = gaze.inRange ? gaze.targetYawRad * 0.25 : 0;

      inst.curHeadYaw = THREE.MathUtils.damp(inst.curHeadYaw, goalYaw, 6.5, clampedDt);
      inst.curHeadPitch = THREE.MathUtils.damp(inst.curHeadPitch, goalPitch, 6.5, clampedDt);
      inst.curTorsoYaw = THREE.MathUtils.damp(inst.curTorsoYaw, goalTorso, 4.2, clampedDt);

      // 2. Anatomically Grounded Two-Bone IK Pose & Role-Specific Idle Gesture
      poseStandingNpcGesture(skel, inst.def.gesture, t, {
        headYawRad: inst.curHeadYaw,
        headPitchRad: inst.curHeadPitch,
        torsoYawRad: inst.curTorsoYaw,
        playerNear: gaze.inRange,
        weaponMount: inst.weaponMount,
      });

      // 3. Proximity Radio / Voice Caption Trigger (with anti-spam cooldown)
      if (
        !this.activeCaption &&
        gaze.inRange &&
        gaze.distM <= NPC_CAPTION_TRIGGER_RANGE_M &&
        this.elapsedSec - inst.lastCaptionAtSec >= NPC_CAPTION_COOLDOWN_SEC &&
        inst.def.approachLines.length > 0
      ) {
        this.triggerNpcLine(inst.def.id);
      }
    }
  }

  public dispose(): void {
    for (const id of [...this.npcs.keys()]) {
      this.removeNpc(id);
    }
    this.proxyGeo.dispose();
    this.proxyMat.dispose();
    this.group.parent?.remove(this.group);
  }
}
