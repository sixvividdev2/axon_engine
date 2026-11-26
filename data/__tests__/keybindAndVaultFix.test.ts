import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BodycamPhysicsWorld,
  createVaultCandidate,
  DEFAULT_TRAUMA_MODIFIERS,
  resolveWeaponProfile,
  VaultDetector,
} from '../../bodycam-sdk';
import {
  formatFireModeLabel,
  getEffectiveFireMode,
  SelectableFireMode,
  toggleWeaponFireMode,
} from '../fireModeControl';
import {
  DEFAULT_KEYBINDS,
  formatInputCodeLabel,
  isValidInputCode,
  KeybindOverrides,
  keybindStore,
  sanitizeKeybindOverrides,
} from '../keybindStore';

describe('Keybind Store & Per-User Persistence', () => {
  beforeEach(() => {
    keybindStore.setActiveUser(null, null, null);
    keybindStore.resetAllDefaults();
  });

  it('defaults Switch Fire Mode to KeyK, Cycle Chamber to KeyY, Free Zoom to Mouse1, and Point Aim to AltLeft', () => {
    expect(DEFAULT_KEYBINDS.switch_fire_mode).toBe('KeyK');
    expect(DEFAULT_KEYBINDS.canted_optic).toBe('KeyB');
    expect(DEFAULT_KEYBINDS.ping).toBe('KeyZ');
    expect(DEFAULT_KEYBINDS.cycle_chamber).toBe('KeyY');
    expect(DEFAULT_KEYBINDS.free_zoom).toBe('Mouse1');
    expect(DEFAULT_KEYBINDS.point_aim).toBe('AltLeft');
    expect(keybindStore.getLabel('switch_fire_mode')).toBe('K');
    expect(keybindStore.getLabel('cycle_chamber')).toBe('Y');
    expect(keybindStore.getLabel('free_zoom')).toBe('MMB');
    expect(keybindStore.getLabel('point_aim')).toBe('Alt');
  });

  it('auto-clears conflicting actions in the same conflict group and reports cleared action IDs', () => {
    const res = keybindStore.rebindAction('switch_fire_mode', 'KeyR');
    expect(res.changed).toBe(true);
    expect(res.clearedActions).toEqual(['reload']);
    expect(keybindStore.getCode('switch_fire_mode')).toBe('KeyR');
    expect(keybindStore.getCode('reload')).toBeNull();
    expect(keybindStore.getLabel('reload')).toBe('Unbound');

    // Old default KeyK is now unbound -> resolves to null; KeyR now maps to switch_fire_mode's default (KeyK)
    expect(keybindStore.resolveManagedInputCode('KeyK')).toBeNull();
    expect(keybindStore.resolveManagedInputCode('KeyR')).toBe('KeyK');
  });

  it('allows Sprint and Hold Breath to coexist on ShiftLeft across separate conflict groups', () => {
    expect(keybindStore.getCode('sprint')).toBe('ShiftLeft');
    expect(keybindStore.getCode('hold_breath')).toBe('ShiftLeft');

    const res = keybindStore.rebindAction('hold_breath', 'AltLeft');
    expect(res.clearedActions).toEqual([]);
    expect(keybindStore.getCode('sprint')).toBe('ShiftLeft');
    expect(keybindStore.getCode('hold_breath')).toBe('AltLeft');
  });

  it('rejects reserved keys and strictly sanitizes untrusted keybind payloads', () => {
    expect(isValidInputCode('Escape')).toBe(false);
    expect(isValidInputCode('MetaLeft')).toBe(false);
    expect(isValidInputCode('KeyK')).toBe(true);
    expect(isValidInputCode('Mouse3')).toBe(true);

    const sanitized = sanitizeKeybindOverrides({
      switch_fire_mode: 'KeyU',
      reload: null,
      vault: 'Escape',
      move_forward: 'KeyW', // identical to default -> stripped
      unknown_action: 'KeyQ',
      __proto__: 'KeyZ',
    });

    expect(sanitized).toEqual({
      switch_fire_mode: 'KeyU',
      reload: null,
    });
  });

  it('hydrates signed-in account keybinds, persists via callback, and isolates guest profile on sign-out', async () => {
    vi.useFakeTimers();
    try {
      // Guest customizes crouch to ControlLeft
      keybindStore.rebindAction('crouch', 'ControlLeft');
      expect(keybindStore.getCode('crouch')).toBe('ControlLeft');

      // Sign in as User A with account override switch_fire_mode = KeyV
      const savedPayloads: KeybindOverrides[] = [];
      const persistMock = vi.fn(async (overrides: KeybindOverrides) => {
        savedPayloads.push(overrides);
      });
      keybindStore.setActiveUser('user_alpha', { switch_fire_mode: 'KeyU' }, persistMock);
      expect(keybindStore.getCode('switch_fire_mode')).toBe('KeyU');
      expect(keybindStore.getCode('crouch')).toBe('KeyC'); // User A's default, not guest's ControlLeft

      // User A rebinds reload -> triggers debounced account persistence
      keybindStore.rebindAction('reload', 'KeyO');
      await vi.advanceTimersByTimeAsync(250);
      expect(persistMock).toHaveBeenCalledTimes(1);
      expect(savedPayloads[0]).toEqual({
        switch_fire_mode: 'KeyU',
        reload: 'KeyO',
      });

      // Sign out -> User A bindings do not leak into guest profile
      keybindStore.setActiveUser(null, null, null);
      expect(keybindStore.getCode('switch_fire_mode')).toBe('KeyK');
      expect(keybindStore.getCode('reload')).toBe('KeyR');
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats mouse and special input codes cleanly', () => {
    expect(formatInputCodeLabel('Mouse0')).toBe('LMB');
    expect(formatInputCodeLabel('Mouse2')).toBe('RMB');
    expect(formatInputCodeLabel('Mouse3')).toBe('Mouse 4');
    expect(formatInputCodeLabel('ShiftLeft')).toBe('Shift');
    expect(formatInputCodeLabel(null)).toBe('Unbound');
  });
});

describe('Unified Switch Fire Mode Control', () => {
  it('toggles select-fire rifles between Full-Auto and Semi-Auto and SPAS-12 between Pump and Semi', () => {
    const overrides: Record<string, SelectableFireMode> = {};
    const m4 = resolveWeaponProfile('m4_556');
    expect(getEffectiveFireMode(m4, overrides)).toBe('auto');

    const toSemi = toggleWeaponFireMode(m4, overrides);
    expect(toSemi.toggled).toBe(true);
    expect(toSemi.nextMode).toBe('semi');
    expect(formatFireModeLabel(getEffectiveFireMode(m4, overrides))).toBe('SEMI');

    const backAuto = toggleWeaponFireMode(m4, overrides);
    expect(backAuto.toggled).toBe(true);
    expect(backAuto.nextMode).toBe('auto');

    const spas = resolveWeaponProfile('spas12');
    const spasToggle = toggleWeaponFireMode(spas, overrides);
    expect(spasToggle.toggled).toBe(true);
    expect(['pump', 'semi']).toContain(spasToggle.nextMode);

    const pm = resolveWeaponProfile('pm_9x19');
    const pistolToggle = toggleWeaponFireMode(pm, overrides);
    expect(pistolToggle.toggled).toBe(false);
  });
});

describe('Tutorial Bay 02 Concrete Barrier Vault Detection', () => {
  it('reliably detects VAULT_OVER from both sides of the fixed 0.96m Bay 02 concrete barrier', () => {
    const physics = new BodycamPhysicsWorld();
    physics.boundsMinX = -6.2;
    physics.boundsMaxX = 6.2;
    physics.boundsMinZ = -44;
    physics.boundsMaxZ = 24;

    // Solid concrete floor slab matching TutorialWorld.ts so far-side ground raycasts hit y = 0
    physics.addBox({
      minX: -8,
      maxX: 8,
      minY: -0.5,
      maxY: 0,
      minZ: -50,
      maxZ: 28,
      surface: 'concrete',
      blocksMovement: true,
      blocksRaycast: true,
    });

    // Exact Bay 02 solid vault collider from TutorialWorld.ts:
    // addBox(0, 0.48, 7.6, 5.2, 0.96, 0.42, wallMat, 'concrete', true, true)
    physics.addBox({
      minX: -2.6,
      maxX: 2.6,
      minY: 0,
      maxY: 0.96,
      minZ: 7.39,
      maxZ: 7.81,
      surface: 'concrete',
      blocksMovement: true,
      blocksRaycast: true,
    });

    const adapter = physics.createAdapter({
      getTraumaModifiers: () => DEFAULT_TRAUMA_MODIFIERS,
    });
    const detector = new VaultDetector();
    const candidate = createVaultCandidate();

    // Approach from Bay 01 -> Bay 02 side (facing -Z, yaw = 0)
    const foundNorth = detector.detect(
      adapter,
      new THREE.Vector3(0, 0, 8.35),
      0,
      true,
      candidate,
      DEFAULT_TRAUMA_MODIFIERS,
    );
    expect(foundNorth).toBe(true);
    expect(candidate.valid).toBe(true);
    expect(candidate.kind).toBe('VAULT_OVER');
    expect(candidate.ledgeHeight).toBeCloseTo(0.96, 2);
    expect(candidate.landPos.z).toBeLessThan(7.39);

    // Approach from Bay 03 -> Bay 02 reverse side (facing +Z, yaw = PI)
    const foundSouth = detector.detect(
      adapter,
      new THREE.Vector3(0, 0, 6.85),
      Math.PI,
      true,
      candidate,
      DEFAULT_TRAUMA_MODIFIERS,
    );
    expect(foundSouth).toBe(true);
    expect(candidate.valid).toBe(true);
    expect(candidate.kind).toBe('VAULT_OVER');
    expect(candidate.landPos.z).toBeGreaterThan(7.81);
  });
});
