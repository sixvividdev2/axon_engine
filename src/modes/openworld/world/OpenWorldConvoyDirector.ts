import * as THREE from 'three';
import type { CharacterRoster } from '../CharacterRoster';
import type { ShardStore } from '../ShardStore';
import {
  FactionSupplyPool,
  OpenWorldCharacter,
  PMC_FACTIONS,
  PmcFactionId,
} from '../types';
import { SEA_LEVEL_M } from './OpenWorldTerrain';

export type LogisticsUnitKind = 'convoy_truck' | 'supply_barge';
export type LogisticsUnitState = 'en_route' | 'disabled_awaiting_action' | 'hijacked' | 'sabotaged';

export interface ConvoyEscortGuard {
  readonly guardId: string;
  readonly convoyId: string;
  readonly meshGroup: THREE.Group;
  readonly hitMesh: THREE.Mesh;
  hp: number;
  alive: boolean;
  offsetX: number;
  offsetZ: number;
  fireCooldown: number;
}

export interface LogisticsUnitRuntime {
  readonly id: string;
  readonly kind: LogisticsUnitKind;
  readonly label: string;
  ownerFaction: PmcFactionId;
  state: LogisticsUnitState;
  readonly waypoints: ReadonlyArray<{ x: number; z: number }>;
  waypointIndex: number;
  segmentProgress: number;
  speedMps: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  readonly group: THREE.Group;
  readonly strobeMat: THREE.MeshStandardMaterial;
  readonly guards: ConvoyEscortGuard[];
  escortBonusPaid: boolean;
  respawnCooldownSec: number;
  supplyPayload: Partial<FactionSupplyPool>;
}

export interface ConvoySummaryTelemetry {
  id: string;
  kind: LogisticsUnitKind;
  label: string;
  ownerFaction: PmcFactionId;
  state: LogisticsUnitState;
  x: number;
  z: number;
  aliveEscorts: number;
  totalEscorts: number;
}

export interface ConvoyInteractPrompt {
  convoyId: string;
  label: string;
  sublabel: string;
  distanceM: number;
  canHijackOrSabotage: boolean;
  blockedReason?: string;
}

const ROUTE_ALPHA_CONVOY: ReadonlyArray<{ x: number; z: number }> = [
  { x: -1080, z: 660 },
  { x: -640, z: 460 },
  { x: -160, z: 240 },
  { x: 460, z: 420 },
  { x: -160, z: 240 },
  { x: -640, z: 460 },
];

const ROUTE_BRAVO_CONVOY: ReadonlyArray<{ x: number; z: number }> = [
  { x: 1120, z: -610 },
  { x: 520, z: -390 },
  { x: -120, z: -640 },
  { x: 180, z: -1260 },
  { x: 480, z: -380 },
];

const ROUTE_COASTAL_BARGE: ReadonlyArray<{ x: number; z: number }> = [
  { x: -940, z: 1460 },
  { x: -540, z: 1360 },
  { x: 80, z: 1340 },
  { x: 420, z: 1220 },
  { x: -140, z: 1390 },
];

/**
 * Phase 4 Physical AI Supply Convoys & Coastal/River Supply Barges.
 * - Armored supply trucks traverse highway corridors with 3 ground escort guards.
 * - Flat-deck supply barges cruise the coastal delta with 2 deck/shore escort guards.
 * - Friendly units grant escort bonuses; hostile units halt once escorts are disabled,
 *   allowing the operator to press [F] to Hijack/Reroute cargo or Sabotage fuel/cargo.
 * - Zero per-frame heap allocations; explicit `.dispose()`.
 */
export class OpenWorldConvoyDirector {
  public readonly rootGroup = new THREE.Group();
  public readonly hitMeshes: THREE.Object3D[] = [];

