import * as THREE from 'three';
import {
  BodycamCapsuleSweepResult,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  BodycamTraumaModifiers,
  createCapsuleSweepResult,
  createRaycastResult,
  IBodycamWorldAdapter,
} from '../types';

export type VaultKind = 'VAULT_OVER' | 'CLIMB_ONTO' | 'HIGH_MANTLE';

export type VaultBlockReason = 'none' | 'dual_leg_trauma' | 'no_clearance' | 'unsafe_drop';

export interface VaultCandidate {
  valid: boolean;
  blockReason: VaultBlockReason;
  kind: VaultKind;
  ledgeHeight: number;
  obstacleDepth: number;
  surface: BodycamSurfaceMaterial;
  mustCrouchOnFinish: boolean;
  /** World-space bottom Y of any overhead lintel/window header above the sill (Infinity if open sky) */
  overheadCeilingY: number;
  /** True when crossing through a window frame or under a low overhang */
  isWindowBreach: boolean;
  entryPos: THREE.Vector3;
  apexPos: THREE.Vector3;
  landPos: THREE.Vector3;
  ledgeCenter: THREE.Vector3;
  wallNormal: THREE.Vector3;
  vaultForward: THREE.Vector3;
  handLWorld: THREE.Vector3;
  handRWorld: THREE.Vector3;
  breakableGlassObj: THREE.Object3D | null;
  glassImpactPoint: THREE.Vector3;
}

export function createVaultCandidate(): VaultCandidate {
  return {
    valid: false,
    blockReason: 'none',
    kind: 'VAULT_OVER',
    ledgeHeight: 0,
    obstacleDepth: 0,
    surface: 'concrete',
    mustCrouchOnFinish: false,
    overheadCeilingY: Infinity,
    isWindowBreach: false,
    entryPos: new THREE.Vector3(),
    apexPos: new THREE.Vector3(),
    landPos: new THREE.Vector3(),
    ledgeCenter: new THREE.Vector3(),
    wallNormal: new THREE.Vector3(0, 0, 1),
    vaultForward: new THREE.Vector3(0, 0, -1),
    handLWorld: new THREE.Vector3(),
    handRWorld: new THREE.Vector3(),
    breakableGlassObj: null,
    glassImpactPoint: new THREE.Vector3(),
  };
}

// Strict grounded tactical bounds (no wall-jumps, no superhuman leaps)
const MIN_VAULT_HEIGHT_M = 0.40;
const LOW_VAULT_MAX_HEIGHT_M = 1.15;
const HIGH_MANTLE_MAX_HEIGHT_M = 2.15;
const MAX_VAULT_OVER_DEPTH_M = 0.85;
const MIN_CROUCH_CLEARANCE_M = 1.00;
const MIN_STAND_CLEARANCE_M = 1.80;
const STAND_CAPSULE_H = 1.62;
const CROUCH_CAPSULE_H = 1.06;
const PLAYER_RADIUS_M = 0.34;
const MAX_SAFE_FAR_DROP_M = 3.20;
const MAX_DUAL_LEG_TRAUMA_HEIGHT_M = 1.50;

// Dense waist/chest coverage ensures thin 0.06m-0.10m horizontal railing bars and 0.40m crates are reliably detected
const FORWARD_PROBE_HEIGHTS = [0.36, 0.44, 0.58, 0.74, 0.88, 0.96, 1.05, 1.18, 1.42, 1.75, 2.05] as const;
// Starts at 0.035m so thin railings/fences (0.06m-0.14m thick) hit their top bar before probing deeper
const DOWN_PROBE_DEPTHS = [0.035, 0.15, 0.55, 0.95] as const;

/**
 * Multi-ray grounded tactical ledge & clearance prober.
 * Strictly portable: queries world geometry ONLY via `IBodycamWorldAdapter.raycast()`
 * and `sweepCapsule()` with zero per-frame allocations.
 */
export class VaultDetector {
  // Pre-allocated scratch buffers (zero GC)
  private readonly _fwd = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
  private readonly _downDir = new THREE.Vector3(0, -1, 0);
  private readonly _upDir = new THREE.Vector3(0, 1, 0);
  private readonly _frontHitPos = new THREE.Vector3();
  private readonly _testPos = new THREE.Vector3();
  private readonly _rayOut: BodycamRaycastResult = createRaycastResult();
  private readonly _sweepOut: BodycamCapsuleSweepResult = createCapsuleSweepResult();

