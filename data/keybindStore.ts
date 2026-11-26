import { useSyncExternalStore } from 'react';

export type KeybindGroupId = 'movement' | 'weapons' | 'tactical' | 'interactions';

export type KeybindConflictGroup = 'general' | 'ads_modifier';

export type KeybindActionId =
  | 'move_forward'
  | 'move_backward'
  | 'move_left'
  | 'move_right'
  | 'sprint'
  | 'vault'
  | 'crouch'
  | 'lean_left'
  | 'lean_right'
  | 'fire'
  | 'ads'
  | 'hold_breath'
  | 'free_zoom'
  | 'point_aim'
  | 'canted_optic'
  | 'switch_fire_mode'
  | 'reload'
  | 'cycle_chamber'
  | 'suppressor'
  | 'inspect'
  | 'reticle_illum'
  | 'optic_zoom_in'
  | 'optic_zoom_out'
  | 'slot_primary'
  | 'slot_secondary'
  | 'slot_knife'
  | 'slot_unarmed'
  | 'grenade_draw'
  | 'grenade_belt'
  | 'nvg'
  | 'laser'
  | 'flashlight'
  | 'melee_bash'
  | 'push_kick'
  | 'interact'
  | 'pda'
  | 'tactical_map'
  | 'ping'
  | 'scoreboard_inventory'
  | 'tuner';

export type KeybindInputCode = string | null;

export type KeybindOverrides = Partial<Record<KeybindActionId, KeybindInputCode>>;

export interface KeybindActionDefinition {
  id: KeybindActionId;
  group: KeybindGroupId;
  label: string;
  description?: string;
  defaultCode: string;
  conflictGroup: KeybindConflictGroup;
}

export interface KeybindGroupDefinition {
  id: KeybindGroupId;
  title: string;
  description: string;
}

export interface RebindResult {
  actionId: KeybindActionId;
  inputCode: string;
  clearedActions: KeybindActionId[];
  changed: boolean;
}

export interface KeybindSnapshot {
  bindings: Record<KeybindActionId, KeybindInputCode>;
  overrides: KeybindOverrides;
  activeUserId: string | null;
  capturing: boolean;
  syncStatus: 'idle' | 'saving' | 'saved' | 'error';
  syncError: string | null;
}

export const KEYBIND_GROUPS: readonly KeybindGroupDefinition[] = [
  {
    id: 'movement',
    title: 'Movement & Posture',
    description: 'Locomotion, stances, vaulting, and tactical leaning.',
  },
  {
    id: 'weapons',
    title: 'Weapons & Optics',
    description: 'Firing, aiming, fire selector, reloading, optics, and weapon slots.',
  },
  {
    id: 'tactical',
    title: 'Tactical Equipment & Melee',
    description: 'Grenades, night vision, weapon lights, lasers, and close-quarters strikes.',
  },
  {
    id: 'interactions',
    title: 'World, Devices & UI',
    description: 'Doors, loot, tactical PDA, map, ping, and interface panels.',
  },
] as const;

