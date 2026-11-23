import {
  ActiveWeatherConditionId,
  LobbyRoomState,
  OperatorUniformId,
  SyncedAimStance,
  SyncedHandlingAction,
  SyncedWeaponAttachments,
  VALID_SYNCED_HANDLING_ACTIONS,
} from '../data/multiplayer';

export interface CachedMatchState {
  powerOn: boolean;
  openedDoorIds: string[];
  unlockedZoneIds: string[];
  round: number;
  zombiesRemaining: number;
  updatedAt: number;
}

export function createDefaultMatchState(): CachedMatchState {
  return {
    powerOn: false,
    openedDoorIds: [],
    unlockedZoneIds: ['lobby', 'default'],
    round: 1,
    zombiesRemaining: 9,
    updatedAt: Date.now(),
  };
}

const HOST_ONLY_GAME_TYPES = new Set<string>([
  'game:bots_sync',
  'game:bot_fire',
  'game:bot_hit_player',
  'game:bot_comms',
  'game:zombies_sync',
  'game:zombie_spawn',
  'game:zombie_killed',
  'game:zombie_hit_player',
  'game:barrier_update',
  'game:round_complete',
  'game:map_interact',
  'game:map_interact_rejected',
  'game:match_sync',
  'game:env_sync',
]);

const ALLOWED_GAME_TYPES = new Set<string>([
  ...HOST_ONLY_GAME_TYPES,
  'game:state',
  'game:fire',
  'game:hit',
  'game:kill',
  'game:respawn',
  'game:bot_damage',
  'game:zombie_damage',
  'game:barrier_repair_request',
  'game:map_interact_request',
  'game:ping',
  'game:glass_shatter',
]);

const VALID_AIM_STANCES = new Set<SyncedAimStance>(['HIP', 'ADS', 'POINT_AIM', 'CANTED_ADS']);
const VALID_ADS_MODES = new Set<string>(['PRIMARY', 'CANTED', 'POINT_AIM']);
const VALID_UNIFORM_IDS = new Set<OperatorUniformId>(['team_a', 'team_b', 'ffa', 'infection']);
const VALID_WEATHERS = new Set<ActiveWeatherConditionId>([
  'clear',
  'sunny',
  'overcast',
  'rainy',
  'stormy',
]);

function clampFinite(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isFiniteCoord(val: unknown, bound = 2000): val is number {
  return typeof val === 'number' && Number.isFinite(val) && Math.abs(val) <= bound;
}

function isValidVec3(val: unknown, bound = 2000): val is [number, number, number] {
  return (
    Array.isArray(val) &&
    val.length === 3 &&
    isFiniteCoord(val[0], bound) &&
    isFiniteCoord(val[1], bound) &&
    isFiniteCoord(val[2], bound)
  );
}

function addUniqueCapped(list: string[], id: string, maxLen = 64): void {
  const clean = id.trim().slice(0, 64);
  if (!clean) return;
  if (!list.includes(clean) && list.length < maxLen) {
    list.push(clean);
  }
}

function sanitizeAttachmentSlotId(val: unknown): string | null | undefined {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val !== 'string') return undefined;
  const clean = val.trim().slice(0, 40);
  return clean.length > 0 ? clean : null;
}

export function sanitizeSyncedWeaponAttachments(
  raw: unknown,
): SyncedWeaponAttachments | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: SyncedWeaponAttachments = {};
  const o = sanitizeAttachmentSlotId(obj.o);
  if (o !== undefined) out.o = o;
  const m = sanitizeAttachmentSlotId(obj.m);
  if (m !== undefined) out.m = m;
  if (typeof obj.ss === 'boolean') out.ss = obj.ss;
  const u = sanitizeAttachmentSlotId(obj.u);
  if (u !== undefined) out.u = u;
  const g = sanitizeAttachmentSlotId(obj.g);
  if (g !== undefined) out.g = g;
  const r = sanitizeAttachmentSlotId(obj.r);
  if (r !== undefined) out.r = r;
  const c = sanitizeAttachmentSlotId(obj.c);
  if (c !== undefined) out.c = c;
  const mag = sanitizeAttachmentSlotId(obj.mag);
  if (mag !== undefined) out.mag = mag;
  return out;
}