  private isBreakableGlass(obj: THREE.Object3D | null): boolean {
    return Boolean(
      obj &&
        obj.userData &&
        (obj.userData.breakableGlass === true || obj.userData.isGlass === true),
    );
  }

  private isNoVaultGlass(obj: THREE.Object3D | null): boolean {
    return Boolean(
      obj &&
        obj.userData &&
        obj.userData.noVault === true &&
        obj.userData.shattered !== true,
    );
  }

  /**
   * Casts a ray skipping vaultable breakable glass panes (recording the first glass hit if found)
   * so window sills and openings behind breakable glass are probed accurately.
   * Intact glass flagged `noVault: true` is treated as an impassable solid barrier instead.
   */
  private raycastThroughGlass(
    adapter: IBodycamWorldAdapter,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    near: number,
    far: number,
    outHit: BodycamRaycastResult,
    candidate: VaultCandidate,
  ): boolean {
    if (!adapter.raycast(origin, dir, near, far, outHit)) {
      return false;
    }
    if (!this.isBreakableGlass(outHit.object) || this.isNoVaultGlass(outHit.object)) {
      return true;
    }

    // Record the breakable glass pane for shattering on vault entry
    if (!candidate.breakableGlassObj && outHit.object) {
      candidate.breakableGlassObj = outHit.object;
      candidate.glassImpactPoint.set(outHit.pointX, outHit.pointY, outHit.pointZ);
    }

    const stepPast = outHit.distance + 0.08;
    if (stepPast >= far) {
      outHit.hit = false;
      outHit.object = null;
      return false;
    }
    return adapter.raycast(origin, dir, stepPast, far, outHit);
  }

  /**
   * Measures minimum vertical clearance above a world point (x, baseY, z) using a 5-ray bundle
   * via `adapter.raycast()` (ignoring vaultable breakable glass panes).
   */
  private measureVerticalClearance(
    adapter: IBodycamWorldAdapter,
    x: number,
    baseY: number,
    z: number,
    radius: number,
    maxProbeM: number,
    candidate: VaultCandidate,
  ): number {
    let minClear = maxProbeM;
    const r = radius * 0.65;
    const startY = baseY + 0.08;

    for (let i = 0; i < 5; i++) {
      let ox = x;
      let oz = z;
      if (i === 1) ox += r;
      else if (i === 2) ox -= r;
      else if (i === 3) oz += r;
      else if (i === 4) oz -= r;

      this._rayOrigin.set(ox, startY, oz);
      if (this.raycastThroughGlass(adapter, this._rayOrigin, this._upDir, 0.01, maxProbeM, this._rayOut, candidate)) {
        const clearH = this._rayOut.distance + 0.08;
        if (clearH < minClear) {
          minClear = clearH;
        }
      }
    }
    return minClear;
  }

  /**
   * Validates that a player capsule can safely occupy `pos` with given height using `adapter.sweepCapsule()`.
   * Guarantees zero-stuck placement before committing to a vault/mantle.
   */
  private validateDestinationCapsule(
    adapter: IBodycamWorldAdapter,
    pos: THREE.Vector3,
    capsuleHeight: number,
  ): boolean {
    this._testPos.set(pos.x, pos.y + 0.03, pos.z);
    adapter.sweepCapsule(this._testPos, 0, -0.06, 0, PLAYER_RADIUS_M, capsuleHeight, 0.05, this._sweepOut);

    const driftXZ = Math.hypot(this._sweepOut.posX - pos.x, this._sweepOut.posZ - pos.z);
    if (driftXZ > 0.14) {
      return false;
    }
    if (this._sweepOut.hitCeiling) {
      return false;
    }
    // Check small forward & backward micro-sweeps to confirm capsule isn't wedged inside a solid box
    this._testPos.set(this._sweepOut.posX, this._sweepOut.posY + 0.02, this._sweepOut.posZ);
    adapter.sweepCapsule(this._testPos, 0, 0.02, 0, PLAYER_RADIUS_M * 0.94, capsuleHeight, 0, this._sweepOut);
    if (this._sweepOut.hitCeiling) {
      return false;
    }
    return true;
  }