export const KEYBIND_ACTIONS: readonly KeybindActionDefinition[] = [
  // Movement
  { id: 'move_forward', group: 'movement', label: 'Move Forward', defaultCode: 'KeyW', conflictGroup: 'general' },
  { id: 'move_backward', group: 'movement', label: 'Move Backward', defaultCode: 'KeyS', conflictGroup: 'general' },
  { id: 'move_left', group: 'movement', label: 'Strafe Left', defaultCode: 'KeyA', conflictGroup: 'general' },
  { id: 'move_right', group: 'movement', label: 'Strafe Right', defaultCode: 'KeyD', conflictGroup: 'general' },
  { id: 'sprint', group: 'movement', label: 'Sprint', defaultCode: 'ShiftLeft', conflictGroup: 'general' },
  { id: 'vault', group: 'movement', label: 'Jump / Vault / Mantle', defaultCode: 'Space', conflictGroup: 'general' },
  { id: 'crouch', group: 'movement', label: 'Crouch (Toggle)', defaultCode: 'KeyC', conflictGroup: 'general' },
  { id: 'lean_left', group: 'movement', label: 'Lean Left', defaultCode: 'KeyQ', conflictGroup: 'general' },
  { id: 'lean_right', group: 'movement', label: 'Lean Right', defaultCode: 'KeyE', conflictGroup: 'general' },

  // Weapons & Optics
  { id: 'fire', group: 'weapons', label: 'Fire Weapon / Throw', defaultCode: 'Mouse0', conflictGroup: 'general' },
  { id: 'ads', group: 'weapons', label: 'Aim Down Sights (ADS)', defaultCode: 'Mouse2', conflictGroup: 'general' },
  { id: 'hold_breath', group: 'weapons', label: 'Hold Breath (While ADS)', defaultCode: 'ShiftLeft', conflictGroup: 'ads_modifier' },
  {
    id: 'free_zoom',
    group: 'weapons',
    label: 'Free Zoom (Focus)',
    description: 'Hold to narrow FOV slightly anytime; stacks onto ADS and works while sprinting.',
    defaultCode: 'Mouse1',
    conflictGroup: 'general',
  },
  { id: 'point_aim', group: 'weapons', label: 'Toggle Point Aim', defaultCode: 'AltLeft', conflictGroup: 'general' },
  { id: 'canted_optic', group: 'weapons', label: 'Toggle Canted Optic', defaultCode: 'KeyB', conflictGroup: 'general' },
  {
    id: 'switch_fire_mode',
    group: 'weapons',
    label: 'Switch Fire Mode',
    description: 'Toggles Auto / Semi on select-fire weapons and Pump / Semi on the SPAS-12.',
    defaultCode: 'KeyK',
    conflictGroup: 'general',
  },
  { id: 'reload', group: 'weapons', label: 'Reload Weapon', defaultCode: 'KeyR', conflictGroup: 'general' },
  {
    id: 'cycle_chamber',
    group: 'weapons',
    label: 'Cycle Chamber / Rack Action',
    description: 'Manually racks the bolt, slide, or pump to cycle and eject a chambered live round onto the ground.',
    defaultCode: 'KeyY',
    conflictGroup: 'general',
  },
  { id: 'suppressor', group: 'weapons', label: 'Attach / Remove Suppressor', defaultCode: 'KeyG', conflictGroup: 'general' },
  { id: 'inspect', group: 'weapons', label: 'Inspect Weapon', defaultCode: 'KeyI', conflictGroup: 'general' },
  { id: 'reticle_illum', group: 'weapons', label: 'Reticle Illumination', defaultCode: 'KeyN', conflictGroup: 'general' },
  { id: 'optic_zoom_in', group: 'weapons', label: 'Optic Zoom In', defaultCode: 'BracketRight', conflictGroup: 'general' },
  { id: 'optic_zoom_out', group: 'weapons', label: 'Optic Zoom Out', defaultCode: 'BracketLeft', conflictGroup: 'general' },
  { id: 'slot_primary', group: 'weapons', label: 'Equip Primary Weapon', defaultCode: 'Digit1', conflictGroup: 'general' },
  { id: 'slot_secondary', group: 'weapons', label: 'Equip Secondary Weapon', defaultCode: 'Digit2', conflictGroup: 'general' },
  { id: 'slot_knife', group: 'weapons', label: 'Equip Combat Knife', defaultCode: 'Digit3', conflictGroup: 'general' },
  { id: 'slot_unarmed', group: 'weapons', label: 'Holster / Unarmed', defaultCode: 'Digit0', conflictGroup: 'general' },

  // Tactical
  { id: 'grenade_draw', group: 'tactical', label: 'Draw Grenade', defaultCode: 'KeyH', conflictGroup: 'general' },
  { id: 'grenade_belt', group: 'tactical', label: 'Cycle Grenade Type', defaultCode: 'Digit4', conflictGroup: 'general' },
  { id: 'nvg', group: 'tactical', label: 'Night Vision (NVG)', defaultCode: 'KeyJ', conflictGroup: 'general' },
  { id: 'laser', group: 'tactical', label: 'Tactical Laser', defaultCode: 'KeyL', conflictGroup: 'general' },
  { id: 'flashlight', group: 'tactical', label: 'Weapon Flashlight', defaultCode: 'KeyT', conflictGroup: 'general' },
  { id: 'melee_bash', group: 'tactical', label: 'Melee Bash', defaultCode: 'KeyV', conflictGroup: 'general' },
  { id: 'push_kick', group: 'tactical', label: 'Push / Kick', defaultCode: 'KeyX', conflictGroup: 'general' },

  // Interactions & UI
  { id: 'interact', group: 'interactions', label: 'Interact / Loot / Doors', defaultCode: 'KeyF', conflictGroup: 'general' },
  { id: 'pda', group: 'interactions', label: 'Tactical PDA', defaultCode: 'KeyP', conflictGroup: 'general' },
  { id: 'tactical_map', group: 'interactions', label: 'Tactical Map / Radar', defaultCode: 'KeyM', conflictGroup: 'general' },
  { id: 'ping', group: 'interactions', label: 'Tactical Ping', defaultCode: 'KeyZ', conflictGroup: 'general' },
  { id: 'scoreboard_inventory', group: 'interactions', label: 'Inventory / Scoreboard', defaultCode: 'Tab', conflictGroup: 'general' },
  { id: 'tuner', group: 'interactions', label: 'Quick Controls / Tuner', defaultCode: 'F1', conflictGroup: 'general' },
] as const;