  private readonly units: LogisticsUnitRuntime[] = [];
  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];
  private readonly sampleGroundHeight: (x: number, z: number) => number;
  private strobePhase = 0;

  constructor(
    scene: THREE.Scene,
    sampleGroundHeight: (x: number, z: number) => number,
  ) {
    this.sampleGroundHeight = sampleGroundHeight;
    this.rootGroup.name = 'openworld_supply_convoys';
    scene.add(this.rootGroup);
    this.initUnits();
  }

  private initUnits(): void {
    // Shared truck & barge geometries (low draw-call modular composites)
    const cabGeo = new THREE.BoxGeometry(2.45, 1.9, 2.3);
    const bedGeo = new THREE.BoxGeometry(2.55, 2.0, 4.9);
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.42, 10);
    wheelGeo.rotateZ(Math.PI * 0.5);
    const bargeHullGeo = new THREE.BoxGeometry(5.6, 1.35, 12.5);
    const bargeCabinGeo = new THREE.BoxGeometry(3.4, 2.1, 2.6);
    const crateGeo = new THREE.BoxGeometry(2.1, 1.35, 2.6);
    const strobeGeo = new THREE.OctahedronGeometry(0.32, 0);

    // Escort guard visual + hitbox
    const guardBodyGeo = new THREE.CapsuleGeometry(0.32, 0.95, 4, 8);
    const guardHeadGeo = new THREE.SphereGeometry(0.21, 8, 6);

    this.sharedGeos.push(
      cabGeo,
      bedGeo,
      wheelGeo,
      bargeHullGeo,
      bargeCabinGeo,
      crateGeo,
      strobeGeo,
      guardBodyGeo,
      guardHeadGeo,
    );

    const alphaHullMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.72, metalness: 0.35 });
    const bravoHullMat = new THREE.MeshStandardMaterial({ color: 0x4b4232, roughness: 0.78, metalness: 0.25 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x181a1d, roughness: 0.92, metalness: 0.08 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.82, metalness: 0.14 });
    const alphaGuardMat = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.85, metalness: 0.1 });
    const bravoGuardMat = new THREE.MeshStandardMaterial({ color: 0x5c3b1e, roughness: 0.85, metalness: 0.1 });

    this.sharedMats.push(
      alphaHullMat,
      bravoHullMat,
      tireMat,
      crateMat,
      alphaGuardMat,
      bravoGuardMat,
    );

    const buildUnit = (
      id: string,
      kind: LogisticsUnitKind,
      label: string,
      ownerFaction: PmcFactionId,
      waypoints: ReadonlyArray<{ x: number; z: number }>,
      speedMps: number,
      escortCount: number,
      supplyPayload: Partial<FactionSupplyPool>,
    ) => {
      const g = new THREE.Group();
      g.name = `logistics_${id}`;
      const hullMat = ownerFaction === 'pmc_alpha' ? alphaHullMat : bravoHullMat;
      const strobeMat = new THREE.MeshStandardMaterial({
        color: ownerFaction === 'pmc_alpha' ? 0x38bdf8 : 0xf59e0b,
        emissive: ownerFaction === 'pmc_alpha' ? 0x0284c7 : 0xd97706,
        emissiveIntensity: 1.0,
        roughness: 0.25,
      });
      this.sharedMats.push(strobeMat);

      if (kind === 'convoy_truck') {
        const cab = new THREE.Mesh(cabGeo, hullMat);
        cab.position.set(0, 1.55, -2.55);
        const bed = new THREE.Mesh(bedGeo, crateMat);
        bed.position.set(0, 1.75, 1.25);
        const strobe = new THREE.Mesh(strobeGeo, strobeMat);
        strobe.position.set(0, 2.95, -2.4);
        g.add(cab, bed, strobe);

        const wheelCoords: ReadonlyArray<[number, number]> = [
          [-1.25, -2.5],
          [1.25, -2.5],
          [-1.25, 0.8],
          [1.25, 0.8],
          [-1.25, 2.7],
          [1.25, 2.7],
        ];
        for (const [wx, wz] of wheelCoords) {
          const w = new THREE.Mesh(wheelGeo, tireMat);
          w.position.set(wx, 0.55, wz);
          g.add(w);
        }
      } else {
        const hull = new THREE.Mesh(bargeHullGeo, hullMat);
        hull.position.set(0, 0.5, 0);
        const cabin = new THREE.Mesh(bargeCabinGeo, hullMat);
        cabin.position.set(0, 2.0, 4.1);
        const c1 = new THREE.Mesh(crateGeo, crateMat);
        c1.position.set(-1.1, 1.85, -1.2);
        const c2 = new THREE.Mesh(crateGeo, crateMat);
        c2.position.set(1.1, 1.85, -1.8);
        const strobe = new THREE.Mesh(strobeGeo, strobeMat);
        strobe.position.set(0, 3.45, 4.1);
        g.add(hull, cabin, c1, c2, strobe);
      }

      const start = waypoints[0];
      const startY =
        kind === 'supply_barge'
          ? SEA_LEVEL_M + 0.1
          : Math.max(SEA_LEVEL_M + 0.25, this.sampleGroundHeight(start.x, start.z));
      g.position.set(start.x, startY, start.z);
      this.rootGroup.add(g);

      const guards: ConvoyEscortGuard[] = [];
      const guardMat = ownerFaction === 'pmc_alpha' ? alphaGuardMat : bravoGuardMat;
      const escortOffsets: ReadonlyArray<[number, number]> =
        kind === 'supply_barge'
          ? [
              [-1.8, -3.5],
              [1.8, 1.8],
            ]
          : [
              [-3.2, -1.8],
              [3.2, -1.8],
              [0, 5.2],
            ];

      for (let i = 0; i < escortCount; i++) {
        const [ox, oz] = escortOffsets[i % escortOffsets.length];
        const guardId = `${id}_escort_${i}`;
        const gg = new THREE.Group();
        const body = new THREE.Mesh(guardBodyGeo, guardMat);
        body.position.y = 0.92;
        body.userData = { openWorldConvoyGuardId: guardId, openWorldConvoyId: id };
        const head = new THREE.Mesh(guardHeadGeo, guardMat);
        head.position.y = 1.65;
        head.userData = { openWorldConvoyGuardId: guardId, openWorldConvoyId: id, hitZone: 'head' };
        gg.add(body, head);
        this.rootGroup.add(gg);
        this.hitMeshes.push(body, head);

        guards.push({
          guardId,
          convoyId: id,
          meshGroup: gg,
          hitMesh: body,
          hp: 90,
          alive: true,
          offsetX: ox,
          offsetZ: oz,
          fireCooldown: 1.5 + i * 0.4,
        });
      }

      this.units.push({
        id,
        kind,
        label,
        ownerFaction,
        state: 'en_route',
        waypoints,
        waypointIndex: 0,
        segmentProgress: 0,
        speedMps,
        x: start.x,
        y: startY,
        z: start.z,
        yaw: 0,
        group: g,
        strobeMat,
        guards,
        escortBonusPaid: false,
        respawnCooldownSec: 0,
        supplyPayload,
      });
    };

    buildUnit(
      'convoy_alpha_route41',
      'convoy_truck',
      'Alpha Supply Convoy (Route 41)',
      'pmc_alpha',
      ROUTE_ALPHA_CONVOY,
      5.2,
      3,
      { ammo: 14, medical: 10 },
    );
    buildUnit(
      'convoy_bravo_highland',
      'convoy_truck',
      'Bravo Armored Convoy (Highland)',
      'pmc_bravo',
      ROUTE_BRAVO_CONVOY,
      5.0,
      3,
      { ammo: 16, fuelParts: 10 },
    );
    buildUnit(
      'barge_coastal_delta',
      'supply_barge',
      'Coastal Fuel & Parts Barge',
      'pmc_bravo',
      ROUTE_COASTAL_BARGE,
      3.8,
      2,
      { fuelParts: 16, intel: 8 },
    );
  }

  public update(
    dt: number,
    playerX: number,
    playerZ: number,
    character: OpenWorldCharacter | null,
    roster: CharacterRoster,
    shards: ShardStore,
  ): string | null {
    this.strobePhase += dt;
    let notification: string | null = null;

    for (let uIdx = 0; uIdx < this.units.length; uIdx++) {
      const u = this.units[uIdx];

      if (u.state === 'hijacked' || u.state === 'sabotaged') {
        u.respawnCooldownSec -= dt;
        if (u.respawnCooldownSec <= 0) {
          this.resetConvoy(u);
        }
        continue;
      }

      const aliveEscorts = this.countAliveEscorts(u);
      if (aliveEscorts === 0 && u.state === 'en_route') {
        u.state = 'disabled_awaiting_action';
        notification = `${u.label} escort neutralized! Approach & press [F] to Hijack/Reroute or Sabotage.`;
      }

      if (u.state === 'disabled_awaiting_action') {
        const pulse = Math.sin(this.strobePhase * 8.0) > 0 ? 2.2 : 0.2;
        u.strobeMat.color.setHex(0xf59e0b);
        u.strobeMat.emissive.setHex(0xd97706);
        u.strobeMat.emissiveIntensity = pulse;
        continue;
      }

      // Advance along spline waypoints (zero-GC linear interpolation)
      const a = u.waypoints[u.waypointIndex];
      const nextIdx = (u.waypointIndex + 1) % u.waypoints.length;
      const b = u.waypoints[nextIdx];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.max(1, Math.hypot(dx, dz));
      u.segmentProgress += (u.speedMps * dt) / segLen;

      if (u.segmentProgress >= 1) {
        u.segmentProgress -= 1;
        u.waypointIndex = nextIdx;

        // Check friendly escort completion reward on waypoint arrival
        if (
          character &&
          u.ownerFaction === character.pmcFaction &&
          !u.escortBonusPaid &&
          Math.hypot(playerX - u.x, playerZ - u.z) <= 55
        ) {
          u.escortBonusPaid = true;
          roster.adjustCash(character.slotId, 1800);
          shards.adjustPmcSupply(
            character.shardMode,
            character.pmcFaction,
            u.supplyPayload,
            'convoy_escort',
            `${character.callsign} escorted ${u.label} (+12 Supply, +$1,800)`,
          );
          notification = `CONVOY ESCORT COMPLETE: +$1,800 & PMC Supply Boost!`;
        }
      }

      const ca = u.waypoints[u.waypointIndex];
      const cb = u.waypoints[(u.waypointIndex + 1) % u.waypoints.length];
      u.x = ca.x + (cb.x - ca.x) * u.segmentProgress;
      u.z = ca.z + (cb.z - ca.z) * u.segmentProgress;
      u.yaw = Math.atan2(-(cb.x - ca.x), -(cb.z - ca.z));
      u.y =
        u.kind === 'supply_barge'
          ? SEA_LEVEL_M + 0.12 + Math.sin(this.strobePhase * 1.8 + uIdx) * 0.08
          : Math.max(SEA_LEVEL_M + 0.25, this.sampleGroundHeight(u.x, u.z));

      u.group.position.set(u.x, u.y, u.z);
      u.group.rotation.y = u.yaw;

      const cosY = Math.cos(u.yaw);
      const sinY = Math.sin(u.yaw);

      // Update escort guard positions around moving truck/barge
      for (let gIdx = 0; gIdx < u.guards.length; gIdx++) {
        const g = u.guards[gIdx];
        if (!g.alive) continue;
        const gx = u.x + g.offsetX * cosY + g.offsetZ * sinY;
        const gz = u.z - g.offsetX * sinY + g.offsetZ * cosY;
        const gy =
          u.kind === 'supply_barge'
            ? u.y + 1.15
            : Math.max(SEA_LEVEL_M + 0.2, this.sampleGroundHeight(gx, gz));
        g.meshGroup.position.set(gx, gy, gz);
        g.meshGroup.rotation.y = u.yaw;
      }
    }

    return notification;
  }

  public applyDamageToGuard(
    guardId: string,
    damage: number,
    character: OpenWorldCharacter | null,
  ): { hit: boolean; killed: boolean; convoyDisabled: boolean; label: string; blockedFriendly: boolean } {
    for (const u of this.units) {
      for (const g of u.guards) {
        if (g.guardId !== guardId || !g.alive) continue;
        if (character && u.ownerFaction === character.pmcFaction) {
          return {
            hit: false,
            killed: false,
            convoyDisabled: false,
            label: u.label,
            blockedFriendly: true,
          };
        }
        g.hp -= damage;
        if (g.hp <= 0) {
          g.alive = false;
          g.meshGroup.visible = false;
          const remaining = this.countAliveEscorts(u);
          if (remaining === 0 && u.state === 'en_route') {
            u.state = 'disabled_awaiting_action';
            return {
              hit: true,
              killed: true,
              convoyDisabled: true,
              label: u.label,
              blockedFriendly: false,
            };
          }
          return {
            hit: true,
            killed: true,
            convoyDisabled: false,
            label: u.label,
            blockedFriendly: false,
          };
        }
        return {
          hit: true,
          killed: false,
          convoyDisabled: false,
          label: u.label,
          blockedFriendly: false,
        };
      }
    }
    return { hit: false, killed: false, convoyDisabled: false, label: '', blockedFriendly: false };
  }

  /**
   * Neutralizes all escorts on a convoy (used by explosions or automated tests).
   */
  public disableEscort(convoyId: string): boolean {
    const u = this.units.find((c) => c.id === convoyId);
    if (!u) return false;
    for (const g of u.guards) {
      g.hp = 0;
      g.alive = false;
      g.meshGroup.visible = false;
    }
    u.state = 'disabled_awaiting_action';
    return true;
  }

  public findNearestInteractableConvoy(
    playerX: number,
    playerZ: number,
    character: OpenWorldCharacter | null,
  ): ConvoyInteractPrompt | null {
    if (!character) return null;
    let best: ConvoyInteractPrompt | null = null;
    let bestDist = 11.5;

    for (const u of this.units) {
      if (u.state === 'hijacked' || u.state === 'sabotaged') continue;
      if (u.ownerFaction === character.pmcFaction) continue;
      const d = Math.hypot(playerX - u.x, playerZ - u.z);
      if (d < bestDist) {
        bestDist = d;
        const alive = this.countAliveEscorts(u);
        const disabled = u.state === 'disabled_awaiting_action' || alive === 0;
        best = {
          convoyId: u.id,
          label: disabled
            ? `Hijack & Reroute ${u.label}`
            : `${u.label} (Escort Active)`,
          sublabel: disabled
            ? '[F] Hijack (+16 Supply, +$2,400) · [X] Sabotage Fuel (Stalls Enemy Restock +180s)'
            : `Disable ${alive} escort guard(s) before hijacking or sabotaging`,
          distanceM: d,
          canHijackOrSabotage: disabled,
          blockedReason: disabled ? undefined : `Neutralize ${alive} remaining escort guard(s) first.`,
        };
      }
    }
    return best;
  }

  public hijackAndRerouteConvoy(
    convoyId: string,
    character: OpenWorldCharacter,
    roster: CharacterRoster,
    shards: ShardStore,
  ): { ok: boolean; message: string } {
    const u = this.units.find((c) => c.id === convoyId);
    if (!u) return { ok: false, message: 'Convoy not found.' };
    if (u.state !== 'disabled_awaiting_action') {
      return { ok: false, message: 'Disable convoy escorts before hijacking.' };
    }

    u.state = 'hijacked';
    u.respawnCooldownSec = 150;
    u.group.visible = false;
    roster.adjustCash(character.slotId, 2400);
    shards.adjustPmcSupply(
      character.shardMode,
      character.pmcFaction,
      {
        ammo: (u.supplyPayload.ammo ?? 6) + 4,
        medical: (u.supplyPayload.medical ?? 4) + 2,
        fuelParts: (u.supplyPayload.fuelParts ?? 6) + 4,
        intel: (u.supplyPayload.intel ?? 4) + 2,
      },
      'convoy_hijack',
      `${character.callsign} hijacked & rerouted ${u.label} to ${PMC_FACTIONS[character.pmcFaction].shortName} (+$2,400)`,
    );
    return {
      ok: true,
      message: `CONVOY HIJACKED: ${u.label} rerouted to ${PMC_FACTIONS[character.pmcFaction].shortName} (+$2,400 & Major Supply Boost)`,
    };
  }

  public sabotageConvoy(
    convoyId: string,
    character: OpenWorldCharacter,
    roster: CharacterRoster,
    shards: ShardStore,
  ): { ok: boolean; message: string } {
    const u = this.units.find((c) => c.id === convoyId);
    if (!u) return { ok: false, message: 'Convoy not found.' };
    if (u.state !== 'disabled_awaiting_action') {
      return { ok: false, message: 'Disable convoy escorts before sabotaging cargo.' };
    }

    const enemyFaction = u.ownerFaction;
    u.state = 'sabotaged';
    u.respawnCooldownSec = 180;
    u.group.visible = false;
    roster.adjustCash(character.slotId, 1400);
    shards.adjustPmcSupply(
      character.shardMode,
      enemyFaction,
      { ammo: -15, fuelParts: -15 },
      'convoy_sabotage',
      `${character.callsign} sabotaged ${u.label} (-15 ${PMC_FACTIONS[enemyFaction].shortName} Supply)`,
    );
    shards.applyRestockPenalty(
      character.shardMode,
      enemyFaction,
      180,
      `${PMC_FACTIONS[enemyFaction].shortName} Trader restock stalled +180s from convoy sabotage`,
    );

    return {
      ok: true,
      message: `CARGO SABOTAGED: ${u.label} destroyed (+$1,400, -15 Enemy Supply, +180s Enemy Restock Stall)`,
    };
  }

  private resetConvoy(u: LogisticsUnitRuntime): void {
    u.state = 'en_route';
    u.waypointIndex = 0;
    u.segmentProgress = 0;
    u.escortBonusPaid = false;
    u.group.visible = true;
    for (const g of u.guards) {
      g.hp = 90;
      g.alive = true;
      g.meshGroup.visible = true;
    }
  }

  private countAliveEscorts(u: LogisticsUnitRuntime): number {
    let n = 0;
    for (let i = 0; i < u.guards.length; i++) {
      if (u.guards[i].alive) n++;
    }
    return n;
  }

  public getTelemetrySnapshot(): ConvoySummaryTelemetry[] {
    return this.units.map((u) => ({
      id: u.id,
      kind: u.kind,
      label: u.label,
      ownerFaction: u.ownerFaction,
      state: u.state,
      x: Math.round(u.x),
      z: Math.round(u.z),
      aliveEscorts: this.countAliveEscorts(u),
      totalEscorts: u.guards.length,
    }));
  }

  public dispose(): void {
    if (this.rootGroup.parent) {
      this.rootGroup.parent.remove(this.rootGroup);
    }
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
    this.hitMeshes.length = 0;
    this.units.length = 0;
  }
}