export function sanitizeSyncedHandlingAction(raw: unknown): SyncedHandlingAction {
  if (
    typeof raw === 'string' &&
    VALID_SYNCED_HANDLING_ACTIONS.has(raw as SyncedHandlingAction)
  ) {
    return raw as SyncedHandlingAction;
  }
  return 'NONE';
}

export interface GameRelayResult {
  payload: Record<string, unknown>;
  /** When set, deliver only to this specific userId (e.g., Host for requests, requester for rejections) */
  targetUserId?: string;
  /** True when the room's cached matchState was mutated (door/power/round) and should be persisted */
  matchStateChanged: boolean;
}

/**
 * Shared server-side authority & payload validation guard used identically by both
 * Cloudflare Durable Object `LobbyRoomDO` and local Node preview `server.ts`.
 */
export function validateAndSanitizeGameMessage(
  parsed: Record<string, unknown>,
  st: LobbyRoomState,
  matchState: CachedMatchState,
  sender: { userId: string; username: string },
): GameRelayResult | null {
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (!ALLOWED_GAME_TYPES.has(type)) return null;

  // Gate all in-match game packets strictly on active match status & verified membership
  if (st.status !== 'in_match') return null;
  const senderMember = st.members.find((m) => m.userId === sender.userId);
  if (!senderMember) return null;

  const isHost = sender.userId === st.hostUserId;
  if (HOST_ONLY_GAME_TYPES.has(type) && !isHost) {
    return null;
  }

  const safePayload: Record<string, unknown> = {
    ...parsed,
    type,
    senderUserId: sender.userId,
    senderUsername: senderMember.username || sender.username,
    senderTeam: senderMember.team,
    senderIsHost: isHost,
  };

  let matchStateChanged = false;
  let targetUserId: string | undefined;

  if (type === 'game:state') {
    if (
      !isFiniteCoord(parsed.x) ||
      !isFiniteCoord(parsed.y) ||
      !isFiniteCoord(parsed.z) ||
      !isFiniteCoord(parsed.yaw, 100) ||
      !isFiniteCoord(parsed.pitch, 2.5)
    ) {
      return null;
    }
    safePayload.x = Number(parsed.x.toFixed(3));
    safePayload.y = Number(parsed.y.toFixed(3));
    safePayload.z = Number(parsed.z.toFixed(3));
    safePayload.yaw = Number(parsed.yaw.toFixed(4));
    safePayload.pitch = Number(parsed.pitch.toFixed(4));
    safePayload.crouch = Boolean(parsed.crouch);
    safePayload.sprint = Boolean(parsed.sprint);
    safePayload.ads = Boolean(parsed.ads);
    safePayload.adsMode =
      typeof parsed.adsMode === 'string' && VALID_ADS_MODES.has(parsed.adsMode)
        ? parsed.adsMode
        : 'PRIMARY';
    safePayload.aimStance =
      typeof parsed.aimStance === 'string' &&
      VALID_AIM_STANCES.has(parsed.aimStance as SyncedAimStance)
        ? parsed.aimStance
        : safePayload.ads
          ? 'ADS'
          : 'HIP';
    safePayload.isPointAim = Boolean(parsed.isPointAim);
    safePayload.isCanted = Boolean(parsed.isCanted);
    safePayload.adsBlend = Number(clampFinite(parsed.adsBlend, 0, 1, safePayload.ads ? 1 : 0).toFixed(3));
    safePayload.pointAimBlend = Number(
      clampFinite(parsed.pointAimBlend, 0, 1, safePayload.isPointAim ? 1 : 0).toFixed(3),
    );
    safePayload.isFiring = Boolean(parsed.isFiring);
    safePayload.isReloading = Boolean(parsed.isReloading);
    safePayload.fireSeq = Math.floor(clampFinite(parsed.fireSeq, 0, 1_000_000, 0));
    if (
      typeof parsed.uniformId === 'string' &&
      VALID_UNIFORM_IDS.has(parsed.uniformId as OperatorUniformId)
    ) {
      safePayload.uniformId = parsed.uniformId;
    } else {
      delete safePayload.uniformId;
    }
    if (typeof parsed.glovesEnabled === 'boolean') {
      safePayload.glovesEnabled = parsed.glovesEnabled;
    }
    if (typeof parsed.gloveColor === 'string') {
      safePayload.gloveColor = parsed.gloveColor.slice(0, 24);
    }
    if (parsed.helmetType === 'mich' || parsed.helmetType === 'mil_tec') {
      safePayload.helmetType = parsed.helmetType;
    }
    if (typeof parsed.helmetColor === 'string') {
      safePayload.helmetColor = parsed.helmetColor.slice(0, 24);
    }
    if (parsed.nvgMount === 'none' || parsed.nvgMount === 'pvs7' || parsed.nvgMount === 'arnvg') {
      safePayload.nvgMount = parsed.helmetType === 'mich' ? 'none' : parsed.nvgMount;
    }
    if (typeof parsed.nvgFlipped === 'boolean') {
      safePayload.nvgFlipped = parsed.nvgFlipped;
    }
    safePayload.lean = Number(clampFinite(parsed.lean, -1, 1, 0).toFixed(2));
    safePayload.weaponId = String(parsed.weaponId ?? 'm4a1').slice(0, 40);
    const cleanAtt = sanitizeSyncedWeaponAttachments(parsed.att);
    if (cleanAtt) {
      safePayload.att = cleanAtt;
    } else {
      delete safePayload.att;
    }
    safePayload.ha = sanitizeSyncedHandlingAction(parsed.ha);
    safePayload.hprog = Number(clampFinite(parsed.hprog, 0, 1, 0).toFixed(3));
    if (typeof parsed.sup === 'boolean') {
      safePayload.sup = parsed.sup;
    } else {
      delete safePayload.sup;
    }
    safePayload.hp = Math.round(clampFinite(parsed.hp, 0, 1000, 100));
    safePayload.maxHp = Math.round(clampFinite(parsed.maxHp, 1, 1000, 100));
    safePayload.alive = Boolean(parsed.alive);
    safePayload.kills = Math.floor(clampFinite(parsed.kills, 0, 10000, 0));
    safePayload.deaths = Math.floor(clampFinite(parsed.deaths, 0, 10000, 0));
    safePayload.flashlightOn = Boolean(parsed.flashlightOn);
    safePayload.laserOn = Boolean(parsed.laserOn);
  } else if (type === 'game:bots_sync') {
    if (Array.isArray(parsed.bots)) {
      safePayload.bots = parsed.bots.slice(0, 24).map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const b = entry as Record<string, unknown>;
        const cleanBot: Record<string, unknown> = { ...b };
        if (typeof b.weaponId === 'string') {
          cleanBot.weaponId = b.weaponId.slice(0, 40);
        }
        const bAtt = sanitizeSyncedWeaponAttachments(b.att);
        if (bAtt) cleanBot.att = bAtt;
        else delete cleanBot.att;
        if (b.ha !== undefined) {
          cleanBot.ha = sanitizeSyncedHandlingAction(b.ha);
        }
        if (b.hprog !== undefined) {
          cleanBot.hprog = Number(clampFinite(b.hprog, 0, 1, 0).toFixed(3));
        }
        if (typeof b.sup === 'boolean') {
          cleanBot.sup = b.sup;
        }
        return cleanBot;
      });
    }
  } else if (type === 'game:bot_fire') {
    if (
      !isFiniteCoord(parsed.ox) ||
      !isFiniteCoord(parsed.oy) ||
      !isFiniteCoord(parsed.oz) ||
      !isFiniteCoord(parsed.ex) ||
      !isFiniteCoord(parsed.ey) ||
      !isFiniteCoord(parsed.ez)
    ) {
      return null;
    }
    safePayload.botId = String(parsed.botId ?? '').slice(0, 40);
    if (typeof parsed.weaponId === 'string') {
      safePayload.weaponId = parsed.weaponId.slice(0, 40);
    }
    if (typeof parsed.caliberId === 'string') {
      safePayload.caliberId = parsed.caliberId.slice(0, 32);
    }
    if (typeof parsed.sup === 'boolean') {
      safePayload.sup = parsed.sup;
    }
  } else if (type === 'game:fire') {
    if (
      !isFiniteCoord(parsed.ox) ||
      !isFiniteCoord(parsed.oy) ||
      !isFiniteCoord(parsed.oz) ||
      !isFiniteCoord(parsed.dx, 2) ||
      !isFiniteCoord(parsed.dy, 2) ||
      !isFiniteCoord(parsed.dz, 2)
    ) {
      return null;
    }
    safePayload.weaponId = String(parsed.weaponId ?? 'm4a1').slice(0, 40);
    safePayload.weaponName = String(parsed.weaponName ?? 'RIFLE').slice(0, 64);
    safePayload.caliberId = String(parsed.caliberId ?? '556x45').slice(0, 32);
    safePayload.suppressed = Boolean(parsed.suppressed);
    if (
      typeof parsed.aimStance === 'string' &&
      VALID_AIM_STANCES.has(parsed.aimStance as SyncedAimStance)
    ) {
      safePayload.aimStance = parsed.aimStance;
    }
    if (typeof parsed.adsMode === 'string' && VALID_ADS_MODES.has(parsed.adsMode)) {
      safePayload.adsMode = parsed.adsMode;
    }
    if (parsed.shotSeq !== undefined) {
      safePayload.shotSeq = Math.floor(clampFinite(parsed.shotSeq, 0, 1_000_000, 0));
    }
  } else if (type === 'game:hit') {
    const targetId = String(parsed.targetUserId ?? '');
    const rawDmg = Number(parsed.damage ?? 0);
    if (!targetId || targetId === sender.userId || !Number.isFinite(rawDmg) || rawDmg <= 0) {
      return null;
    }
    safePayload.targetUserId = targetId;
    safePayload.damage = Math.max(1, Math.min(250, Math.round(rawDmg)));
  } else if (type === 'game:kill') {
    const killerId = String(parsed.killerUserId ?? '');
    const victimId = String(parsed.victimUserId ?? '');
    if (!killerId || !victimId) return null;

    const victimIsBot = victimId.startsWith('bot_');
    const killerIsBot = killerId.startsWith('bot_');
    if (victimIsBot && !isHost) {
      // Only Host can authorize bot eliminations
      return null;
    }
    if (killerIsBot && !isHost && victimId !== sender.userId) {
      return null;
    }
    if (!victimIsBot && !killerIsBot && !isHost) {
      // In PvP, only the eliminated victim (or Host) may report the kill, and killer must be a lobby member
      const killerInRoom = st.members.some((m) => m.userId === killerId);
      if (victimId !== sender.userId || !killerInRoom) {
        return null;
      }
    }
    safePayload.killerUserId = killerId;
    safePayload.victimUserId = victimId;
    safePayload.killerName = String(parsed.killerName ?? 'OPERATOR').slice(0, 48);
    safePayload.victimName = String(parsed.victimName ?? 'OPERATOR').slice(0, 48);
    safePayload.headshot = Boolean(parsed.headshot);
  } else if (type === 'game:respawn') {
    if (
      !isFiniteCoord(parsed.x) ||
      !isFiniteCoord(parsed.y) ||
      !isFiniteCoord(parsed.z) ||
      !isFiniteCoord(parsed.yaw, 100)
    ) {
      return null;
    }
    safePayload.hp = Math.round(clampFinite(parsed.hp, 1, 1000, 100));
    safePayload.maxHp = Math.round(clampFinite(parsed.maxHp, 1, 1000, 100));
    if (
      typeof parsed.uniformId === 'string' &&
      VALID_UNIFORM_IDS.has(parsed.uniformId as OperatorUniformId)
    ) {
      safePayload.uniformId = parsed.uniformId;
    }
  } else if (type === 'game:bot_damage' || type === 'game:zombie_damage') {
    const rawDmg = Number(parsed.damage ?? 0);
    if (!Number.isFinite(rawDmg) || rawDmg <= 0) return null;
    safePayload.damage = Math.max(1, Math.min(350, Math.round(rawDmg)));
  } else if (type === 'game:bot_hit_player' || type === 'game:zombie_hit_player') {
    const targetId = String(parsed.targetUserId ?? '');
    const rawDmg = Number(parsed.damage ?? 0);
    if (!targetId || !Number.isFinite(rawDmg) || rawDmg <= 0) return null;
    safePayload.targetUserId = targetId;
    safePayload.damage = Math.max(1, Math.min(150, Math.round(rawDmg)));
  } else if (type === 'game:barrier_repair_request') {
    const barrierId = String(parsed.barrierId ?? '').trim().slice(0, 64);
    if (!barrierId) return null;
    safePayload.barrierId = barrierId;
    targetUserId = st.hostUserId;
  } else if (type === 'game:barrier_update') {
    const barrierId = String(parsed.barrierId ?? '').trim().slice(0, 64);
    if (!barrierId) return null;
    safePayload.barrierId = barrierId;
    safePayload.planksRemaining = Math.floor(clampFinite(parsed.planksRemaining, 0, 12, 0));
    if (typeof parsed.repairedByUserId === 'string') {
      safePayload.repairedByUserId = parsed.repairedByUserId.trim().slice(0, 64);
    }
    if (parsed.pointsAwarded !== undefined) {
      safePayload.pointsAwarded = Math.floor(clampFinite(parsed.pointsAwarded, 0, 100, 0));
    }
  } else if (type === 'game:map_interact_request') {
    const kind = parsed.kind;
    const interactableId = String(parsed.interactableId ?? '').trim().slice(0, 64);
    const requestId = String(parsed.requestId ?? '').trim().slice(0, 96);
    if ((kind !== 'buyable_door' && kind !== 'power_switch') || !interactableId || !requestId) {
      return null;
    }
    safePayload.kind = kind;
    safePayload.interactableId = interactableId;
    safePayload.requestId = requestId;
    safePayload.cost = Math.round(clampFinite(parsed.cost, 0, 10000, 0));
    // Route silent validation request directly to Host
    targetUserId = st.hostUserId;
  } else if (type === 'game:map_interact') {
    const kind = parsed.kind;
    const interactableId = String(parsed.interactableId ?? '').trim().slice(0, 64);
    if ((kind !== 'buyable_door' && kind !== 'power_switch') || !interactableId) {
      return null;
    }
    safePayload.kind = kind;
    safePayload.interactableId = interactableId;
    if (kind === 'power_switch') {
      if (!matchState.powerOn) {
        matchState.powerOn = true;
        matchStateChanged = true;
      }
    } else {
      const prevDoors = matchState.openedDoorIds.length;
      addUniqueCapped(matchState.openedDoorIds, interactableId);
      if (matchState.openedDoorIds.length !== prevDoors) {
        matchStateChanged = true;
      }
      if (typeof parsed.unlockedZoneId === 'string' && parsed.unlockedZoneId.trim()) {
        const cleanZone = parsed.unlockedZoneId.trim().slice(0, 64);
        safePayload.unlockedZoneId = cleanZone;
        const prevZones = matchState.unlockedZoneIds.length;
        addUniqueCapped(matchState.unlockedZoneIds, cleanZone);
        if (matchState.unlockedZoneIds.length !== prevZones) {
          matchStateChanged = true;
        }
      }
    }
    matchState.updatedAt = Date.now();
  } else if (type === 'game:map_interact_rejected') {
    const rejTarget = String(parsed.targetUserId ?? '').trim();
    const interactableId = String(parsed.interactableId ?? '').trim().slice(0, 64);
    if (!rejTarget || !interactableId) return null;
    safePayload.targetUserId = rejTarget;
    safePayload.interactableId = interactableId;
    safePayload.refundPoints = Math.round(clampFinite(parsed.refundPoints, 0, 10000, 0));
    safePayload.reason = String(parsed.reason ?? 'Interaction unavailable').slice(0, 120);
    targetUserId = rejTarget;
  } else if (type === 'game:zombie_spawn') {
    const zombieId = String(parsed.zombieId ?? '').trim().slice(0, 64);
    const spawnerId = String(parsed.spawnerId ?? '').trim().slice(0, 64);
    const zoneId = String(parsed.zoneId ?? 'lobby').trim().slice(0, 64);
    if (
      !zombieId ||
      !spawnerId ||
      !isFiniteCoord(parsed.x) ||
      !isFiniteCoord(parsed.y) ||
      !isFiniteCoord(parsed.z) ||
      !isValidVec3(parsed.entryPos) ||
      !isFiniteCoord(parsed.yaw, 100)
    ) {
      return null;
    }
    safePayload.zombieId = zombieId;
    safePayload.spawnerId = spawnerId;
    safePayload.zoneId = zoneId;
    safePayload.x = Number(parsed.x.toFixed(3));
    safePayload.y = Number(parsed.y.toFixed(3));
    safePayload.z = Number(parsed.z.toFixed(3));
    safePayload.yaw = Number(parsed.yaw.toFixed(4));
    safePayload.round = Math.floor(clampFinite(parsed.round, 1, 999, 1));
    safePayload.maxHp = Math.round(clampFinite(parsed.maxHp, 1, 100000, 100));
    safePayload.zombiesRemaining = Math.floor(clampFinite(parsed.zombiesRemaining, 0, 9999, 0));
  } else if (type === 'game:zombies_sync') {
    const prevPower = matchState.powerOn;
    const prevRound = matchState.round;
    const prevDoors = matchState.openedDoorIds.length;
    const prevZones = matchState.unlockedZoneIds.length;

    if (typeof parsed.powerOn === 'boolean' && parsed.powerOn) {
      matchState.powerOn = true;
    }
    if (typeof parsed.round === 'number' && Number.isFinite(parsed.round)) {
      matchState.round = Math.max(1, Math.min(999, Math.floor(parsed.round)));
    }
    if (typeof parsed.zombiesRemaining === 'number' && Number.isFinite(parsed.zombiesRemaining)) {
      matchState.zombiesRemaining = Math.max(0, Math.min(9999, Math.floor(parsed.zombiesRemaining)));
    }
    if (Array.isArray(parsed.openedDoorIds)) {
      for (const id of parsed.openedDoorIds) {
        if (typeof id === 'string') addUniqueCapped(matchState.openedDoorIds, id);
      }
    }
    if (Array.isArray(parsed.unlockedZoneIds)) {
      for (const zid of parsed.unlockedZoneIds) {
        if (typeof zid === 'string') addUniqueCapped(matchState.unlockedZoneIds, zid);
      }
    }
    matchState.updatedAt = Date.now();
    if (
      matchState.powerOn !== prevPower ||
      matchState.round !== prevRound ||
      matchState.openedDoorIds.length !== prevDoors ||
      matchState.unlockedZoneIds.length !== prevZones
    ) {
      matchStateChanged = true;
    }
  } else if (type === 'game:ping') {
    const pingId = String(parsed.pingId ?? '').trim().slice(0, 48);
    const kind = parsed.kind;
    if (
      !pingId ||
      (kind !== 'location' && kind !== 'enemy' && kind !== 'item') ||
      !isFiniteCoord(parsed.x) ||
      !isFiniteCoord(parsed.y) ||
      !isFiniteCoord(parsed.z)
    ) {
      return null;
    }
    safePayload.pingId = pingId;
    safePayload.kind = kind;
    safePayload.label = String(parsed.label ?? 'MARK').trim().slice(0, 36) || 'MARK';
    safePayload.x = Number(parsed.x.toFixed(3));
    safePayload.y = Number(parsed.y.toFixed(3));
    safePayload.z = Number(parsed.z.toFixed(3));
    const entityType = parsed.targetEntityType;
    if (entityType === 'bot' || entityType === 'zombie' || entityType === 'remote_player') {
      safePayload.targetEntityType = entityType;
      safePayload.targetEntityId = String(parsed.targetEntityId ?? '').trim().slice(0, 64) || null;
    } else {
      safePayload.targetEntityType = null;
      safePayload.targetEntityId = null;
    }
  } else if (type === 'game:env_sync') {
    const cw = parsed.currentWeather as ActiveWeatherConditionId;
    const tw = parsed.targetWeather as ActiveWeatherConditionId;
    safePayload.timeOfDayHours = Number(clampFinite(parsed.timeOfDayHours, 0, 24, 12).toFixed(3));
    safePayload.currentWeather = VALID_WEATHERS.has(cw) ? cw : 'clear';
    safePayload.targetWeather = VALID_WEATHERS.has(tw) ? tw : safePayload.currentWeather;
    safePayload.transitionProgress = Number(clampFinite(parsed.transitionProgress, 0, 1, 1).toFixed(3));
    safePayload.weatherHoldRemainingSec = Number(clampFinite(parsed.weatherHoldRemainingSec, 0, 3600, 0).toFixed(1));
    safePayload.windDirRad = Number(clampFinite(parsed.windDirRad, -100, 100, 0).toFixed(3));
    safePayload.windSpeedMps = Number(clampFinite(parsed.windSpeedMps, 0, 45, 3).toFixed(2));
    safePayload.rainIntensity = Number(clampFinite(parsed.rainIntensity, 0, 1, 0).toFixed(3));
    safePayload.wetness = Number(clampFinite(parsed.wetness, 0, 1, 0).toFixed(3));
    safePayload.lightningFlash = Number(clampFinite(parsed.lightningFlash, 0, 2, 0).toFixed(3));
  } else if (type === 'game:glass_shatter') {
    const breakableId = String(parsed.breakableId ?? '').trim().slice(0, 80);
    if (!breakableId || !isFiniteCoord(parsed.px) || !isFiniteCoord(parsed.py) || !isFiniteCoord(parsed.pz)) {
      return null;
    }
    safePayload.breakableId = breakableId;
    safePayload.px = Number(parsed.px.toFixed(3));
    safePayload.py = Number(parsed.py.toFixed(3));
    safePayload.pz = Number(parsed.pz.toFixed(3));
  } else if (type === 'game:bot_comms') {
    const botId = String(parsed.botId ?? '').trim().slice(0, 32);
    const callsign = String(parsed.callsign ?? 'ALLY').trim().slice(0, 24);
    const text = String(parsed.text ?? '').trim().slice(0, 120);
    const cat = parsed.category;
    if (
      !botId ||
      !text ||
      (cat !== 'threat' && cat !== 'economy' && cat !== 'status' && cat !== 'ack')
    ) {
      return null;
    }
    safePayload.botId = botId;
    safePayload.callsign = callsign || 'ALLY';
    safePayload.team = parsed.team === 'A' || parsed.team === 'B' ? parsed.team : 'FFA';
    safePayload.category = cat;
    safePayload.text = text;
    if (
      (parsed.pingKind === 'location' || parsed.pingKind === 'enemy' || parsed.pingKind === 'item') &&
      isFiniteCoord(parsed.px) &&
      isFiniteCoord(parsed.py) &&
      isFiniteCoord(parsed.pz)
    ) {
      safePayload.pingKind = parsed.pingKind;
      safePayload.pingLabel = String(parsed.pingLabel ?? 'MARK').trim().slice(0, 32) || 'MARK';
      safePayload.px = Number(parsed.px.toFixed(3));
      safePayload.py = Number(parsed.py.toFixed(3));
      safePayload.pz = Number(parsed.pz.toFixed(3));
    } else {
      safePayload.pingKind = null;
      safePayload.pingLabel = null;
    }
  }

  return {
    payload: safePayload,
    targetUserId,
    matchStateChanged,
  };
}