export const KEYBIND_ACTION_MAP: Readonly<Record<KeybindActionId, KeybindActionDefinition>> = Object.freeze(
  KEYBIND_ACTIONS.reduce(
    (acc, def) => {
      acc[def.id] = def;
      return acc;
    },
    {} as Record<KeybindActionId, KeybindActionDefinition>,
  ),
);

export const DEFAULT_KEYBINDS: Readonly<Record<KeybindActionId, string>> = Object.freeze(
  KEYBIND_ACTIONS.reduce(
    (acc, def) => {
      acc[def.id] = def.defaultCode;
      return acc;
    },
    {} as Record<KeybindActionId, string>,
  ),
);

const VALID_ACTION_ID_SET = new Set<string>(KEYBIND_ACTIONS.map((a) => a.id));

const ALLOWED_SPECIAL_CODES = new Set<string>([
  'Space',
  'Tab',
  'Enter',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEnter',
]);

const RESERVED_CODES = new Set<string>([
  'Escape',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ContextMenu',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'PrintScreen',
  'Pause',
]);

export function isValidInputCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  if (code.length < 2 || code.length > 24) return false;
  if (RESERVED_CODES.has(code)) return false;
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit[0-9]$/.test(code)) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  if (/^F([1-9]|1[0-2])$/.test(code)) return true;
  if (/^Mouse[0-4]$/.test(code)) return true;
  return ALLOWED_SPECIAL_CODES.has(code);
}

export function isValidActionId(actionId: unknown): actionId is KeybindActionId {
  return typeof actionId === 'string' && VALID_ACTION_ID_SET.has(actionId);
}

export function mouseButtonToCode(button: number): string | null {
  if (!Number.isInteger(button) || button < 0 || button > 4) return null;
  return `Mouse${button}`;
}

export function codeToMouseButton(code: string | null | undefined): number | null {
  if (!code || !/^Mouse[0-4]$/.test(code)) return null;
  return Number(code.slice(5));
}

export function sanitizeKeybindOverrides(raw: unknown): KeybindOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: KeybindOverrides = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!isValidActionId(key)) continue;
    if (value === null) {
      result[key] = null;
      continue;
    }
    if (!isValidInputCode(value)) continue;
    // Omit entries identical to default to keep payloads compact and canonical.
    if (value === DEFAULT_KEYBINDS[key]) continue;
    result[key] = value;
  }
  return result;
}