  public detect(
    adapter: IBodycamWorldAdapter,
    playerPos: Readonly<THREE.Vector3>,
    torsoYaw: number,
    grounded: boolean,
    out: VaultCandidate,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): boolean {
    out.valid = false;
    out.blockReason = 'none';
    out.breakableGlassObj = null;
    out.overheadCeilingY = Infinity;
    out.isWindowBreach = false;

    // Horizontal player forward vector from torsoYaw
    this._fwd.set(-Math.sin(torsoYaw), 0, -Math.cos(torsoYaw)).normalize();

    const probeRange = grounded ? 0.96 : 1.16;

    // 1. Multi-height forward wall probes (0.42m to 2.08m) to locate a vertical climbable face
    let foundWall = false;
    let hitNoVaultBarrier = false;
    let closestWallDist = Infinity;
    let wallNX = 0;
    let wallNZ = 0;

    for (let i = 0; i < FORWARD_PROBE_HEIGHTS.length; i++) {
      const h = FORWARD_PROBE_HEIGHTS[i];
      this._rayOrigin.set(playerPos.x, playerPos.y + h, playerPos.z);

      if (!this.raycastThroughGlass(adapter, this._rayOrigin, this._fwd, 0.08, probeRange, this._rayOut, out)) {
        continue;
      }

      if (this.isNoVaultGlass(this._rayOut.object)) {
        hitNoVaultBarrier = true;
      }

      // Reject steep non-vaultable sloped faces (only crisp obstacle faces)
      if (Math.abs(this._rayOut.normalY) > 0.35) {
        continue;
      }

      // Project normal onto XZ and ensure the face is facing the player
      const nx = this._rayOut.normalX;
      const nz = this._rayOut.normalZ;
      const nLen = Math.hypot(nx, nz);
      if (nLen < 0.5) continue;
      const uNX = nx / nLen;
      const uNZ = nz / nLen;

      // Normal must oppose player forward direction (within ~58 deg cone)
      const facingDot = uNX * this._fwd.x + uNZ * this._fwd.z;
      if (facingDot > -0.52) continue;

      if (this._rayOut.distance < closestWallDist) {
        closestWallDist = this._rayOut.distance;
        this._frontHitPos.set(this._rayOut.pointX, playerPos.y, this._rayOut.pointZ);
        wallNX = uNX;
        wallNZ = uNZ;
        foundWall = true;
      }
    }

    if (hitNoVaultBarrier) {
      out.blockReason = 'no_clearance';
      return false;
    }

    if (!foundWall) {
      return false;
    }

    // Also probe slightly upward across the obstacle face to catch breakable window glass sitting above a solid sill
    out.wallNormal.set(wallNX, 0, wallNZ).normalize();
    out.vaultForward.set(-wallNX, 0, -wallNZ).normalize();
    // Right-handed basis: vaultForward x (0, 1, 0) = (-vaultForward.z, 0, vaultForward.x)
    this._right.set(-out.vaultForward.z, 0, out.vaultForward.x).normalize();

    // 2. Downward probes from +2.40m above feet at 0.035m (thin railings), 0.15m, 0.55m, and 0.95m past the front face
    const downOriginY = playerPos.y + 2.40;
    const downMaxDist = 2.68;

    let ledgeY = -Infinity;
    let ledgeSurface: BodycamSurfaceMaterial = 'concrete';
    const depthHitsY: [number, number, number, number] = [-Infinity, -Infinity, -Infinity, -Infinity];
    const depthHasTop: [boolean, boolean, boolean, boolean] = [false, false, false, false];

    for (let i = 0; i < DOWN_PROBE_DEPTHS.length; i++) {
      const depth = DOWN_PROBE_DEPTHS[i];
      const px = this._frontHitPos.x + out.vaultForward.x * depth;
      const pz = this._frontHitPos.z + out.vaultForward.z * depth;
      this._rayOrigin.set(px, downOriginY, pz);

      // Check from playerPos.y + 2.40 downward; if we hit an overhead lintel (like a window header),
      // probe again from slightly below the lintel to find the actual window sill or railing top!
      let hit = this.raycastThroughGlass(adapter, this._rayOrigin, this._downDir, 0.02, downMaxDist, this._rayOut, out);
      if (hit && this._rayOut.pointY - playerPos.y > HIGH_MANTLE_MAX_HEIGHT_M) {
        const underOriginY = Math.min(playerPos.y + 1.85, this._rayOut.pointY - 0.12);
        if (underOriginY > playerPos.y + MIN_VAULT_HEIGHT_M) {
          this._rayOrigin.set(px, underOriginY, pz);
          hit = this.raycastThroughGlass(
            adapter,
            this._rayOrigin,
            this._downDir,
            0.02,
            underOriginY - (playerPos.y - 0.4),
            this._rayOut,
            out,
          );
        } else {
          hit = false;
        }
      }

      if (hit) {
        depthHitsY[i] = this._rayOut.pointY;
        const isWalkableTop = this._rayOut.normalY >= 0.72;
        if (ledgeY === -Infinity) {
          if (i <= 1 && isWalkableTop && this._rayOut.pointY - playerPos.y >= MIN_VAULT_HEIGHT_M) {
            ledgeY = this._rayOut.pointY;
            ledgeSurface = this._rayOut.surface;
            depthHasTop[i] = true;
          }
        } else if (isWalkableTop && Math.abs(this._rayOut.pointY - ledgeY) <= 0.16) {
          depthHasTop[i] = true;
        }
      }
    }

    if (ledgeY === -Infinity) {
      return false;
    }

    const ledgeHeight = ledgeY - playerPos.y;
    if (ledgeHeight < MIN_VAULT_HEIGHT_M || ledgeHeight > HIGH_MANTLE_MAX_HEIGHT_M) {
      return false;
    }

    // Reject HIGH_MANTLE > 1.5m if both legs are fractured/blacked-out
    if (
      trauma &&
      trauma.leftLegImpairment >= 0.75 &&
      trauma.rightLegImpairment >= 0.75 &&
      ledgeHeight > MAX_DUAL_LEG_TRAUMA_HEIGHT_M
    ) {
      out.blockReason = 'dual_leg_trauma';
      return false;
    }

    // 3. Check for breakable window glass sitting directly above the sill along the crossing path
    for (let gh = 0.25; gh <= 0.90; gh += 0.32) {
      this._rayOrigin.set(
        this._frontHitPos.x - out.vaultForward.x * 0.25,
        ledgeY + gh,
        this._frontHitPos.z - out.vaultForward.z * 0.25,
      );
      if (adapter.raycast(this._rayOrigin, out.vaultForward, 0.02, 1.15, this._rayOut)) {
        if (this.isBreakableGlass(this._rayOut.object)) {
          out.breakableGlassObj = this._rayOut.object;
          out.glassImpactPoint.set(this._rayOut.pointX, this._rayOut.pointY, this._rayOut.pointZ);
          break;
        }
      }
    }

    // 4. Estimate obstacle thickness from the 0.035m / 0.15m / 0.55m / 0.95m downward probes
    let estimatedDepth = 0.35;
    if (depthHasTop[3]) {
      estimatedDepth = 1.10; // Solid deck >= 0.95m deep -> CLIMB_ONTO or HIGH_MANTLE
    } else if (depthHasTop[2]) {
      // Top exists at 0.55m but drops off before 0.95m -> refine at 0.78m
      const rx = this._frontHitPos.x + out.vaultForward.x * 0.78;
      const rz = this._frontHitPos.z + out.vaultForward.z * 0.78;
      this._rayOrigin.set(rx, ledgeY + 0.35, rz);
      const midHit = this.raycastThroughGlass(adapter, this._rayOrigin, this._downDir, 0.02, 0.6, this._rayOut, out);
      estimatedDepth = midHit && Math.abs(this._rayOut.pointY - ledgeY) <= 0.16 ? 0.88 : 0.62;
    } else if (depthHasTop[1]) {
      // Top exists at 0.15m and drops off by 0.55m -> barrier / window sill (~0.25-0.45m thick)
      estimatedDepth = 0.40;
    } else {
      // Top exists only at 0.035m -> thin guardrail / handrail / fence (< 0.15m thick)
      estimatedDepth = 0.10;
    }

    // 5. Overhead & window gap vertical clearance check over the ledge crossing point
    const crossX = this._frontHitPos.x + out.vaultForward.x * Math.min(0.32, estimatedDepth * 0.5);
    const crossZ = this._frontHitPos.z + out.vaultForward.z * Math.min(0.32, estimatedDepth * 0.5);
    const sillClearance = this.measureVerticalClearance(
      adapter,
      crossX,
      ledgeY,
      crossZ,
      PLAYER_RADIUS_M * 0.85,
      2.1,
      out,
    );

    if (sillClearance < MIN_CROUCH_CLEARANCE_M) {
      out.blockReason = 'no_clearance';
      return false;
    }

    // Verify no solid non-glass wall blocks the crossing gap horizontally at waist/chest above the sill
    this._rayOrigin.set(
      this._frontHitPos.x - out.vaultForward.x * 0.18,
      ledgeY + 0.48,
      this._frontHitPos.z - out.vaultForward.z * 0.18,
    );
    if (
      this.raycastThroughGlass(
        adapter,
        this._rayOrigin,
        out.vaultForward,
        0.02,
        Math.min(estimatedDepth, 0.85) + 0.55,
        this._rayOut,
        out,
      )
    ) {
      // Blocked by solid geometry across the gap
      out.blockReason = 'no_clearance';
      return false;
    }

    // 6. Classify into VAULT_OVER, CLIMB_ONTO, or HIGH_MANTLE and resolve destination
    let kind: VaultKind;
    let landX = 0;
    let landY = ledgeY;
    let landZ = 0;

    if (ledgeHeight > LOW_VAULT_MAX_HEIGHT_M) {
      kind = 'HIGH_MANTLE';
      // Must land cleanly on top of the high ledge
      const topReach = 0.58;
      landX = this._frontHitPos.x + out.vaultForward.x * topReach;
      landZ = this._frontHitPos.z + out.vaultForward.z * topReach;

      // Confirm solid top support under destination
      this._rayOrigin.set(landX, ledgeY + 0.45, landZ);
      const topSupport = this.raycastThroughGlass(adapter, this._rayOrigin, this._downDir, 0.02, 0.75, this._rayOut, out);
      if (!topSupport || Math.abs(this._rayOut.pointY - ledgeY) > 0.22 || this._rayOut.normalY < 0.72) {
        out.blockReason = 'no_clearance';
        return false;
      }
      landY = this._rayOut.pointY;
    } else if (estimatedDepth < MAX_VAULT_OVER_DEPTH_M) {
      // Candidate for VAULT_OVER: probe far side ground past the obstacle (clear thin rails comfortably)
      const farDist = Math.max(0.68, estimatedDepth + 0.56);
      const farX = this._frontHitPos.x + out.vaultForward.x * farDist;
      const farZ = this._frontHitPos.z + out.vaultForward.z * farDist;

      this._rayOrigin.set(farX, ledgeY + 0.45, farZ);
      const farHit = this.raycastThroughGlass(
        adapter,
        this._rayOrigin,
        this._downDir,
        0.02,
        MAX_SAFE_FAR_DROP_M + 0.5,
        this._rayOut,
        out,
      );

      const farGroundY = farHit ? this._rayOut.pointY : -999;
      const dropFromLedge = ledgeY - farGroundY;
      const safeFarDrop =
        farHit &&
        this._rayOut.normalY >= 0.72 &&
        dropFromLedge >= 0.15 &&
        dropFromLedge <= MAX_SAFE_FAR_DROP_M;

      if (safeFarDrop) {
        kind = 'VAULT_OVER';
        landX = farX;
        landY = farGroundY;
        landZ = farZ;
      } else if (depthHasTop[1] && estimatedDepth >= 0.35) {
        // Unsafe drop on far side -> fall back to CLIMB_ONTO if obstacle is wide enough to stand on
        kind = 'CLIMB_ONTO';
        landX = this._frontHitPos.x + out.vaultForward.x * 0.45;
        landY = ledgeY;
        landZ = this._frontHitPos.z + out.vaultForward.z * 0.45;
      } else {
        out.blockReason = 'unsafe_drop';
        return false;
      }
    } else {
      kind = 'CLIMB_ONTO';
      landX = this._frontHitPos.x + out.vaultForward.x * 0.58;
      landZ = this._frontHitPos.z + out.vaultForward.z * 0.58;
      this._rayOrigin.set(landX, ledgeY + 0.40, landZ);
      const topSupport = this.raycastThroughGlass(adapter, this._rayOrigin, this._downDir, 0.02, 0.70, this._rayOut, out);
      if (!topSupport || Math.abs(this._rayOut.pointY - ledgeY) > 0.22 || this._rayOut.normalY < 0.72) {
        out.blockReason = 'no_clearance';
        return false;
      }
      landY = this._rayOut.pointY;
    }

    // 7. Determine stand vs automatic crouch transition from sill & destination headroom
    const landClearance = this.measureVerticalClearance(
      adapter,
      landX,
      landY,
      landZ,
      PLAYER_RADIUS_M * 0.88,
      2.1,
      out,
    );
    if (landClearance < MIN_CROUCH_CLEARANCE_M) {
      out.blockReason = 'no_clearance';
      return false;
    }

    // Only force staying crouched after landing if the landing destination itself has low headroom
    let mustCrouch = landClearance < MIN_STAND_CLEARANCE_M;

    // 8. Zero-stuck destination capsule pre-validation via adapter.sweepCapsule()
    out.landPos.set(landX, landY, landZ);
    const targetCapsuleH = mustCrouch ? CROUCH_CAPSULE_H : STAND_CAPSULE_H;
    if (!this.validateDestinationCapsule(adapter, out.landPos, targetCapsuleH)) {
      // Retry with crouch capsule if standing clearance was snug
      if (!mustCrouch && this.validateDestinationCapsule(adapter, out.landPos, CROUCH_CAPSULE_H)) {
        mustCrouch = true;
      } else {
        out.blockReason = 'no_clearance';
        return false;
      }
    }

    // 9. Populate exact world-locked IK hand brace coordinates & physical arc waypoints
    const hasLowHeader = sillClearance < MIN_STAND_CLEARANCE_M;
    const isWindowBreach = hasLowHeader || out.breakableGlassObj !== null;
    out.valid = true;
    out.kind = kind;
    out.ledgeHeight = ledgeHeight;
    out.obstacleDepth = estimatedDepth;
    out.surface = ledgeSurface;
    out.mustCrouchOnFinish = mustCrouch;
    out.isWindowBreach = isWindowBreach;
    out.overheadCeilingY = sillClearance < 2.06 ? ledgeY + sillClearance : Infinity;
    out.entryPos.copy(playerPos);

    // Front lip of the ledge directly aligned with player entry
    out.ledgeCenter.set(this._frontHitPos.x, ledgeY, this._frontHitPos.z);

    // Apex waypoint over the ledge lip (keep hips tight to window sill on window breach so head ducks under lintel)
    const apexClearY =
      kind === 'VAULT_OVER'
        ? isWindowBreach
          ? ledgeY - 0.04
          : ledgeY + (mustCrouch ? 0.02 : 0.10)
        : ledgeY + (isWindowBreach ? -0.02 : 0.03);
    out.apexPos.set(
      this._frontHitPos.x + out.vaultForward.x * (kind === 'VAULT_OVER' ? Math.max(0.28, estimatedDepth * 0.55) : 0.24),
      apexClearY,
      this._frontHitPos.z + out.vaultForward.z * (kind === 'VAULT_OVER' ? Math.max(0.28, estimatedDepth * 0.55) : 0.24),
    );

    // Exact world-space hand brace coordinates on the upper surface
    const handLipInset = kind === 'HIGH_MANTLE' ? 0.13 : 0.09;
    const handPadUp = 0.025;
    if (kind === 'HIGH_MANTLE') {
      // Two-handed symmetrical brace: left hand planted on left side (-_right), right hand on right side (+_right)
      const halfSpan = 0.23;
      out.handLWorld
        .copy(out.ledgeCenter)
        .addScaledVector(out.vaultForward, handLipInset)
        .addScaledVector(out.wallNormal, 0.04)
        .addScaledVector(this._right, -halfSpan);
      out.handLWorld.y = ledgeY + handPadUp;

      out.handRWorld
        .copy(out.ledgeCenter)
        .addScaledVector(out.vaultForward, handLipInset)
        .addScaledVector(out.wallNormal, 0.04)
        .addScaledVector(this._right, halfSpan);
      out.handRWorld.y = ledgeY + handPadUp;
    } else {
      // One-handed left palm brace centered on top of thin railing / barrier / window sill while right hand tucks weapon
      const railCenteredInset = Math.min(handLipInset, Math.max(0.03, estimatedDepth * 0.5));
      out.handLWorld
        .copy(out.ledgeCenter)
        .addScaledVector(out.vaultForward, railCenteredInset + 0.04)
        .addScaledVector(out.wallNormal, 0.04)
        .addScaledVector(this._right, -0.17);
      out.handLWorld.y = ledgeY + handPadUp;

      out.handRWorld.copy(out.handLWorld);
    }

    return true;
  }
}
