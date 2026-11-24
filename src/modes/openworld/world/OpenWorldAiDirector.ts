import * as THREE from 'three';
import {
  ArticulatedRagdoll,
  BodycamPhysicsWorld,
  resolveWeaponProfile,
} from '../../../../bodycam-sdk';
import {
  GloveColorId,
  HelmetColorId,
  HelmetTypeId,
  NvgMountId,
  OperatorId,
} from '../../../../bodycam-sdk/operator/OperatorTypes';
import { OperatorUniformId } from '../../../../bodycam-sdk/TacticalUniforms';
import {
  BuiltTacticalOperatorRig,
  TacticalCombatPose,
  TacticalOperatorRigFactory,
} from '../../../../combat/TacticalOperatorRig';
import { normalizeWeaponAttachments, WeaponAttachments } from '../../../../data/attachments';
import { TacticalEquipmentId } from '../../../../data/tacticalEquipment';
import {
  getStandingTier,
  OpenWorldCharacter,
  PmcFactionId,
  ShardMode,
  SUB_FACTION_MAP,
  SubFactionId,
} from '../types';
import {
  OPENWORLD_LANDMARKS,
  SEA_LEVEL_M,
  WORLD_HALF_M,
} from './OpenWorldTerrain';
import {
  FobCompoundId,
  fobLocalToWorld,
  getFobCheckpointGateSpec,
  getFobCompoundSpec,
  getFobGuardTowerSpecs,
  isFobCompoundId,
} from './OpenWorldFobLayout';

export type AiFactionKind = PmcFactionId | SubFactionId;
export type AiRelationStatus = 'allied' | 'neutral' | 'hostile';
export type AiHitZone = 'head' | 'torso' | 'limb';
export type AiAgentRole = 'patrol' | 'tower_sniper' | 'gate_guard';

export interface AiDamageToPlayerEvent {
  agentId: string;
  attackerFaction: AiFactionKind;
  attackerCallsign: string;
  damage: number;
  distanceM: number;
  originX: number;
  originY: number;
  originZ: number;
}

export interface AiEliminationEvent {
  agentId: string;
  sectorId: string;
  faction: AiFactionKind;
  callsign: string;
  bountyUsd: number;
  headshot: boolean;
  subFactionStandingDelta?: {
    subFactionId: SubFactionId;
    delta: number;
    rivalId: SubFactionId;
    rivalDelta: number;
  };
}

export interface AiNeutralWarningEvent {
  agentId: string;
  subFactionId: SubFactionId;
  callsign: string;
  reason: 'aimed_at' | 'perimeter_breach';
  message: string;
}

export interface AiUpdateOptions {
  playerAds?: boolean;
  playerAimDirX?: number;
  playerAimDirY?: number;
  playerAimDirZ?: number;
  onNeutralWarning?: (ev: AiNeutralWarningEvent) => void;
}

export interface AiSummaryTelemetry {
  totalAlive: number;
  activeNearby: number;
  hostileEngaging: number;
  effectiveVisionRangeM: number;
}

export interface AiAgentRecord {
  readonly id: string;
  readonly sectorId: string;
  readonly callsign: string;
  readonly faction: AiFactionKind;
  readonly role: AiAgentRole;
  readonly fobId?: FobCompoundId;
  readonly postX: number;
  readonly postY: number;
  readonly postZ: number;
  readonly postYaw: number;
  readonly visionRangeOverrideM?: number;
  readonly operatorId: OperatorId;
  readonly weaponId: string;
  readonly homeX: number;
  readonly homeZ: number;
  readonly patrolRadiusM: number;
  readonly rig: BuiltTacticalOperatorRig;
  readonly ragdoll: ArticulatedRagdoll;
  readonly group: THREE.Group;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  aimPitch: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  deathAgeSec: number;
  respawnTimerSec: number;
  patrolAngle: number;
  strafeSign: number;
  strafeTimer: number;
  fireCooldown: number;
  muzzleFlashTimer: number;
  alerted: boolean;
  alertDecayTimer: number;
  // Battle-mode tactical animation & weapon handling state
  walkCycle: number;
  speedMps: number;
  sprint: boolean;
  crouchBlend: number;
  crouchTarget: number;
  crouchTimer: number;
  leanBlend: number;
  adsBlend: number;
  recoilKick: number;
  firingVibration: number;
  flinchPitch: number;
  magAmmo: number;
  magCapacity: number;
  reloading: boolean;
  reloadTimer: number;
  reloadDuration: number;
  hasNvgMount: boolean;
  nvgFlipped: boolean;
  losCheckTimer: number;
  cachedLosBlocked: boolean;
  retaliationHostile: boolean;
  neutralAlertStage: 'calm' | 'warned' | 'hostile';
  neutralWarningTimer: number;
  neutralWarningVoiceCooldown: number;
  headYaw: number;
  headPitchOffset: number;
  headRollOffset: number;
  hitFlinchRoll: number;
}

interface FactionKitTemplate {
  readonly operatorId: OperatorId;
  readonly callsignPrefix: string;
  readonly uniformId: OperatorUniformId;
  readonly weaponId: string;
  readonly attachments: WeaponAttachments;
  readonly helmetType: HelmetTypeId;
  readonly helmetColor: HelmetColorId;
  readonly gloveColor: GloveColorId;
  readonly nvgMount: NvgMountId;
  readonly beltEquip: TacticalEquipmentId;
}

interface PooledAiTracer {
  active: boolean;
  life: number;
  mesh: THREE.Mesh;
}

const ACTIVE_SIM_RADIUS_M = 210;
const BASE_AI_VISION_RANGE_M = 115;
const MAX_AI_TRACERS = 16;
const AI_RESPAWN_DELAY_SEC = 110;
const AI_RAGDOLL_VISIBLE_SEC = 28;

// Module-scope zero-GC scratch objects shared across all agents
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const _spawnPos = new THREE.Vector3();
const _velVec = new THREE.Vector3();
const _impDir = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _playerGazeTarget = new THREE.Vector3();

const FACTION_ARMBAND_HEX: Readonly<Record<AiFactionKind, number>> = {
  pmc_alpha: 0x38bdf8,
  pmc_bravo: 0xf59e0b,
  dockworkers_syndicate: 0x14b8a6,
  highland_militia: 0x84cc16,
  alpine_remnant: 0xa855f7,
};

const _poseScratch: TacticalCombatPose = {
  crouchBlend: 0,
  leanBlend: 0,
  aimPitch: 0,
  adsBlend: 0,
  pointAimBlend: 0,
  cantBlend: 0,
  reloadBlend: 0,
  speedMps: 0,
  walkCycle: 0,
  sprint: false,
  recoilKick: 0,
  firingVibration: 0,
  flinchPitch: 0,
  handlingAction: 'NONE',
  handlingProgress: 0,
  headYaw: 0,
  headPitchOffset: 0,
  headRollOffset: 0,
  torsoYawOffset: 0,
};

/**
 * Mixed MALE / FEMALE Battle-parity faction squad loadouts with real procedural firearms,
 * compatible optics/muzzles/foregrips, helmets, NVG mounts, gloves, and belt ordnance.
 */
