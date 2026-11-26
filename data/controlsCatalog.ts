export interface ControlBindingEntry {
  readonly id: string;
  readonly keys: readonly string[];
  readonly action: string;
  readonly detail?: string;
}

export interface ControlBindingGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly bindings: readonly ControlBindingEntry[];
}

export const CONTROL_BINDING_GROUPS: readonly ControlBindingGroup[] = [
  {
    id: 'movement',
    title: 'Movement & Stance',
    description: 'Locomotion, vaulting, crouching, and bodycam lean angles.',
    bindings: [
      { id: 'move', keys: ['W', 'A', 'S', 'D'], action: 'Move / Strafe' },
      { id: 'sprint', keys: ['Shift'], action: 'Tactical Sprint (Hold)' },
      { id: 'vault', keys: ['Space'], action: 'Jump, Vault & High Mantle' },
      { id: 'crouch', keys: ['C'], action: 'Toggle Crouch' },
      { id: 'lean', keys: ['Q', 'E'], action: 'Lean Left / Lean Right' },
    ],
  },
  {
    id: 'weapons',
    title: 'Weapons, Optics & Ballistics',
    description: 'Aiming modes, magnification optics, suppression, and weapon handling.',
    bindings: [
      { id: 'fire', keys: ['LMB'], action: 'Fire Weapon / Throw Ordnance' },
      { id: 'ads', keys: ['RMB'], action: 'Aim Down Sights (ADS)' },
      { id: 'hold_breath', keys: ['Shift'], action: 'Hold Breath (While ADS)' },
      {
        id: 'free_zoom',
        keys: ['MMB'],
        action: 'Free Zoom / Focus (Hold)',
        detail: 'Subtle 13% FOV focus zoom; works anytime including sprint & stacks onto ADS',
      },
      { id: 'point_aim', keys: ['Alt'], action: 'Toggle Point Aim' },
      { id: 'canted', keys: ['B'], action: 'Toggle Canted Backup Optic' },
      {
        id: 'switch_fire_mode',
        keys: ['K'],
        action: 'Switch Fire Mode (Auto / Semi / Pump)',
        detail: 'Select-fire Auto / Semi on rifles & SMGs · Pump / Semi on SPAS-12',
      },
      { id: 'optic_zoom', keys: ['Wheel', '[ ]'], action: 'Variable Optic Magnification' },
      { id: 'reticle_illum', keys: ['N'], action: 'Toggle Optic Illumination' },
      { id: 'reload', keys: ['R'], action: 'Reload Weapon' },
      {
        id: 'cycle_chamber',
        keys: ['Y'],
        action: 'Cycle Chamber / Rack Bolt or Slide',
        detail: 'Racks action to eject a live round onto the ground (pick up with F)',
      },
      { id: 'suppressor', keys: ['G'], action: 'Attach / Detach Suppressor' },
      { id: 'inspect', keys: ['I'], action: 'Inspect Firearm' },
    ],
  },
  {
    id: 'tactical',
    title: 'Tactical Gear, Melee & Ordnance',
    description: 'Weapon slots, belt ordnance manual of arms, NVG, lasers, and CQB.',
    bindings: [
      { id: 'slots', keys: ['1', '2'], action: 'Equip Primary / Sidearm' },
      { id: 'knife_unarmed', keys: ['3', '0'], action: 'Combat Knife / Empty Hands' },
      {
        id: 'grenade',
        keys: ['4', '5', 'H'],
        action: 'Draw / Stow Belt Ordnance',
        detail: 'RMB Pull Pin · RMB Release Spoon · LMB Lob / Overhand',
      },
      { id: 'nvg', keys: ['J'], action: 'Flip Night Vision Goggles (NVG)' },
      { id: 'ir_flood', keys: ['N'], action: 'Toggle IR Flood (While NVG Active)' },
      { id: 'laser', keys: ['L', 'Alt+L'], action: 'Toggle Visible / IR Laser' },
      { id: 'flashlight', keys: ['T'], action: 'Toggle Weapon Flashlight' },
      { id: 'bash', keys: ['V'], action: 'Quick Weapon Bash / Knife Slash' },
      { id: 'kick', keys: ['X'], action: 'Tactical Push-Kick / Breach' },
    ],
  },
  {
    id: 'interactions',
    title: 'Interactions, PDA & Interface',
    description: 'World interactions, squad communications, tactical map, and menus.',
    bindings: [
      { id: 'interact', keys: ['F'], action: 'Interact (Doors, Armory, Repairs, Mortars, Loot)' },
      { id: 'interact_scroll', keys: ['Scroll'], action: 'Cycle Contextual Action Prompt' },
      {
        id: 'pda',
        keys: ['P'],
        action: 'Toggle 3D TAC-PDA',
        detail: 'Draws / powers off PDA on last active tab · Tab Switch Mode',
      },
      {
        id: 'tactical_map',
        keys: ['M'],
        action: 'Open Tactical Map (TAC-PDA)',
        detail: 'LMB Drag Pan · Wheel Zoom · R / RMB Recenter',
      },
      { id: 'ping', keys: ['Z'], action: 'Contextual Tactical Ping' },
      { id: 'tab', keys: ['Tab'], action: 'Scoreboard (Battle) / Rig & Pack (Open World)' },
      { id: 'tuner', keys: ['F1'], action: 'Bodycam Optics & SDK Tuner' },
      { id: 'pause', keys: ['Esc'], action: 'Pause / Game Settings Menu' },
    ],
  },
];