const SPECIAL_LABELS: Readonly<Record<string, string>> = {
  Mouse0: 'LMB',
  Mouse1: 'MMB',
  Mouse2: 'RMB',
  Mouse3: 'Mouse 4',
  Mouse4: 'Mouse 5',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  ShiftLeft: 'Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'R-Ctrl',
  AltLeft: 'Alt',
  AltRight: 'R-Alt',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
};

export function formatInputCodeLabel(code: KeybindInputCode): string {
  if (code === null) return 'Unbound';
  if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code];
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad') && code.length === 7) return `Num ${code.slice(6)}`;
  return code;
}

const GUEST_STORAGE_KEY = 'cordon04_keybinds_guest_v1';
const USER_STORAGE_PREFIX = 'cordon04_keybinds_user_v1_';

function storageKeyForUser(userId: string | null): string {
  return userId ? `${USER_STORAGE_PREFIX}${userId}` : GUEST_STORAGE_KEY;
}

function readLocalOverrides(userId: string | null): KeybindOverrides {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(storageKeyForUser(userId));
    if (!raw) return {};
    return sanitizeKeybindOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeLocalOverrides(userId: string | null, overrides: KeybindOverrides): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keys = Object.keys(overrides);
    if (keys.length === 0) {
      window.localStorage.removeItem(storageKeyForUser(userId));
    } else {
      window.localStorage.setItem(storageKeyForUser(userId), JSON.stringify(overrides));
    }
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

function buildResolvedBindings(overrides: KeybindOverrides): Record<KeybindActionId, KeybindInputCode> {
  const bindings = {} as Record<KeybindActionId, KeybindInputCode>;
  for (const def of KEYBIND_ACTIONS) {
    if (Object.prototype.hasOwnProperty.call(overrides, def.id)) {
      bindings[def.id] = overrides[def.id] ?? null;
    } else {
      bindings[def.id] = def.defaultCode;
    }
  }
  return bindings;
}

function extractOverridesFromBindings(
  bindings: Record<KeybindActionId, KeybindInputCode>,
): KeybindOverrides {
  const overrides: KeybindOverrides = {};
  for (const def of KEYBIND_ACTIONS) {
    const current = bindings[def.id];
    if (current !== def.defaultCode) {
      overrides[def.id] = current;
    }
  }
  return overrides;
}

type PersistAccountCallback = (overrides: KeybindOverrides) => Promise<void>;

class KeybindStore {
  private activeUserId: string | null = null;
  private overrides: KeybindOverrides = {};
  private bindings: Record<KeybindActionId, KeybindInputCode>;
  private capturing = false;
  private syncStatus: KeybindSnapshot['syncStatus'] = 'idle';
  private syncError: string | null = null;
  private persistAccount: PersistAccountCallback | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistGeneration = 0;
  private listeners = new Set<() => void>();
  private snapshot: KeybindSnapshot;

  constructor() {
    this.overrides = readLocalOverrides(null);
    this.bindings = buildResolvedBindings(this.overrides);
    this.snapshot = this.makeSnapshot();
  }

  private makeSnapshot(): KeybindSnapshot {
    return {
      bindings: { ...this.bindings },
      overrides: { ...this.overrides },
      activeUserId: this.activeUserId,
      capturing: this.capturing,
      syncStatus: this.syncStatus,
      syncError: this.syncError,
    };
  }

  private emit(): void {
    this.snapshot = this.makeSnapshot();
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): KeybindSnapshot => {
    return this.snapshot;
  };

  isCapturing(): boolean {
    return this.capturing;
  }

  setCapturing(capturing: boolean): void {
    if (this.capturing === capturing) return;
    this.capturing = capturing;
    this.emit();
  }

  getCode(actionId: KeybindActionId): KeybindInputCode {
    return this.bindings[actionId];
  }

  getLabel(actionId: KeybindActionId): string {
    return formatInputCodeLabel(this.bindings[actionId]);
  }

  getOverrides(): KeybindOverrides {
    return { ...this.overrides };
  }

  isModified(actionId: KeybindActionId): boolean {
    return this.bindings[actionId] !== DEFAULT_KEYBINDS[actionId];
  }

  hasAnyOverrides(): boolean {
    return Object.keys(this.overrides).length > 0;
  }

  matchesKeyCode(eventCode: string, actionId: KeybindActionId): boolean {
    const bound = this.bindings[actionId];
    if (!bound) return false;
    if (bound === eventCode) return true;

    // Allow right-hand modifier keys to mirror left-hand modifier bindings unless explicitly bound elsewhere.
    const mirrorLeft =
      eventCode === 'ShiftRight'
        ? 'ShiftLeft'
        : eventCode === 'ControlRight'
          ? 'ControlLeft'
          : eventCode === 'AltRight'
            ? 'AltLeft'
            : null;
    if (mirrorLeft && bound === mirrorLeft) {
      const group = KEYBIND_ACTION_MAP[actionId].conflictGroup;
      const rightExplicitlyBound = KEYBIND_ACTIONS.some(
        (def) => def.conflictGroup === group && this.bindings[def.id] === eventCode,
      );
      if (!rightExplicitlyBound) return true;
    }
    return false;
  }

  matchesMouseButton(button: number, actionId: KeybindActionId): boolean {
    const code = mouseButtonToCode(button);
    if (!code) return false;
    return this.bindings[actionId] === code;
  }

  /**
   * Translates a physical KeyboardEvent.code or 'MouseN' code into the canonical
   * default code of the currently bound action in the 'general' conflict group.
   * - If a 'general' action is currently bound to `code`, returns that action's defaultCode.
   * - If `code` is a managed default code whose action was rebound or unbound, returns null.
   * - If `code` is an unmanaged fixed key (e.g. Escape, Digit5, arrows), returns `code` unchanged.
   */
  resolveManagedInputCode(code: string): string | null {
    for (const def of KEYBIND_ACTIONS) {
      if (def.conflictGroup !== 'general') continue;
      if (this.bindings[def.id] === code) {
        return def.defaultCode;
      }
    }
    const mirrorLeft =
      code === 'ShiftRight'
        ? 'ShiftLeft'
        : code === 'ControlRight'
          ? 'ControlLeft'
          : code === 'AltRight'
            ? 'AltLeft'
            : null;
    if (mirrorLeft) {
      for (const def of KEYBIND_ACTIONS) {
        if (def.conflictGroup !== 'general') continue;
        if (this.bindings[def.id] === mirrorLeft) {
          return def.defaultCode;
        }
      }
    }
    const isManagedDefault = KEYBIND_ACTIONS.some(
      (def) => def.conflictGroup === 'general' && def.defaultCode === code,
    );
    return isManagedDefault ? null : code;
  }

  isMovementKeyPressed(keysDown: ReadonlySet<string>, actionId: KeybindActionId): boolean {
    const bound = this.bindings[actionId];
    if (!bound) return false;
    if (keysDown.has(bound)) return true;
    if (bound === 'ShiftLeft' && keysDown.has('ShiftRight')) {
      const group = KEYBIND_ACTION_MAP[actionId].conflictGroup;
      const rightExplicitlyBound = KEYBIND_ACTIONS.some(
        (def) => def.conflictGroup === group && this.bindings[def.id] === 'ShiftRight',
      );
      if (!rightExplicitlyBound) return true;
    }
    if (bound === 'ControlLeft' && keysDown.has('ControlRight')) {
      const group = KEYBIND_ACTION_MAP[actionId].conflictGroup;
      const rightExplicitlyBound = KEYBIND_ACTIONS.some(
        (def) => def.conflictGroup === group && this.bindings[def.id] === 'ControlRight',
      );
      if (!rightExplicitlyBound) return true;
    }
    return false;
  }

  rebindAction(actionId: KeybindActionId, inputCode: string): RebindResult {
    if (!isValidActionId(actionId) || !isValidInputCode(inputCode)) {
      return { actionId, inputCode, clearedActions: [], changed: false };
    }
    const targetDef = KEYBIND_ACTION_MAP[actionId];
    const previousCode = this.bindings[actionId];
    const clearedActions: KeybindActionId[] = [];

    for (const def of KEYBIND_ACTIONS) {
      if (def.id === actionId) continue;
      if (def.conflictGroup !== targetDef.conflictGroup) continue;
      if (this.bindings[def.id] === inputCode) {
        this.bindings[def.id] = null;
        clearedActions.push(def.id);
      }
    }

    const changed = previousCode !== inputCode || clearedActions.length > 0;
    this.bindings[actionId] = inputCode;
    this.overrides = extractOverridesFromBindings(this.bindings);
    if (changed) {
      this.persistChanges();
    } else {
      this.emit();
    }
    return { actionId, inputCode, clearedActions, changed };
  }

  unbindAction(actionId: KeybindActionId): boolean {
    if (!isValidActionId(actionId)) return false;
    if (this.bindings[actionId] === null) return false;
    this.bindings[actionId] = null;
    this.overrides = extractOverridesFromBindings(this.bindings);
    this.persistChanges();
    return true;
  }

  resetAction(actionId: KeybindActionId): RebindResult {
    const defaultCode = DEFAULT_KEYBINDS[actionId];
    return this.rebindAction(actionId, defaultCode);
  }

  resetAllDefaults(): void {
    this.overrides = {};
    this.bindings = buildResolvedBindings(this.overrides);
    this.persistChanges();
  }

  setActiveUser(
    userId: string | null,
    accountOverrides?: KeybindOverrides | null,
    onPersistAccount?: PersistAccountCallback | null,
  ): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistGeneration += 1;
    this.activeUserId = userId;
    this.persistAccount = userId ? (onPersistAccount ?? null) : null;
    this.syncStatus = 'idle';
    this.syncError = null;

    if (userId) {
      // Server account keybinds are authoritative when signed in; cache locally per user ID.
      const sanitized = sanitizeKeybindOverrides(accountOverrides ?? {});
      this.overrides = sanitized;
      this.bindings = buildResolvedBindings(sanitized);
      writeLocalOverrides(userId, sanitized);
    } else {
      // Signed out / guest mode: restore isolated guest localStorage profile.
      this.overrides = readLocalOverrides(null);
      this.bindings = buildResolvedBindings(this.overrides);
    }
    this.emit();
  }

  private persistChanges(): void {
    const snapshotOverrides = { ...this.overrides };
    writeLocalOverrides(this.activeUserId, snapshotOverrides);

    if (!this.activeUserId || !this.persistAccount) {
      this.syncStatus = 'saved';
      this.syncError = null;
      this.emit();
      return;
    }

    const persistFn = this.persistAccount;
    const generation = ++this.persistGeneration;
    this.syncStatus = 'saving';
    this.syncError = null;
    this.emit();

    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void persistFn(snapshotOverrides)
        .then(() => {
          if (generation !== this.persistGeneration) return;
          this.syncStatus = 'saved';
          this.syncError = null;
          this.emit();
        })
        .catch((err: unknown) => {
          if (generation !== this.persistGeneration) return;
          this.syncStatus = 'error';
          this.syncError = err instanceof Error ? err.message : 'Failed to save keybinds';
          this.emit();
        });
    }, 180);
  }
}

export const keybindStore = new KeybindStore();

export function useKeybinds(): KeybindSnapshot {
  return useSyncExternalStore(keybindStore.subscribe, keybindStore.getSnapshot, keybindStore.getSnapshot);
}