const FACTION_KIT_ROSTERS: Readonly<Record<AiFactionKind, readonly FactionKitTemplate[]>> = {
  pmc_alpha: [
    {
      operatorId: 'MALE',
      callsignPrefix: 'ALPHA',
      uniformId: 'team_a',
      weaponId: 'm4a1',
      attachments: {
        optic: 'optic_eotech_holo',
        foregrip: 'grip_angled_afg',
        tactical: 'tac_peq_combo',
      },
      helmetType: 'mil_tec',
      helmetColor: 'black',
      gloveColor: 'slate',
      nvgMount: 'arnvg',
      beltEquip: 'm67_frag',
    },
    {
      operatorId: 'FEMALE',
      callsignPrefix: 'VALKYRIE',
      uniformId: 'team_a',
      weaponId: 'hk416',
      attachments: {
        optic: 'optic_t2_red_dot',
        foregrip: 'grip_vertical_rk',
        tactical: 'tac_flashlight',
      },
      helmetType: 'mil_tec',
      helmetColor: 'uniform',
      gloveColor: 'charcoal',
      nvgMount: 'pvs7',
      beltEquip: 'm18_smoke',
    },
    {
      operatorId: 'MALE',
      callsignPrefix: 'KESTREL',
      uniformId: 'team_a',
      weaponId: 'sig_mcx',
      attachments: {
        optic: 'optic_lpvo_1_6',
        foregrip: 'grip_angled_afg',
        tactical: 'tac_peq_combo',
      },
      helmetType: 'mil_tec',
      helmetColor: 'black',
      gloveColor: 'slate',
      nvgMount: 'arnvg',
      beltEquip: 'm84_flash',
    },
  ],
  pmc_bravo: [
    {
      operatorId: 'MALE',
      callsignPrefix: 'BRAVO',
      uniformId: 'team_b',
      weaponId: 'ak105',
      attachments: {
        optic: 'optic_kobra_rd',
        muzzle: 'muzzle_comp_ak',
        foregrip: 'grip_vertical_rk',
      },
      helmetType: 'mil_tec',
      helmetColor: 'coyote_brown',
      gloveColor: 'coyote',
      nvgMount: 'pvs7',
      beltEquip: 'm67_frag',
    },
    {
      operatorId: 'FEMALE',
      callsignPrefix: 'KATYA',
      uniformId: 'team_b',
      weaponId: 'aks74u',
      attachments: {
        optic: 'optic_kobra_rd',
        muzzle: 'muzzle_pbs4_545',
        tactical: 'tac_flashlight',
      },
      helmetType: 'mich',
      helmetColor: 'desert_tan',
      gloveColor: 'sand',
      nvgMount: 'none',
      beltEquip: 'm84_flash',
    },
    {
      operatorId: 'MALE',
      callsignPrefix: 'GRANIT',
      uniformId: 'team_b',
      weaponId: 'benelli_m4',
      attachments: {
        optic: 'optic_t2_red_dot',
        tactical: 'tac_flashlight',
      },
      helmetType: 'mil_tec',
      helmetColor: 'coyote_brown',
      gloveColor: 'coyote',
      nvgMount: 'pvs7',
      beltEquip: 'm67_frag',
    },
  ],
  dockworkers_syndicate: [
    {
      operatorId: 'MALE',
      callsignPrefix: 'SYND',
      uniformId: 'ffa',
      weaponId: 'hk_mp5',
      attachments: {
        optic: 'optic_t2_red_dot',
        muzzle: 'muzzle_9mm_suppressor',
        tactical: 'tac_flashlight',
      },
      helmetType: 'mich',
      helmetColor: 'black',
      gloveColor: 'charcoal',
      nvgMount: 'none',
      beltEquip: 'm18_smoke',
    },
    {
      operatorId: 'FEMALE',
      callsignPrefix: 'MARA',
      uniformId: 'ffa',
      weaponId: 'benelli_m4',
      attachments: {
        optic: 'optic_rmr_type2',
        tactical: 'tac_flashlight',
      },
      helmetType: 'mil_tec',
      helmetColor: 'uniform',
      gloveColor: 'charcoal',
      nvgMount: 'none',
      beltEquip: 'm84_flash',
    },
    {
      operatorId: 'MALE',
      callsignPrefix: 'DOCK',
      uniformId: 'ffa',
      weaponId: 'aks74u',
      attachments: {
        optic: 'optic_kobra_rd',
        tactical: 'tac_laser_red',
      },
      helmetType: 'mich',
      helmetColor: 'black',
      gloveColor: 'uniform',
      nvgMount: 'none',
      beltEquip: 'm67_frag',
    },
  ],
  highland_militia: [
    {
      operatorId: 'MALE',
      callsignPrefix: 'MILITIA',
      uniformId: 'infection',
      weaponId: 'ak105',
      attachments: {
        optic: 'optic_kobra_rd',
        muzzle: 'muzzle_comp_ak',
      },
      helmetType: 'mich',
      helmetColor: 'olive_drab',
      gloveColor: 'olive',
      nvgMount: 'none',
      beltEquip: 'm67_frag',
    },
    {
      operatorId: 'FEMALE',
      callsignPrefix: 'ZARA',
      uniformId: 'infection',
      weaponId: 'dragunov_svd',
      attachments: {
        optic: 'optic_pso1_4x',
      },
      helmetType: 'mil_tec',
      helmetColor: 'ranger_green',
      gloveColor: 'olive',
      nvgMount: 'pvs7',
      beltEquip: 'm18_smoke',
    },
    {
      operatorId: 'MALE',
      callsignPrefix: 'STEPPE',
      uniformId: 'infection',
      weaponId: 'mossberg_590a1',
      attachments: {
        tactical: 'tac_flashlight',
      },
      helmetType: 'mich',
      helmetColor: 'olive_drab',
      gloveColor: 'coyote',
      nvgMount: 'none',
      beltEquip: 'm67_frag',
    },
  ],
  alpine_remnant: [
    {
      operatorId: 'MALE',
      callsignPrefix: 'REMNANT',
      uniformId: 'team_a',
      weaponId: 'mk14_ebr',
      attachments: {
        optic: 'optic_lpvo_1_6',
        foregrip: 'grip_angled_afg',
        tactical: 'tac_peq_combo',
      },
      helmetType: 'mil_tec',
      helmetColor: 'ranger_green',
      gloveColor: 'charcoal',
      nvgMount: 'arnvg',
      beltEquip: 'm67_frag',
    },
    {
      operatorId: 'FEMALE',
      callsignPrefix: 'FREYA',
      uniformId: 'team_a',
      weaponId: 'sig_mcx',
      attachments: {
        optic: 'optic_eotech_holo',
        foregrip: 'grip_vertical_rk',
        tactical: 'tac_peq_combo',
      },
      helmetType: 'mil_tec',
      helmetColor: 'uniform',
      gloveColor: 'slate',
      nvgMount: 'arnvg',
      beltEquip: 'm84_flash',
    },
    {
      operatorId: 'MALE',
      callsignPrefix: 'PEAK',
      uniformId: 'team_a',
      weaponId: 'dragunov_svd',
      attachments: {
        optic: 'optic_pso1m2',
      },
      helmetType: 'mil_tec',
      helmetColor: 'black',
      gloveColor: 'slate',
      nvgMount: 'pvs7',
      beltEquip: 'm18_smoke',
    },
  ],
};

const FOB_SNIPER_KITS: Readonly<Record<PmcFactionId, FactionKitTemplate>> = {
  pmc_alpha: {
    operatorId: 'MALE',
    callsignPrefix: 'ALPHA-OVW',
    uniformId: 'team_a',
    weaponId: 'remington_m24',
    attachments: {
      optic: 'optic_nightforce_atacr',
    },
    helmetType: 'mil_tec',
    helmetColor: 'black',
    gloveColor: 'slate',
    nvgMount: 'arnvg',
    beltEquip: 'm18_smoke',
  },
  pmc_bravo: {
    operatorId: 'FEMALE',
    callsignPrefix: 'BRAVO-OVW',
    uniformId: 'team_b',
    weaponId: 'sv_98',
    attachments: {
      optic: 'optic_nightforce_atacr',
    },
    helmetType: 'mil_tec',
    helmetColor: 'coyote_brown',
    gloveColor: 'coyote',
    nvgMount: 'pvs7',
    beltEquip: 'm18_smoke',
  },
};

const FOB_GATE_GUARD_KITS: Readonly<Record<PmcFactionId, readonly FactionKitTemplate[]>> = {
  pmc_alpha: [
    FACTION_KIT_ROSTERS.pmc_alpha[0],
    FACTION_KIT_ROSTERS.pmc_alpha[1],
  ],
  pmc_bravo: [
    FACTION_KIT_ROSTERS.pmc_bravo[0],
    FACTION_KIT_ROSTERS.pmc_bravo[1],
  ],
};

/**
 * Pure deterministic Rules of Engagement (ROE) evaluator shared by runtime AI & unit tests.
 * - `PvE` shard: PMC Alpha and PMC Bravo are strictly ALLIED (ceasefire).
 * - `PvPvE` shard: Rival PMC is strictly HOSTILE on sight.
 * - Sub-Factions: obey character's standing tier (`Hostile` <= -26, `Neutral` -25..49, `Trusted` >= 50),
 *   unless actively provoked by player gunfire.
 */
export function evaluateAiRelation(
  agentFaction: AiFactionKind,
  shardMode: ShardMode,
  playerFaction: PmcFactionId,
  subFactionStanding: Readonly<Record<SubFactionId, number>>,
  provokedSubFactions: ReadonlySet<SubFactionId>,
): AiRelationStatus {
  if (agentFaction === 'pmc_alpha' || agentFaction === 'pmc_bravo') {
    if (agentFaction === playerFaction) return 'allied';
    return shardMode === 'PvE' ? 'allied' : 'hostile';
  }

  if (provokedSubFactions.has(agentFaction)) return 'hostile';
  const standing = subFactionStanding[agentFaction] ?? 0;
  const tier = getStandingTier(standing);
  if (tier === 'Hostile') return 'hostile';
  if (tier === 'Trusted') return 'allied';
  return 'neutral';
}

/**
 * Computes effective AI visual detection radius from atmosphere vision multiplier
 * (day/night + coastal fog + mountain rain) and whether the player's flashlight is active in low light.
 */
export function computeEffectiveAiVisionRange(
  aiVisionConeMultiplier: number,
  flashlightOn: boolean,
  isNight: boolean,
): number {
  const clampedMult = Math.max(0.22, Math.min(1.0, aiVisionConeMultiplier));
  const lightRevealBonus = flashlightOn && isNight ? 0.32 : flashlightOn ? 0.08 : 0;
  return Math.round(BASE_AI_VISION_RANGE_M * Math.min(1.0, clampedMult + lightRevealBonus));
}

/**
 * Battle-Parity Open World Tactical AI Squad Director.
 * - Reuses Axon's shared `TacticalOperatorRigFactory` (full M/F sculpted silhouettes,
 *   ripstop PBR uniforms, helmets/NVGs/gloves/belt ordnance, real `WeaponModelFactory`
 *   procedural firearms + attachments, and zero-GC 2-bone arm IK combat pose animation).
 * - Runs `ArticulatedRagdoll` physical death collapse over the 4km heightfield terrain.
 * - Enforces Dual-Shard ROE (PvPvE vs PvE), Sub-Faction standing, and Atmosphere vision scaling.
 * - Zero per-frame heap allocations; explicit `.dispose()` teardown.
 */
export class OpenWorldAiDirector {
  public readonly rootGroup = new THREE.Group();
  public readonly hitMeshes: THREE.Mesh[] = [];
  public readonly activeHitMeshes: THREE.Mesh[] = [];

  private readonly rigFactory: TacticalOperatorRigFactory;
  private readonly ragdollWorld: BodycamPhysicsWorld;
  private readonly agents: AiAgentRecord[] = [];
  private readonly agentById = new Map<string, AiAgentRecord>();
  private readonly provokedSubFactions = new Set<SubFactionId>();
  private readonly tracers: PooledAiTracer[] = [];

  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];
  private readonly sampleGroundHeight: (x: number, z: number) => number;
  private readonly isLineOfSightBlocked?: (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ) => boolean;

  private activeNearbyCount = 0;
  private hostileEngagingCount = 0;
  private lastVisionRangeM = BASE_AI_VISION_RANGE_M;
  private elapsedClock = 0;
  private activeHitMeshesReady = false;
  private frameParity = 0;

  constructor(
    scene: THREE.Scene,
    sampleGroundHeight: (x: number, z: number) => number,
    playerFaction: PmcFactionId,
    maxAnisotropy = 4,
    isLineOfSightBlocked?: (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
    ) => boolean,
  ) {
    this.sampleGroundHeight = sampleGroundHeight;
    this.isLineOfSightBlocked = isLineOfSightBlocked;
    this.rootGroup.name = 'openworld_ai_squads';
    scene.add(this.rootGroup);

    this.rigFactory = new TacticalOperatorRigFactory(maxAnisotropy);
    this.ragdollWorld = new BodycamPhysicsWorld();
    this.ragdollWorld.boundsMinX = -WORLD_HALF_M;
    this.ragdollWorld.boundsMaxX = WORLD_HALF_M;
    this.ragdollWorld.boundsMinZ = -WORLD_HALF_M;
    this.ragdollWorld.boundsMaxZ = WORLD_HALF_M;

    this.initSharedAssetsAndSquads(playerFaction);
  }

  private spawnOperatorAgent(params: {
    agentId: string;
    sectorId: string;
    callsign: string;
    faction: AiFactionKind;
    role: AiAgentRole;
    fobId?: FobCompoundId;
    kit: FactionKitTemplate;
    wx: number;
    wy: number;
    wz: number;
    yaw: number;
    homeX: number;
    homeZ: number;
    patrolRadiusM: number;
    visionRangeOverrideM?: number;
    seqIdx: number;
  }): void {
    const {
      agentId,
      sectorId,
      callsign,
      faction,
      role,
      fobId,
      kit,
      wx,
      wy,
      wz,
      yaw,
      homeX,
      homeZ,
      patrolRadiusM,
      visionRangeOverrideM,
      seqIdx,
    } = params;

    const rig = this.rigFactory.buildOperator('bot', agentId, kit.uniformId, kit.operatorId);
    rig.root.name = agentId;
    rig.root.position.set(wx, wy, wz);
    rig.root.rotation.y = yaw;

    rig.setGearAppearance({
      glovesEnabled: true,
      gloveColor: kit.gloveColor,
      helmetType: kit.helmetType,
      helmetColor: kit.helmetColor,
      nvgMount: kit.nvgMount,
      nvgFlipped: false,
      faceGear:
        role === 'tower_sniper'
          ? 'balaclava'
          : seqIdx % 2 === 0
            ? 'open_face'
            : 'neck_gaiter',
      eyewear:
        role === 'tower_sniper'
          ? 'tinted_visor'
          : seqIdx % 3 === 1
            ? 'clear_glasses'
            : 'none',
    });

    const normalizedAtt = normalizeWeaponAttachments(kit.weaponId, kit.attachments);
    rig.setWeaponLoadout(kit.weaponId, normalizedAtt);
    rig.setBeltEquipment(kit.beltEquip, 'front_left', 2, true);
    rig.setFactionArmband(FACTION_ARMBAND_HEX[faction]);
    const isPmc = faction === 'pmc_alpha' || faction === 'pmc_bravo';
    rig.setIrStrobe(isPmc, false);
    rig.setWarningLaser(false);
    rig.muzzleFlash.visible = false;
    rig.laserBeam.visible = false;
    rig.flashlightGlow.visible = false;

    for (let mIdx = 0; mIdx < rig.hitMeshes.length; mIdx++) {
      const hm = rig.hitMeshes[mIdx];
      const rawZone = String(hm.userData?.hitZone ?? 'thorax');
      const mappedZone: AiHitZone =
        rawZone === 'head' ? 'head' : rawZone === 'limb' ? 'limb' : 'torso';
      hm.userData.openWorldAiId = agentId;
      hm.userData.hitZone = mappedZone;
      hm.userData.ballisticMaterial = rawZone === 'head' ? 'metal' : 'flesh';
      this.hitMeshes.push(hm);
    }

    _poseScratch.crouchBlend = 0;
    _poseScratch.leanBlend = 0;
    _poseScratch.aimPitch = 0;
    _poseScratch.adsBlend = role === 'tower_sniper' ? 0.65 : 0.25;
    _poseScratch.pointAimBlend = 0;
    _poseScratch.cantBlend = 0;
    _poseScratch.reloadBlend = 0;
    _poseScratch.speedMps = 0;
    _poseScratch.walkCycle = seqIdx * 1.3;
    _poseScratch.sprint = false;
    _poseScratch.recoilKick = 0;
    _poseScratch.firingVibration = 0;
    _poseScratch.flinchPitch = 0;
    _poseScratch.handlingAction = 'NONE';
    _poseScratch.handlingProgress = 0;
    rig.applyCombatPose(_poseScratch);

    this.rootGroup.add(rig.root);

    const prof = resolveWeaponProfile(kit.weaponId);
    const magCap = Math.max(5, Math.min(30, prof.magCapacity));

    const rec: AiAgentRecord = {
      id: agentId,
      sectorId,
      callsign,
      faction,
      role,
      fobId,
      postX: wx,
      postY: wy,
      postZ: wz,
      postYaw: yaw,
      visionRangeOverrideM,
      operatorId: kit.operatorId,
      weaponId: kit.weaponId,
      homeX,
      homeZ,
      patrolRadiusM,
      rig,
      ragdoll: new ArticulatedRagdoll(),
      group: rig.root,
      x: wx,
      y: wy,
      z: wz,
      vx: 0,
      vz: 0,
      yaw,
      aimPitch: 0,
      hp: 100,
      maxHp: 100,
      alive: true,
      deathAgeSec: 0,
      respawnTimerSec: 0,
      patrolAngle: yaw,
      strafeSign: seqIdx % 2 === 0 ? 1 : -1,
      strafeTimer: 1.5 + (seqIdx % 4) * 0.5,
      fireCooldown: 0.7 + (seqIdx % 3) * 0.25,
      muzzleFlashTimer: 0,
      alerted: false,
      alertDecayTimer: 0,
      walkCycle: seqIdx * 1.3,
      speedMps: 0,
      sprint: false,
      crouchBlend: 0,
      crouchTarget: 0,
      crouchTimer: 2.5 + (seqIdx % 4) * 0.6,
      leanBlend: 0,
      adsBlend: role === 'tower_sniper' ? 0.65 : 0.25,
      recoilKick: 0,
      firingVibration: 0,
      flinchPitch: 0,
      magAmmo: magCap,
      magCapacity: magCap,
      reloading: false,
      reloadTimer: 0,
      reloadDuration: Math.max(1.8, prof.reloadDurationSec),
      hasNvgMount: kit.nvgMount !== 'none',
      nvgFlipped: false,
      losCheckTimer: (seqIdx % 5) * 0.02,
      cachedLosBlocked: false,
      retaliationHostile: false,
      neutralAlertStage: 'calm',
      neutralWarningTimer: 0,
      neutralWarningVoiceCooldown: 0,
      headYaw: 0,
      headPitchOffset: 0,
      headRollOffset: 0,
      hitFlinchRoll: 0,
    };
    this.agents.push(rec);
    this.agentById.set(agentId, rec);
  }

  private initSharedAssetsAndSquads(playerFaction: PmcFactionId): void {
    const tracerGeo = new THREE.CylinderGeometry(0.014, 0.014, 1, 5);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffb35c,
      transparent: true,
      opacity: 0.9,
    });
    this.sharedGeos.push(tracerGeo);
    this.sharedMats.push(tracerMat);

    // Pooled tracer beams (zero per-shot allocation)
    for (let i = 0; i < MAX_AI_TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.rootGroup.add(mesh);
      this.tracers.push({ active: false, life: 0, mesh });
    }

    const rivalPmc: PmcFactionId = playerFaction === 'pmc_alpha' ? 'pmc_bravo' : 'pmc_alpha';

    // Spawn Battle-grade garrison squads at every named landmark
    let seq = 1;
    for (const lm of OPENWORLD_LANDMARKS) {
      if (isFobCompoundId(lm.id)) {
        const fobFaction: PmcFactionId = lm.kind === 'fob_alpha' ? 'pmc_alpha' : 'pmc_bravo';
        const fobSpec = getFobCompoundSpec(lm.id);
        const roster = FACTION_KIT_ROSTERS[fobFaction];

        // 1. Two interior FOB courtyard patrols positioned on open tarmac walkways
        const courtyardAnchors: ReadonlyArray<{ lx: number; lz: number; yaw: number }> = [
          { lx: -6.0, lz: 18.0, yaw: fobSpec.yaw },
          { lx: -24.0, lz: -2.0, yaw: fobSpec.yaw + Math.PI * 0.5 },
        ];
        for (let i = 0; i < courtyardAnchors.length; i++) {
          const kit = roster[i % roster.length];
          const p = fobLocalToWorld(fobSpec, courtyardAnchors[i].lx, courtyardAnchors[i].lz);
          const wy = Math.max(SEA_LEVEL_M + 0.25, fobSpec.baseY + 0.08, this.sampleGroundHeight(p.x, p.z));
          const agentId = `ow_ai_${seq++}`;
          this.spawnOperatorAgent({
            agentId,
            sectorId: lm.id,
            callsign: `${kit.callsignPrefix}-${String(seq - 1).padStart(2, '0')}`,
            faction: fobFaction,
            role: 'patrol',
            fobId: lm.id,
            kit,
            wx: p.x,
            wy,
            wz: p.z,
            yaw: courtyardAnchors[i].yaw,
            homeX: p.x,
            homeZ: p.z,
            patrolRadiusM: 6.5,
            seqIdx: seq,
          });
        }

        // 2. Four elevated Corner Guard Tower Snipers equipped with Bolt-Action Sniper Rifles
        const sniperKit = FOB_SNIPER_KITS[fobFaction];
        const towers = getFobGuardTowerSpecs(lm.id);
        for (const tw of towers) {
          const agentId = `ow_ai_${seq++}`;
          this.spawnOperatorAgent({
            agentId,
            sectorId: lm.id,
            callsign: `${fobFaction === 'pmc_alpha' ? 'ALPHA' : 'BRAVO'}-TW-${tw.cornerLabel}`,
            faction: fobFaction,
            role: 'tower_sniper',
            fobId: lm.id,
            kit: sniperKit,
            wx: tw.worldX,
            wy: tw.deckY,
            wz: tw.worldZ,
            yaw: tw.faceYaw,
            homeX: tw.worldX,
            homeZ: tw.worldZ,
            patrolRadiusM: 0,
            visionRangeOverrideM: 175,
            seqIdx: seq,
          });
        }

        // 3. Two On-Foot Checkpoint Gate Guards controlling the Military Base Boom Gate
        const gateSpec = getFobCheckpointGateSpec(lm.id);
        const gateKits = FOB_GATE_GUARD_KITS[fobFaction];
        for (let i = 0; i < gateSpec.guardPosts.length; i++) {
          const gp = gateSpec.guardPosts[i];
          const wy = Math.max(SEA_LEVEL_M + 0.25, fobSpec.baseY + 0.08, this.sampleGroundHeight(gp.worldX, gp.worldZ));
          const agentId = `ow_ai_${seq++}`;
          this.spawnOperatorAgent({
            agentId,
            sectorId: lm.id,
            callsign: `${fobFaction === 'pmc_alpha' ? 'ALPHA' : 'BRAVO'}-GATE-${i + 1}`,
            faction: fobFaction,
            role: 'gate_guard',
            fobId: lm.id,
            kit: gateKits[i % gateKits.length],
            wx: gp.worldX,
            wy,
            wz: gp.worldZ,
            yaw: gp.faceYaw,
            homeX: gp.worldX,
            homeZ: gp.worldZ,
            patrolRadiusM: 2.0,
            visionRangeOverrideM: 125,
            seqIdx: seq,
          });
        }
        continue;
      }

      const squadFaction: AiFactionKind = lm.subFactionId ?? rivalPmc;
      const squadSize = 3;
      const roster = FACTION_KIT_ROSTERS[squadFaction];

      for (let i = 0; i < squadSize; i++) {
        const kit = roster[i % roster.length];
        const angle = (i / squadSize) * Math.PI * 2 + 0.55;
        const radius = 14 + i * 7;
        const wx = lm.worldX + Math.cos(angle) * radius;
        const wz = lm.worldZ + Math.sin(angle) * radius;
        const wy = Math.max(SEA_LEVEL_M + 0.25, this.sampleGroundHeight(wx, wz));
        const agentId = `ow_ai_${seq++}`;
        this.spawnOperatorAgent({
          agentId,
          sectorId: lm.id,
          callsign: `${kit.callsignPrefix}-${String(seq - 1).padStart(2, '0')}`,
          faction: squadFaction,
          role: 'patrol',
          kit,
          wx,
          wy,
          wz,
          yaw: angle,
          homeX: lm.worldX,
          homeZ: lm.worldZ,
          patrolRadiusM: 18 + (i % 3) * 8,
          seqIdx: seq,
        });
      }
    }
  }

  public isAgentAlive(agentId: string): boolean {
    const a = this.agentById.get(agentId);
    return Boolean(a && a.alive);
  }

  public getRaycastHitMeshes(): THREE.Mesh[] {
    return this.activeHitMeshesReady ? this.activeHitMeshes : this.hitMeshes;
  }

  public getRelationForAgent(
    agent: AiAgentRecord,
    character: OpenWorldCharacter | null,
  ): AiRelationStatus {
    if (agent.retaliationHostile) return 'hostile';
    if (!character) return 'neutral';
    return evaluateAiRelation(
      agent.faction,
      character.shardMode,
      character.pmcFaction,
      character.subFactionStanding,
      this.provokedSubFactions,
    );
  }

  /**
   * Counts surviving hostile AI garrison members currently holding a given sector.
   */
  public getHostileGarrisonCount(sectorId: string, character: OpenWorldCharacter | null): number {
    if (!character) return 0;
    let count = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || a.sectorId !== sectorId) continue;
      if (this.getRelationForAgent(a, character) === 'hostile') {
        count++;
      }
    }
    return count;
  }

  /**
   * Alert nearby AI squads when the player fires a weapon (acoustic detection).
   */
  public notifyPlayerGunshot(x: number, z: number, radiusM: number): void {
    const rSq = radiusM * radiusM;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz <= rSq) {
        a.alerted = true;
        a.alertDecayTimer = 18;
      }
    }
  }

  /**
   * Applies ballistic, melee, or grenade damage to an AI operator.
   * Real Friendly Fire is active across both PvPvE and PvE shards: hitting allied PMCs or
   * neutral/trusted sub-faction operators physically damages/kills them, returns standing penalties,
   * and triggers immediate hostile retaliation from the struck operator and sector squadmates.
   */
  public applyDamage(
    agentId: string,
    rawDamage: number,
    hitZone: AiHitZone,
    character: OpenWorldCharacter | null,
    impactDir?: Readonly<THREE.Vector3>,
  ): {
    hit: boolean;
    blockedFriendly: boolean;
    friendlyFire: boolean;
    standingPenalty: number;
    remainingHp: number;
    eliminated?: AiEliminationEvent;
  } {
    const agent = this.agentById.get(agentId);
    if (!agent || !agent.alive) {
      return {
        hit: false,
        blockedFriendly: false,
        friendlyFire: false,
        standingPenalty: 0,
        remainingHp: 0,
      };
    }

    const preRelation = this.getRelationForAgent(agent, character);
    let friendlyFire = false;
    let standingPenalty = 0;

    if (character) {
      const isPmc = agent.faction === 'pmc_alpha' || agent.faction === 'pmc_bravo';
      const isAlliedPmc =
        agent.faction === character.pmcFaction || (character.shardMode === 'PvE' && isPmc);

      if (isAlliedPmc) {
        friendlyFire = true;
        standingPenalty = 10;
        agent.retaliationHostile = true;
      } else if (!isPmc) {
        if (preRelation === 'allied' || preRelation === 'neutral') {
          friendlyFire = preRelation === 'allied';
          standingPenalty = preRelation === 'allied' ? 12 : 6;
        }
        this.provokedSubFactions.add(agent.faction);
        agent.neutralAlertStage = 'hostile';
        agent.rig.setWarningLaser(false);
      }
    }

    const mult = hitZone === 'head' ? 2.25 : hitZone === 'torso' ? 1.0 : 0.65;
    const finalDmg = Math.max(4, rawDamage * mult);
    agent.hp = Math.max(0, agent.hp - finalDmg);
    agent.alerted = true;
    agent.alertDecayTimer = 26;
    agent.flinchPitch = Math.min(0.42, agent.flinchPitch + (hitZone === 'head' ? 0.34 : 0.22));
    agent.hitFlinchRoll =
      (hitZone === 'head' ? 0.26 : 0.14) * (agent.strafeSign >= 0 ? 1 : -1);

    // Alert squadmates in same sector (and trigger retaliation if friendly fire occurred)
    for (let i = 0; i < this.agents.length; i++) {
      const mate = this.agents[i];
      if (mate.alive && mate.sectorId === agent.sectorId && mate.faction === agent.faction) {
        mate.alerted = true;
        mate.alertDecayTimer = 26;
        if (friendlyFire) {
          mate.retaliationHostile = true;
        }
      }
    }

    if (agent.hp <= 0) {
      if (friendlyFire) standingPenalty += 15;
      this.killAgentWithRagdoll(agent, hitZone, impactDir);

      let subFactionStandingDelta: AiEliminationEvent['subFactionStandingDelta'];
      if (agent.faction !== 'pmc_alpha' && agent.faction !== 'pmc_bravo') {
        const sf = SUB_FACTION_MAP[agent.faction];
        subFactionStandingDelta = {
          subFactionId: agent.faction,
          delta: friendlyFire ? -24 : -12,
          rivalId: sf.rivalId,
          rivalDelta: 6,
        };
      }

      return {
        hit: true,
        blockedFriendly: false,
        friendlyFire,
        standingPenalty,
        remainingHp: 0,
        eliminated: {
          agentId: agent.id,
          sectorId: agent.sectorId,
          faction: agent.faction,
          callsign: agent.callsign,
          bountyUsd: friendlyFire ? 0 : hitZone === 'head' ? 450 : 320,
          headshot: hitZone === 'head',
          subFactionStandingDelta,
        },
      };
    }

    return {
      hit: true,
      blockedFriendly: false,
      friendlyFire,
      standingPenalty,
      remainingHp: agent.hp,
    };
  }

  private killAgentWithRagdoll(
    agent: AiAgentRecord,
    hitZone: AiHitZone,
    impactDir?: Readonly<THREE.Vector3>,
  ): void {
    agent.alive = false;
    agent.deathAgeSec = 0;
    agent.respawnTimerSec = AI_RESPAWN_DELAY_SEC;
    agent.rig.muzzleFlash.visible = false;
    agent.rig.laserBeam.visible = false;
    agent.rig.flashlightGlow.visible = false;
    agent.rig.setWarningLaser(false);
    agent.reloading = false;

    agent.rig.resetRagdollPose();
    _spawnPos.set(agent.x, agent.y, agent.z);
    _velVec.set(agent.vx, 0, agent.vz);
    agent.ragdoll.initializeFromStandingPose(_spawnPos, agent.yaw, _velVec);

    if (impactDir && impactDir.lengthSq() > 1e-4) {
      _impDir.copy(impactDir).normalize();
    } else {
      _impDir.set(Math.sin(agent.yaw), 0.14, Math.cos(agent.yaw)).normalize();
    }
    const ragZone =
      hitZone === 'head' ? 'head' : hitZone === 'limb' ? 'leftLeg' : 'thorax';
    const impulseNs = hitZone === 'head' ? 5.6 : hitZone === 'limb' ? 3.2 : 4.4;
    agent.ragdoll.applyHitZoneImpulse(ragZone, _impDir, impulseNs);
  }

  /**
   * Finds the closest living hostile AI operator relative to a FOB Tier 3 AA/Mortar defense turret.
   */
  public findNearestHostileToPoint(
    x: number,
    z: number,
    radiusM: number,
    friendlyFaction: PmcFactionId,
    shardMode: ShardMode,
  ): { agentId: string; x: number; y: number; z: number; distM: number } | null {
    const rSq = radiusM * radiusM;
    let best: { agentId: string; x: number; y: number; z: number; distM: number } | null = null;
    let bestDistSq = rSq;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      if (a.faction === friendlyFaction) continue;
      if (shardMode === 'PvE' && (a.faction === 'pmc_alpha' || a.faction === 'pmc_bravo')) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = { agentId: a.id, x: a.x, y: a.y + 1.1, z: a.z, distM: Math.sqrt(dSq) };
      }
    }
    return best;
  }

  /**
   * Applies automated FOB Tier 3 AA/Mortar perimeter defense turret damage to a hostile AI unit.
   */
  public applyTurretDamage(
    agentId: string,
    damage: number,
    originX: number,
    originZ: number,
  ): { hit: boolean; killed: boolean; x: number; y: number; z: number } {
    const agent = this.agentById.get(agentId);
    if (!agent || !agent.alive) {
      return { hit: false, killed: false, x: 0, y: 0, z: 0 };
    }
    agent.hp = Math.max(0, agent.hp - Math.max(5, damage));
    agent.flinchPitch = Math.min(0.42, agent.flinchPitch + 0.25);
    agent.alerted = true;
    agent.alertDecayTimer = 20;
    if (agent.hp <= 0) {
      _impDir.set(agent.x - originX, 0.25, agent.z - originZ).normalize();
      this.killAgentWithRagdoll(agent, 'torso', _impDir);
      return { hit: true, killed: true, x: agent.x, y: agent.y, z: agent.z };
    }
    return { hit: true, killed: false, x: agent.x, y: agent.y, z: agent.z };
  }

  /**
   * Applies grenade blast splash damage to all nearby AI agents within blastRadiusM.
   */
  public applyExplosionSplash(
    cx: number,
    cy: number,
    cz: number,
    blastRadiusM: number,
    maxDamage: number,
    character: OpenWorldCharacter | null,
  ): AiEliminationEvent[] {
    const kills: AiEliminationEvent[] = [];
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const dist = Math.hypot(a.x - cx, a.y + 0.9 - cy, a.z - cz);
      if (dist > blastRadiusM) continue;
      const falloff = 1 - dist / blastRadiusM;
      _impDir.set(a.x - cx, 0.45, a.z - cz).normalize();
      const res = this.applyDamage(a.id, maxDamage * falloff, 'torso', character, _impDir);
      if (res.eliminated) kills.push(res.eliminated);
    }
    return kills;
  }

  private spawnAiTracer(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    let slot: PooledAiTracer | null = null;
    for (let i = 0; i < this.tracers.length; i++) {
      if (!this.tracers[i].active) {
        slot = this.tracers[i];
        break;
      }
    }
    if (!slot) slot = this.tracers[0];

    _dir.set(bx - ax, by - ay, bz - az);
    const len = Math.max(0.5, _dir.length());
    _mid.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _dir.multiplyScalar(1 / len);
    _quat.setFromUnitVectors(_up, _dir);

    slot.active = true;
    slot.life = 0.1;
    slot.mesh.visible = true;
    slot.mesh.position.copy(_mid);
    slot.mesh.quaternion.copy(_quat);
    slot.mesh.scale.set(1, len, 1);
  }

  /**
   * Per-frame Battle-parity AI simulation, 2-bone IK pose application, and terrain ragdoll stepping
   * (zero per-frame heap allocations; distance-gated <= 280m to preserve <=7.0ms frametime).
   */
  public update(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    playerIsFoot: boolean,
    playerAlive: boolean,
    flashlightOn: boolean,
    aiVisionConeMultiplier: number,
    isNight: boolean,
    character: OpenWorldCharacter | null,
    onDamagePlayer: (ev: AiDamageToPlayerEvent) => void,
    options?: AiUpdateOptions,
  ): void {
    // Fade pooled tracer beams
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tr.life -= dt;
      if (tr.life <= 0) {
        tr.active = false;
        tr.mesh.visible = false;
      }
    }

    this.elapsedClock += dt;
    this.frameParity = (this.frameParity + 1) & 1;
    this.activeHitMeshes.length = 0;
    this.activeHitMeshesReady = true;

    const visionRangeM = computeEffectiveAiVisionRange(
      aiVisionConeMultiplier,
      flashlightOn,
      isNight,
    );
    this.lastVisionRangeM = visionRangeM;
    _playerGazeTarget.set(playerX, playerY + 1.55, playerZ);

    let activeNearby = 0;
    let hostileEngaging = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];

      // 1. Dead agents: simulate ArticulatedRagdoll over 4km terrain, then hide & respawn cleanly
      if (!a.alive) {
        a.deathAgeSec += dt;
        a.respawnTimerSec -= dt;

        const distHorizDead = Math.hypot(playerX - a.x, playerZ - a.z);
        if (a.deathAgeSec < AI_RAGDOLL_VISIBLE_SEC && distHorizDead <= ACTIVE_SIM_RADIUS_M) {
          a.rig.root.visible = true;
          if (a.ragdoll.isActive()) {
            a.ragdoll.step(dt, this.ragdollWorld, (gx, gz) =>
              a.role === 'tower_sniper' ? a.postY : this.sampleGroundHeight(gx, gz),
            );
            a.ragdoll.syncToBotRig(
              a.rig.root,
              a.rig.bodyPivot,
              a.rig.leftLeg,
              a.rig.rightLeg,
              a.rig.leftArm,
              a.rig.rightArm,
            );
          }
        } else {
          a.rig.root.visible = false;
        }

        if (a.respawnTimerSec <= 0) {
          // Only respawn if player is > 160m away so enemies never pop in on top of player
          const distHome = Math.hypot(playerX - a.homeX, playerZ - a.homeZ);
          if (distHome > 160) {
            a.ragdoll.deactivate();
            a.rig.resetRagdollPose();
            a.alive = true;
            a.hp = a.maxHp;
            a.alerted = false;
            a.reloading = false;
            a.reloadTimer = 0;
            a.magAmmo = a.magCapacity;
            a.crouchBlend = 0;
            a.crouchTarget = 0;
            a.leanBlend = 0;
            a.adsBlend = a.role === 'tower_sniper' ? 0.65 : 0.25;
            a.recoilKick = 0;
            a.firingVibration = 0;
            a.flinchPitch = 0;
            a.hitFlinchRoll = 0;
            a.retaliationHostile = false;
            a.neutralAlertStage = 'calm';
            a.neutralWarningTimer = 0;
            a.aimPitch = 0;
            if (a.role === 'tower_sniper' || a.role === 'gate_guard') {
              a.x = a.postX;
              a.y = a.postY;
              a.z = a.postZ;
              a.yaw = a.postYaw;
            } else {
              a.x = a.homeX + Math.cos(a.patrolAngle) * a.patrolRadiusM;
              a.z = a.homeZ + Math.sin(a.patrolAngle) * a.patrolRadiusM;
              a.y = Math.max(
                SEA_LEVEL_M + 0.25,
                a.fobId ? a.postY : -999,
                this.sampleGroundHeight(a.x, a.z),
              );
            }
            a.rig.root.position.set(a.x, a.y, a.z);
            a.rig.root.rotation.set(0, a.yaw, 0);
          }
        }
        continue;
      }

      const dx = playerX - a.x;
      const dz = playerZ - a.z;
      const distHoriz = Math.hypot(dx, dz);

      if (distHoriz > ACTIVE_SIM_RADIUS_M) {
        a.rig.root.visible = false;
        a.rig.setWarningLaser(false);
        continue;
      }

      a.rig.root.visible = true;
      activeNearby++;
      for (let hmIdx = 0; hmIdx < a.rig.hitMeshes.length; hmIdx++) {
        this.activeHitMeshes.push(a.rig.hitMeshes[hmIdx]);
      }

      // Synchronize helmet IR strobe pulse for PMC friendly identification through NVGs
      const isPmcAgent = a.faction === 'pmc_alpha' || a.faction === 'pmc_bravo';
      if (isPmcAgent) {
        const strobeOn = (this.elapsedClock + i * 0.17) % 1.35 < 0.16;
        a.rig.setIrStrobe(true, strobeOn);
      }

      // Flip helmet NVG mount down automatically during Night Ops
      if (a.hasNvgMount && a.nvgFlipped !== isNight) {
        a.nvgFlipped = isNight;
        a.rig.setGearAppearance({ nvgFlipped: isNight });
      }

      if (a.muzzleFlashTimer > 0) {
        a.muzzleFlashTimer -= dt;
        if (a.muzzleFlashTimer <= 0) {
          a.rig.muzzleFlash.visible = false;
        }
      }

      // Decay recoil kick, firing vibration & hit flinch smoothly
      a.recoilKick = Math.max(0, a.recoilKick - dt * 5.8);
      a.firingVibration = Math.max(0, a.firingVibration - dt * 3.2);
      a.flinchPitch = Math.max(0, a.flinchPitch - dt * 2.8);
      a.hitFlinchRoll = THREE.MathUtils.damp(a.hitFlinchRoll, 0, 7.5, dt);
      if (a.neutralWarningVoiceCooldown > 0) {
        a.neutralWarningVoiceCooldown = Math.max(0, a.neutralWarningVoiceCooldown - dt);
      }

      // Step animated reload sequence when magazine runs dry
      if (a.reloading) {
        a.reloadTimer += dt;
        if (a.reloadTimer >= a.reloadDuration) {
          a.reloading = false;
          a.reloadTimer = 0;
          a.magAmmo = a.magCapacity;
        }
      }

      const agentVisionRangeM = a.visionRangeOverrideM
        ? Math.round(visionRangeM * (a.visionRangeOverrideM / BASE_AI_VISION_RANGE_M))
        : visionRangeM;

      const relation = this.getRelationForAgent(a, character);
      const isNeutralSubFaction =
        relation === 'neutral' && !isPmcAgent && playerAlive && playerIsFoot;
      const inVisionRange =
        playerAlive &&
        playerIsFoot &&
        (relation === 'hostile' || (isNeutralSubFaction && distHoriz <= 42)) &&
        distHoriz <= (a.alerted ? agentVisionRangeM * 1.25 : agentVisionRangeM);

      let losBlocked = false;
      if (inVisionRange && this.isLineOfSightBlocked) {
        a.losCheckTimer -= dt;
        if (a.losCheckTimer <= 0) {
          a.losCheckTimer = 0.1;
          a.cachedLosBlocked = this.isLineOfSightBlocked(
            a.x,
            a.y + 1.48,
            a.z,
            playerX,
            playerY - 0.1,
            playerZ,
          );
        }
        losBlocked = a.cachedLosBlocked;
      } else {
        a.cachedLosBlocked = false;
      }
      const canSeePlayer = inVisionRange && !losBlocked;

      // Neutral (-25..+49) Sub-Faction 3-stage warning state machine (calm -> warned -> hostile)
      let effectiveRelation = relation;
      if (isNeutralSubFaction) {
        const breached = distHoriz < 14.5 && !losBlocked;
        let aimedAt = false;
        if (
          !losBlocked &&
          distHoriz <= 38 &&
          distHoriz > 0.5 &&
          options?.playerAimDirX !== undefined &&
          options?.playerAimDirZ !== undefined
        ) {
          const toAgentX = -dx / distHoriz;
          const toAgentZ = -dz / distHoriz;
          const aimHorizLen = Math.hypot(options.playerAimDirX, options.playerAimDirZ);
          if (aimHorizLen > 0.05) {
            const dot =
              (options.playerAimDirX * toAgentX + options.playerAimDirZ * toAgentZ) / aimHorizLen;
            aimedAt = dot > (options.playerAds ? 0.945 : 0.978);
          }
        }

        if (breached || aimedAt) {
          const reason: 'aimed_at' | 'perimeter_breach' = aimedAt ? 'aimed_at' : 'perimeter_breach';
          if (a.neutralAlertStage === 'calm') {
            a.neutralAlertStage = 'warned';
            a.neutralWarningTimer = 0;
          }
          a.neutralWarningTimer += dt;
          a.rig.setWarningLaser(true, Math.min(36, Math.max(4, distHoriz)));
          if (a.neutralWarningVoiceCooldown <= 0 && options?.onNeutralWarning) {
            a.neutralWarningVoiceCooldown = 4.5;
            const sfName = SUB_FACTION_MAP[a.faction as SubFactionId]?.name ?? a.callsign;
            options.onNeutralWarning({
              agentId: a.id,
              subFactionId: a.faction as SubFactionId,
              callsign: a.callsign,
              reason,
              message:
                reason === 'aimed_at'
                  ? `${sfName} [${a.callsign}]: Lower your weapon! Final warning.`
                  : `${sfName} [${a.callsign}]: Restricted checkpoint perimeter — step back!`,
            });
          }
          if (a.neutralWarningTimer >= 3.5) {
            a.neutralAlertStage = 'hostile';
            this.provokedSubFactions.add(a.faction as SubFactionId);
            a.alerted = true;
            a.alertDecayTimer = 26;
            a.rig.setWarningLaser(false);
            effectiveRelation = 'hostile';
          }
        } else if (a.neutralAlertStage === 'warned') {
          a.neutralWarningTimer = Math.max(0, a.neutralWarningTimer - dt * 1.4);
          if (a.neutralWarningTimer <= 0) {
            a.neutralAlertStage = 'calm';
            a.rig.setWarningLaser(false);
          } else {
            a.rig.setWarningLaser(true, Math.min(36, Math.max(4, distHoriz)));
          }
        } else {
          a.rig.setWarningLaser(false);
        }
      } else {
        a.rig.setWarningLaser(false);
      }

      if (effectiveRelation === 'hostile' && canSeePlayer) {
        a.alerted = true;
        a.alertDecayTimer = 14;
      } else if (a.alerted) {
        a.alertDecayTimer -= dt;
        if (a.alertDecayTimer <= 0) {
          a.alerted = false;
        }
      }

      let moveSpeed = 0;
      let targetAds = a.role === 'tower_sniper' ? 0.68 : 0.22;
      let targetLean = 0;
      let targetPitch = 0;
      let targetHeadYaw = 0;
      let targetHeadPitch = 0;
      let sprinting = false;
      const prevX = a.x;
      const prevZ = a.z;

      if (
        effectiveRelation === 'hostile' &&
        a.alerted &&
        playerAlive &&
        playerIsFoot &&
        distHoriz < agentVisionRangeM * 1.35
      ) {
        hostileEngaging++;
        targetAds = a.reloading ? 0.15 : a.role === 'tower_sniper' ? 0.98 : 0.94;

        // Smoothly turn yaw & pitch toward player's actual elevation
        const targetYaw = Math.atan2(-dx, -dz);
        const yawDiff = Math.atan2(Math.sin(targetYaw - a.yaw), Math.cos(targetYaw - a.yaw));
        a.yaw += yawDiff * Math.min(1, dt * (a.role === 'tower_sniper' ? 8.5 : 11.0));
        targetHeadYaw = THREE.MathUtils.clamp(yawDiff * 0.85, -0.62, 0.62);

        const eyeDy = playerY - (a.y + 1.48);
        targetPitch = THREE.MathUtils.clamp(Math.atan2(eyeDy, Math.max(1.5, distHoriz)), -0.78, 0.65);
        targetHeadPitch = THREE.MathUtils.clamp(targetPitch * 0.25, -0.22, 0.22);

        if (a.role === 'tower_sniper') {
          // Tower sniper stays perched behind the elevated guard tower parapet without stepping off
          a.x = a.postX;
          a.y = a.postY;
          a.z = a.postZ;
          a.crouchTarget = a.reloading ? 0.78 : distHoriz > 95 ? 0.28 : 0;
          targetLean = 0;
        } else {
          // Alternate tactical crouch & strafe for realistic firefight silhouettes
          a.crouchTimer -= dt;
          if (a.crouchTimer <= 0) {
            a.crouchTarget = a.crouchTarget > 0.5 ? 0 : distHoriz > 24 ? 0.85 : 0;
            a.crouchTimer = 2.4 + ((i * 29) % 10) * 0.25;
          }

          a.strafeTimer -= dt;
          if (a.strafeTimer <= 0) {
            a.strafeSign *= -1;
            a.strafeTimer = 1.6 + ((i * 37) % 10) * 0.18;
          }
          targetLean = a.strafeSign * 0.28;

          const invDist = 1 / Math.max(0.001, distHoriz);
          const fx = dx * invDist;
          const fz = dz * invDist;
          const rx = -fz * a.strafeSign;
          const rz = fx * a.strafeSign;

          let push = 0;
          if (distHoriz > 55) push = 0.9;
          else if (distHoriz < 14) push = -0.65;

          const stepSpeed = a.crouchTarget > 0.5 ? 1.85 : distHoriz > 72 ? 3.85 : 2.75;
          sprinting = a.role !== 'gate_guard' && distHoriz > 72 && push > 0.5;
          const maxRoam = a.role === 'gate_guard' ? 14 : 64;
          const nextX = a.x + (fx * push + rx * 0.68) * stepSpeed * dt;
          const nextZ = a.z + (fz * push + rz * 0.68) * stepSpeed * dt;
          if (Math.hypot(nextX - a.homeX, nextZ - a.homeZ) <= maxRoam) {
            const nextY = this.sampleGroundHeight(nextX, nextZ);
            if (nextY > SEA_LEVEL_M + 0.3) {
              a.x = nextX;
              a.z = nextZ;
              a.y = nextY;
              moveSpeed = Math.hypot(a.x - prevX, a.z - prevZ) / Math.max(0.001, dt);
            }
          }
        }

        // Fire tactical bursts with real muzzle flash, recoil kick & reload cycle (only with clear LOS)
        a.fireCooldown -= dt;
        if (!a.reloading && !losBlocked && a.fireCooldown <= 0 && distHoriz <= agentVisionRangeM * 1.15) {
          a.magAmmo = Math.max(0, a.magAmmo - 1);
          a.fireCooldown =
            a.role === 'tower_sniper'
              ? 1.45 + ((i * 13) % 5) * 0.14
              : 0.55 + ((i * 19 + Math.floor(a.walkCycle * 3)) % 7) * 0.13;
          a.rig.muzzleFlash.visible = true;
          a.muzzleFlashTimer = 0.06;
          a.recoilKick = a.role === 'tower_sniper' ? 1.35 : 1.0;
          a.firingVibration = Math.min(1, a.firingVibration + 0.45);

          if (a.magAmmo <= 0) {
            a.reloading = true;
            a.reloadTimer = 0;
            a.crouchTarget = 0.9; // Drop to crouch while reloading mag
          }

          a.rig.muzzleFlash.getWorldPosition(_muzzleWorld);
          const spread = a.role === 'tower_sniper' ? 0.35 + distHoriz * 0.014 : 0.55 + distHoriz * 0.025;
          const missOffset = Math.sin(a.walkCycle * 11.7 + this.elapsedClock * 3.1 + i) * 0.5 * spread;
          this.spawnAiTracer(
            _muzzleWorld.x,
            _muzzleWorld.y,
            _muzzleWorld.z,
            playerX + missOffset,
            playerY - 0.18,
            playerZ - missOffset * 0.6,
          );

          const hitChance =
            a.role === 'tower_sniper'
              ? THREE.MathUtils.clamp(0.46 - distHoriz * 0.0021, 0.14, 0.44)
              : THREE.MathUtils.clamp(0.45 - distHoriz * 0.0032, 0.1, 0.42);
          const pseudoRand = Math.abs(Math.sin(this.elapsedClock * 7.3 + a.walkCycle * 19.31 + distHoriz * 0.73 + i * 2.1));
          if (pseudoRand < hitChance) {
            const sniperDmg = a.role === 'tower_sniper' ? 24 + Math.round(pseudoRand * 10) : 11 + Math.round(pseudoRand * 7);
            onDamagePlayer({
              agentId: a.id,
              attackerFaction: a.faction,
              attackerCallsign: a.callsign,
              damage: sniperDmg,
              distanceM: Math.round(distHoriz),
              originX: _muzzleWorld.x,
              originY: _muzzleWorld.y,
              originZ: _muzzleWorld.z,
            });
          }
        }
      } else if (isNeutralSubFaction && a.neutralAlertStage === 'warned') {
        // Hold ground, aim warning laser at player, and track with head + upper torso
        a.crouchTarget = 0;
        targetAds = 0.8;
        const targetYaw = Math.atan2(-dx, -dz);
        const yawDiff = Math.atan2(Math.sin(targetYaw - a.yaw), Math.cos(targetYaw - a.yaw));
        a.yaw += yawDiff * Math.min(1, dt * 8.0);
        targetHeadYaw = THREE.MathUtils.clamp(yawDiff, -0.68, 0.68);
        const eyeDy = playerY - (a.y + 1.48);
        targetPitch = THREE.MathUtils.clamp(Math.atan2(eyeDy, Math.max(1.5, distHoriz)), -0.45, 0.45);
        targetHeadPitch = THREE.MathUtils.clamp(targetPitch * 0.35, -0.25, 0.25);
      } else if (a.role === 'tower_sniper') {
        // Tower sniper scans outward sector horizontally while perched on watchtower deck
        a.x = a.postX;
        a.y = a.postY;
        a.z = a.postZ;
        a.crouchTarget = 0;
        targetAds = 0.65;
        targetPitch = -0.06;
        const scanYaw = a.postYaw + Math.sin(this.elapsedClock * 0.45 + i * 1.4) * 0.45;
        const yDiff = Math.atan2(Math.sin(scanYaw - a.yaw), Math.cos(scanYaw - a.yaw));
        a.yaw += yDiff * Math.min(1, dt * 3.5);
      } else if (a.role === 'gate_guard') {
        // On-foot gate guard patrols small checkpoint beat around boom gate, facing traffic when paused
        a.crouchTarget = 0;
        targetAds = a.alerted ? 0.55 : 0.22;
        a.patrolAngle += dt * (0.28 + (i % 2) * 0.08);
        const goalX = a.postX + Math.cos(a.patrolAngle) * a.patrolRadiusM;
        const goalZ = a.postZ + Math.sin(a.patrolAngle) * a.patrolRadiusM;
        const gx = goalX - a.x;
        const gz = goalZ - a.z;
        const gDist = Math.hypot(gx, gz);
        if (gDist > 0.25) {
          const walkSpeed = 1.25;
          const step = Math.min(gDist, walkSpeed * dt);
          const nx = a.x + (gx / gDist) * step;
          const nz = a.z + (gz / gDist) * step;
          const ny = a.fobId
            ? Math.max(a.postY, this.sampleGroundHeight(nx, nz))
            : this.sampleGroundHeight(nx, nz);
          if (ny > SEA_LEVEL_M + 0.25) {
            a.x = nx;
            a.z = nz;
            a.y = ny;
            const goalYaw = a.postYaw + Math.sin(this.elapsedClock * 0.5 + i) * 0.35;
            const yDiff = Math.atan2(Math.sin(goalYaw - a.yaw), Math.cos(goalYaw - a.yaw));
            a.yaw += yDiff * Math.min(1, dt * 4.5);
            moveSpeed = walkSpeed;
          }
        }
      } else {
        // Calm perimeter patrol orbit around home landmark
        a.crouchTarget = 0;
        targetAds = a.alerted ? 0.55 : 0.18;
        a.patrolAngle += dt * (0.14 + (i % 3) * 0.03);
        const goalX = a.homeX + Math.cos(a.patrolAngle) * a.patrolRadiusM;
        const goalZ = a.homeZ + Math.sin(a.patrolAngle) * a.patrolRadiusM;
        const gx = goalX - a.x;
        const gz = goalZ - a.z;
        const gDist = Math.hypot(gx, gz);
        if (gDist > 0.35) {
          const walkSpeed = 1.7;
          const step = Math.min(gDist, walkSpeed * dt);
          const nx = a.x + (gx / gDist) * step;
          const nz = a.z + (gz / gDist) * step;
          const ny = a.fobId
            ? Math.max(a.postY, this.sampleGroundHeight(nx, nz))
            : this.sampleGroundHeight(nx, nz);
          if (ny > SEA_LEVEL_M + 0.25) {
            a.x = nx;
            a.z = nz;
            a.y = ny;
            const goalYaw = Math.atan2(-gx, -gz);
            const yDiff = Math.atan2(Math.sin(goalYaw - a.yaw), Math.cos(goalYaw - a.yaw));
            a.yaw += yDiff * Math.min(1, dt * 6.5);
            moveSpeed = walkSpeed;
          }
        }
      }

      // Natural ambient perimeter head scan or close-proximity player glance when not engaging
      if (effectiveRelation !== 'hostile' && a.neutralAlertStage !== 'warned') {
        if (playerAlive && distHoriz < 22) {
          const toPlayerYaw = Math.atan2(-dx, -dz);
          const relYaw = Math.atan2(Math.sin(toPlayerYaw - a.yaw), Math.cos(toPlayerYaw - a.yaw));
          targetHeadYaw = THREE.MathUtils.clamp(relYaw, -0.62, 0.62);
          const eyeDy = playerY - (a.y + 1.48);
          targetHeadPitch = THREE.MathUtils.clamp(Math.atan2(eyeDy, Math.max(2, distHoriz)) * 0.5, -0.28, 0.28);
        } else {
          targetHeadYaw = Math.sin(this.elapsedClock * 0.72 + i * 2.13) * 0.34;
          targetHeadPitch = Math.sin(this.elapsedClock * 0.41 + i * 1.17) * 0.06;
        }
      }

      a.vx = (a.x - prevX) / Math.max(0.001, dt);
      a.vz = (a.z - prevZ) / Math.max(0.001, dt);
      a.speedMps = THREE.MathUtils.damp(a.speedMps, moveSpeed, 10, dt);
      a.sprint = sprinting;
      a.crouchBlend = THREE.MathUtils.damp(a.crouchBlend, a.crouchTarget, 8, dt);
      a.leanBlend = THREE.MathUtils.damp(a.leanBlend, targetLean, 9, dt);
      a.adsBlend = THREE.MathUtils.damp(a.adsBlend, targetAds, 9, dt);
      a.aimPitch = THREE.MathUtils.damp(a.aimPitch, targetPitch, 10, dt);
      a.headYaw = THREE.MathUtils.damp(a.headYaw, targetHeadYaw, 7.5, dt);
      a.headPitchOffset = THREE.MathUtils.damp(a.headPitchOffset, targetHeadPitch, 7.5, dt);
      a.headRollOffset = THREE.MathUtils.damp(
        a.headRollOffset,
        a.hitFlinchRoll + a.leanBlend * 0.14,
        8.5,
        dt,
      );

      if (a.speedMps > 0.12) {
        const strideFreq = a.sprint ? 2.9 : a.crouchBlend > 0.5 ? 2.4 : 2.65;
        a.walkCycle += dt * a.speedMps * strideFreq;
      }

      // Apply world transform & distance-tiered Battle-mode 2-bone IK TacticalCombatPose
      a.rig.root.position.set(a.x, a.y, a.z);
      a.rig.root.rotation.set(0, a.yaw, 0);

      const updatePoseNow =
        distHoriz <= 55 ||
        a.reloading ||
        a.muzzleFlashTimer > 0 ||
        a.alerted ||
        a.neutralAlertStage === 'warned' ||
        (i & 1) === this.frameParity;
      if (updatePoseNow) {
        const reloadProgress = a.reloading
          ? THREE.MathUtils.clamp(a.reloadTimer / Math.max(0.1, a.reloadDuration), 0, 1)
          : 0;
        const reloadBlend = a.reloading
          ? Math.sin(reloadProgress * Math.PI)
          : 0;

        _poseScratch.crouchBlend = a.crouchBlend;
        _poseScratch.leanBlend = a.leanBlend;
        _poseScratch.aimPitch = a.aimPitch;
        _poseScratch.adsBlend = a.adsBlend;
        _poseScratch.pointAimBlend = 0;
        _poseScratch.cantBlend = 0;
        _poseScratch.reloadBlend = reloadBlend;
        _poseScratch.speedMps = a.speedMps;
        _poseScratch.walkCycle = a.walkCycle;
        _poseScratch.sprint = a.sprint;
        _poseScratch.recoilKick = a.recoilKick;
        _poseScratch.firingVibration = a.firingVibration * 0.04;
        _poseScratch.flinchPitch = a.flinchPitch;
        _poseScratch.handlingAction = a.reloading ? 'RELOAD' : 'NONE';
        _poseScratch.handlingProgress = reloadProgress;
        _poseScratch.headYaw = a.headYaw;
        _poseScratch.headPitchOffset = a.headPitchOffset;
        _poseScratch.headRollOffset = a.headRollOffset;
        _poseScratch.torsoYawOffset = a.speedMps > 0.25 ? Math.sin(a.walkCycle) * 0.045 : 0;
        _poseScratch.dt = dt;
        _poseScratch.distanceToCameraM = distHoriz;
        _poseScratch.gazeTargetWorld =
          a.alerted || a.neutralAlertStage !== 'calm' ? _playerGazeTarget : null;
        _poseScratch.isVisible = a.rig.root.visible;
        _poseScratch.injury01 = THREE.MathUtils.clamp(1 - a.hp / Math.max(1, a.maxHp), 0, 1);
        _poseScratch.flinchImpulse01 = Math.min(1, a.flinchPitch * 4);
        _poseScratch.stress01 = a.alerted
          ? 0.85
          : a.neutralAlertStage === 'warned'
            ? 0.55
            : 0.15;
        _poseScratch.facialIntent =
          a.hp < a.maxHp * 0.4
            ? 'injured'
            : a.recoilKick > 0.2
              ? 'suppressed'
              : a.adsBlend > 0.45
                ? 'aiming'
                : a.alerted || a.neutralAlertStage === 'warned'
                  ? 'alert'
                  : 'calm';
        a.rig.applyCombatPose(_poseScratch);
      }
    }

    this.activeNearbyCount = activeNearby;
    this.hostileEngagingCount = hostileEngaging;
  }

  /**
   * Determines whether the AI gate guards raise a FOB's motorized checkpoint boom gate:
   * - If living allied gate guards are on post: opens when player approaches within 24m.
   * - If living hostile gate guards are on post: remains locked closed.
   * - If all gate guards have been eliminated: unlocks when player walks within 8m.
   */
  public evaluateFobGateControl(
    fobId: FobCompoundId,
    playerX: number,
    playerZ: number,
    playerAlive: boolean,
    character: OpenWorldCharacter | null,
  ): boolean {
    if (!playerAlive) return false;
    const spec = getFobCheckpointGateSpec(fobId);
    const distM = Math.hypot(playerX - spec.gateCenterX, playerZ - spec.gateCenterZ);

    let aliveGuards = 0;
    let alliedPresent = false;
    let hostilePresent = false;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.fobId !== fobId || a.role !== 'gate_guard' || !a.alive) continue;
      aliveGuards++;
      const rel = this.getRelationForAgent(a, character);
      if (rel === 'hostile') hostilePresent = true;
      else alliedPresent = true;
    }

    if (hostilePresent) return false;
    if (aliveGuards > 0 && alliedPresent) return distM <= 24;
    return distM <= 8.5;
  }

  public getAliveAgents(): readonly AiAgentRecord[] {
    return this.agents;
  }

  public getTelemetry(): AiSummaryTelemetry {
    let totalAlive = 0;
    for (let i = 0; i < this.agents.length; i++) {
      if (this.agents[i].alive) totalAlive++;
    }
    return {
      totalAlive,
      activeNearby: this.activeNearbyCount,
      hostileEngaging: this.hostileEngagingCount,
      effectiveVisionRangeM: this.lastVisionRangeM,
    };
  }

  public resetProvocations(): void {
    this.provokedSubFactions.clear();
    for (let i = 0; i < this.agents.length; i++) {
      this.agents[i].retaliationHostile = false;
      this.agents[i].neutralAlertStage = 'calm';
      this.agents[i].neutralWarningTimer = 0;
      this.agents[i].rig.setWarningLaser(false);
    }
  }

  public dispose(): void {
    if (this.rootGroup.parent) {
      this.rootGroup.parent.remove(this.rootGroup);
    }
    for (let i = 0; i < this.agents.length; i++) {
      this.agents[i].ragdoll.deactivate();
      this.agents[i].rig.disposeWeapon();
    }
    this.rigFactory.dispose();
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
    this.agents.length = 0;
    this.agentById.clear();
    this.hitMeshes.length = 0;
    this.activeHitMeshes.length = 0;
    this.tracers.length = 0;
  }
}
