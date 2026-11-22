# CORDON-04 Operator Selection, Shared Rig Contract, Suppressor Mechanics & Secondary Physics

This plan introduces a selectable **Male / Female tactical operator pipeline** built directly on CORDON-04's existing procedural tactical rigs (with seamless drop-in `.glb` asset support), paired with a **realistic twist-and-stow field suppressor mechanic**, a **fixed-step 120 Hz zero-allocation secondary physics solver**, and a **custom articulated XPBD/Verlet ragdoll system** delivered across five independently runnable build phases.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> All architectural and scope decisions below have been confirmed against the current CORDON-04 codebase. Approving this plan transitions directly into Build Mode starting at Phase 1.

- **Confirmed — Existing Tactical Rigs + GLB Drop-In**: Upgrade CORDON-04's existing multi-part tactical operator models (ripstop PBR camo, beveled SAPI plate carrier, triple mag pouches, 3-phalanx articulated gloved hands, FAST ballistic helmet) to fulfill the canonical `MALE` and `FEMALE` shared rig contract, while preserving automatic `.glb` (`SkinnedMesh`) drop-in loading whenever DCC assets are added.
- **Confirmed — Suppressor Twist/Stow Bundled in Phase 3**: Realistic multi-stage twist-off / twist-on and pouch stow animation integrated with weapon sockets and left-hand IK, blocking firing/ADS during the action and strictly gated so field toggling works **only** when the weapon actually owns or has a suppressor installed from the Gunsmith Bench.
- **Confirmed — Pure Secondary Bones with Optional Morph Hook**: Soft-tissue secondary motion drives dedicated `sec_*` child nodes (`sec_chest_l/r`, `sec_glute_l/r` for Female; `sec_bicep_l/r`, `sec_tricep_l/r`, `sec_forearm_l/r` for Male) with zero extra vertex-shader overhead, while retaining an optional morph-target influence hook for future `.glb` assets.
- **Confirmed — Custom XPBD/Verlet Articulated Ragdoll**: Phase 5 uses a zero-dependency, fixed-step (`120 Hz`) allocation-free articulated constraint ragdoll colliding directly against the existing physics world (floors, stairs, ramps, walls, and cover) with no WASM startup overhead or dual-world collider duplication.
- **Codebase-Locked — Axon Collarbone Bodycam & Single-Rig Shadow Masking**: Camera mounts at the existing upper-chest/collarbone archetype (`1.42 m` standing, `+3 cm` lateral collar offset, `[-82°, +80°]` pitch) and reuses the two-pass layer renderer (`Layer 0` world + shadows; `VIEWMODEL_LAYER` arms & weapon), upgrading the head/helmet group to cast world shadows while staying excluded from the bodycam lens.

---

## 1. Overview & Core Concept

- **What It Does**:
  - Lets players choose between **Male** and **Female** tactical operators on an interactive 3D pre-deployment turntable stage with smooth inertia orbit, lighting contrast, and persistent selection across sessions (plus deterministic URL override for automated testing).
  - Enforces a single canonical skeletal, socket, IK-pole, and hit-zone contract across both operators so weapons, ADS sightlines, bodycam downward pitch, world shadows, and ragdolls behave identically without per-operator hacks.
  - Adds grounded field suppressor manipulation: operators with an equipped or Gunsmith-installed suppressor can twist it off the barrel threads and stow it in a chest/belt pouch (or re-thread it back on) while blocking firing until the hand returns to the handguard.
  - Simulates bounded, gear-safe secondary soft-tissue physics (`120 Hz`, zero per-frame allocations) and realistic articulated hit-zone ragdoll collapses on elimination.
- **Target Audience / Persona**: Tactical FPS players using Playground (Range & Gunsmith), Battle (Solo/Multiplayer TDM & FFA), and Infection modes who expect authentic bodycam framing, grounded weapon handling, and crisp visual feedback.
- **Key Value**: Unifies first-person bodycam presentation, third-person silhouette/shadows, weapon ergonomics, secondary motion, and death physics under one validated contract that remains fast even under Software WebGL.

---

## 2. User Experience & Visual Design

### Key User Flows
1. **Pre-Deployment Operator Selection (Main Menu Hub)**:
   - Player opens the **Operator** section from the Main Menu Hub navigation bar.
   - An isolated 3D preview viewport fills the central stage, displaying the currently persisted operator (`MALE` or `FEMALE`) on a matte tactical turntable pedestal in weapon-ready idle stance.
   - Pointer dragging orbits the turntable smoothly with exponential inertia; scroll wheel zooms within clamped upper-body-to-full-frame bounds; double-click or a compact reset control snaps back to the 3/4 tactical hero angle.
   - Selecting **Male** or **Female** switches the rig cleanly (preserving orbit angle and uniform preset), persists immediately to versioned browser storage, and reflects the active operator across Playground, Battle, and Infection deployments.
2. **In-Game Bodycam & Field Suppressor Flow**:
   - On deploy, the chosen operator spawns through the rig validator with full lower body, SAPI plate carrier, arms, and world-shadow-casting FAST helmet (invisible to the bodycam lens even at `-85°` downward pitch).
   - Pressing the suppressor toggle key checks ownership:
     - **Weapon has no suppressor (never equipped/installed on Gunsmith Bench)**: Action is rejected cleanly with a brief diegetic toast (`No Suppressor Equipped`) — no suppressor materializes.
     - **Weapon has a suppressor installed (attached or stowed in pouch)**: Firing, ADS, and reloading are locked while the weapon tilts to an ergonomic workspace angle, the left hand releases the handguard via IK blend, grips the suppressor body, executes a multi-turn axial unscrew/thread-on twist with metallic thread audio cues, stows/draws the suppressor at the chest/belt pouch, and smoothly returns to the forend before unlocking firing.
3. **Elimination & Ragdoll Transition**:
   - Fatal damage on any of the 15 anatomical hit zones transfers the exact current joint poses (within `< 2 mm` / `< 0.5°`) into the XPBD/Verlet ragdoll with directional bullet impulse, collapsing naturally down stairs, ramps, and cover while secondary springs decay smoothly to rest.

### Visual Identity & Theme
- **Aesthetic Direction**: Utilitarian tactical brutalism matching CORDON-04's existing Main Menu Hub — restrained dark slate surfaces, high-contrast studio rim lighting on the operator silhouette, and zero ornamental clutter.
- **Color Palette & Mood (60-30-10 Discipline)**:
  - *60% Neutral Canvas*: Deep obsidian/charcoal (`#090A0B` / `#0D1014`) with horizon-matched exponential fog in the preview stage.
  - *30% Structural Surfaces*: Matte dark slate control containers (`rgba(15, 18, 22, 0.88)`) bounded by crisp hairline dividers (`rgba(255, 255, 255, 0.08)`). No `backdrop-filter` / `backdrop-blur` over WebGL canvases to guarantee zero Software-WebGL stalls.
  - *10% High-Intent Accent*: Tactical amber (`#F59E0B`) reserved strictly for the active operator selection state and primary deploy CTA, with explicit text labels accompanying every state change.
- **Typography & Hierarchy**:
  - Preserves CORDON-04's established font system: `Oswald` for display callouts, `Plus Jakarta Sans` for clean UI controls and descriptions, and `IBM Plex Mono` (`tabular-nums`) strictly for quantitative telemetry/spec callouts (height, rig status, loadout dimensions).
  - Zero static pill enclosures, zero decorative pulsing dots, zero `//` code-comment prefixes, and single-line controls (`whitespace-nowrap shrink-0`).
- **Spatial Layout & Viewport Ergonomics**:
  - **100% Unobstructed Central 3D Viewport**: The operator preview canvas occupies the stage with all selection controls (`Male` / `Female` segmented toggle, Uniform preview selector, Camera Reset, and `Deploy` CTA) consolidated into a compact, collapsible bottom dock so no floating side cards cover the operator silhouette.
  - **Three-Point Tactical Lighting**: Warm directional key light casting soft contact shadows onto the turntable pedestal, cool `HemisphereLight` fill, sharp rim backlight separating shoulders/helmet from the dark hall, plus procedural `RoomEnvironment` PMREM reflections so metallic buckles, visor, and optics read naturally.
- **Interactive Feedback & Motion**:
  - Control interactions respond within `100–200 ms` using compositor-only `transform` / `opacity` transitions.
  - Preview camera orbiting and zoom use frame-rate-independent exponential damping (`THREE.MathUtils.damp`), cancelling smoothly on pointer start and pacing Software WebGL loops with fence-synced `afterDraw` scheduling.
  - WebGL context loss/restore listeners protect the preview canvas with a clean dark slate fallback panel if WebGL is unavailable.

---

## 3. Key Product Decisions & Trade-Offs

1. **Upgrading Existing Procedural Tactical Rigs + GLB Drop-In Loader**
   - *Chosen Approach*: Upgrade the existing detailed tactical models into contract-compliant `MALE` and `FEMALE` rigs sharing canonical bone/socket/hit-zone names, while wrapping `GLTFLoader` behind the same asset loader interface.
   - *Why*: Preserves the existing ripstop PBR fabrics, SAPI plate carrier, pouches, articulated fingers, and FAST helmet immediately across all 5 phases with zero 404s, while letting future DCC `.glb` models drop in transparently and pass the exact same validator.
   - *Alternatives Considered*: Replacing existing visuals with bare capsule proxies (visual downgrade) or blocking implementation until external `.glb` files exist (stalls all runtime engineering).

2. **Suppressor Ownership State & Blocking Mechanical Action**
   - *Chosen Approach*: Track per-weapon suppressor ownership (`installedSuppressorId` from Gunsmith Bench or default weapon spec) separately from active barrel mount state (`suppressorStowed`), driven by a dedicated blocking action in the weapon and character animators.
   - *Why*: Prevents non-suppressed guns from conjuring a suppressor out of thin air, preserves the exact suppressor model when stowed and re-attached in the field, and guarantees firing/ADS/reload cannot clip through the unscrewing animation.
   - *Alternatives Considered*: Instant visibility toggle (breaks realism and allows firing mid-action) or removing the suppressor from Gunsmith configuration when detached (loses the player's stowed suppressor).

3. **Fixed-Step `120 Hz` SoA `Float32Array` Secondary Physics Solver**
   - *Chosen Approach*: Pre-allocated flat `Float32Array` arrays (up to 48 scalar springs) stepped in a fixed `1/120 s` accumulator (max 4 substeps/frame), applying strictly clamped additive offsets (`<= 14 mm` vertical, `<= 10 mm` forward on female chest; `<= 4 mm` on male arms) exclusively to dedicated `sec_*` child nodes post-animation.
   - *Why*: Guarantees frame-rate-independent determinism, zero heap allocations/GC pauses in steady state, and absolute protection against plate-carrier or strap clipping (`>= 18 mm` authored rest clearance).
   - *Alternatives Considered*: Variable-dt Three.js `Vector3` springs (allocates memory and becomes unstable at low frame rates) or vertex morph targets on procedural rigs (unnecessary shader cost when pure `sec_*` nodes suffice).

4. **Custom Articulated XPBD/Verlet Ragdoll on Existing Physics World**
   - *Chosen Approach*: Fixed-step `120 Hz` zero-allocation articulated particle/capsule constraint solver (15 anatomical nodes with bone-length constraints, angular hinge/cone limits, friction, and hit-zone impulse routing) querying the existing physics world (`boxes`, `ramps`, `getGroundHeight`) directly.
   - *Why*: Eliminates ~2 MB WASM startup overhead and dual-world collider synchronization bugs, runs smoothly on Software WebGL and headless Vitest tests, and works seamlessly across stairs, ramps, and cover.
   - *Alternatives Considered*: `@dimforge/rapier3d-compat` (adds heavy WASM lifecycle and duplicate map collider maintenance).

5. **Five-Phase Incremental Delivery (Always Compilable & Runnable)**
   - *Chosen Approach*: Execute and verify each phase sequentially — (1) Preview UI, Store & Upgraded Rigs, (2) Rig Parity Validator, Asset Loader & Spawn Integration, (3) Weapon Socket Coordinator, 2-Bone IK & Suppressor Twist/Stow, (4) 120 Hz Secondary Physics Solver & Rig Applier, (5) XPBD/Verlet Ragdoll & Automated Vitest/Playwright Verification Suites.
   - *Why*: Every milestone leaves CORDON-04 compiling cleanly (`tsc --noEmit` + `vite build`) and immediately testable in the browser.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### System Architecture & Runtime Data Flow

```text
┌─────────────────────────────────────┐    persists ID    ┌──────────────────────────────────────┐
│ Operator Select Panel (React Dock)  │ ────────────────► │ Operator Selection Store             │
│ + Isolated 3D Turntable Stage       │                   │ (localStorage v1 + ?operator= override)
└──────────────────┬──────────────────┘                   └──────────────────┬───────────────────┘
                   │ requests rig                                            │ read on deploy
                   ▼                                                         ▼
┌─────────────────────────────────────┐    validates      ┌──────────────────────────────────────┐
│ Operator Asset Loader               │ ────────────────► │ Player Spawn Controller              │
│ (Upgraded Tactical Rig / GLB Cache) │   ValidationRpt   │ (GymEngine & CombatSessionEngine)    │
│ + Rig Parity Validator (STRICT/SAFE)│                   └──────────────────┬───────────────────┘
└─────────────────────────────────────┘                                      │
                                        ┌────────────────────────────────────┘
                                        ▼  per-frame & fixed-step loop
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Bodycam Rig Controller (Unified Rig Hierarchy + Head Shadow-Only Mask + Collarbone Mount)      │
│                                                                                                │
│  [1. Base Pose & Locomotion] ──► [2. Weapon Socket & 2-Bone IK] ──► [3. Secondary Spring 120Hz]│
│   • Spine/pelvis/legs IK          • socket_weapon_r alignment        • Flat Float32Array (SoA) │
│   • Suppressor Twist/Stow FSM     • Left-hand IK -> handguard /      • Local accel + gait +    │
│     (blocks fire/ADS; gated on      muzzle thread / stow pouch         landing + recoil kick   │
│      owned/Gunsmith suppressor)   • Preserves exact ADS sightAnchor  • Clamped sec_* offsets   │
│                                                                                                │
│  [4. Two-Pass Render & Shadows] ───────────────────────────────► [5. Hit-Zone XPBD Ragdoll]    │
│   • Pass 1 (Layer 0): World, torso, legs, shadow-only head        • 15 hz_* collider nodes     │
│   • Pass 2 (Layer 1): Depth-cleared arms + weapon viewmodel       • Frame-0 pose handoff       │
│                                                                   • Collides w/ PhysicsWorld   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & Canonical Contracts
- **Operator Selection State**:
  - `OperatorId`: `'MALE' | 'FEMALE'` (default `'MALE'`).
  - Persisted under versioned storage key `bfps.operator.v1` with in-memory fallback when storage is unavailable, corrupted-value sanitization back to `'MALE'`, and deterministic URL query override (`?operator=male|female`) taking top precedence.
- **Shared Rig Contract (`OperatorRigContract`)**:
  - Coordinate convention normalized cleanly (`1.0 unit = 1.0 m`, `+Y` up, root origin `(0, 0, 0)` between boots, uniform scale `1.0 ± 0.001`).
  - **Primary Nodes**: `root`, `pelvis`, `spine_01`, `spine_02`, `spine_03`, `neck_01`, `head`, `clavicle_l/r`, `upperarm_l/r`, `lowerarm_l/r`, `hand_l/r`, `thigh_l/r`, `calf_l/r`, `foot_l/r`, `toe_l/r`.
  - **Secondary Soft-Tissue Nodes**: `sec_chest_l/r` (child of `spine_03`), `sec_glute_l/r` (child of `pelvis`), `sec_bicep_l/r` & `sec_tricep_l/r` (children of `upperarm_l/r`), `sec_forearm_l/r` (children of `lowerarm_l/r`). Rigid gear (SAPI front/back plates, shoulder straps, cummerbund, mag pouches, belt, holster) remains parented strictly to primary structural bones (`spine_03`, `pelvis`).
  - **Sockets & IK**: `socket_weapon_r` (child of `hand_r`), `socket_weapon_holster` (child of `pelvis`), `socket_bodycam_mount` (child of `spine_03`, forward of plate carrier clearing gear), `ik_pole_elbow_l/r`.
  - **15 Hit-Zone Nodes**: `hz_head`, `hz_neck`, `hz_chest`, `hz_abdomen`, `hz_pelvis`, `hz_upperarm_l/r`, `hz_forearm_l/r`, `hz_hand_l/r`, `hz_thigh_l/r`, `hz_calf_l/r`, `hz_foot_l/r`.
- **Rig Validation Report**:
  - Verifies node completeness, uniqueness, exact parent-child chains, unit scale tolerance, `socket_bodycam_mount` clearance, and cross-operator rest-axis parity (`dot > 0.999`).
  - `STRICT` mode (CI/tests) throws `RigContractViolationError`; `SAFE_FALLBACK` mode (runtime) logs structured error diagnostics and falls back to the verified `'MALE'` operator without crashing the render loop.

### Interactive Component & State Mapping
- **Operator Select Dock ↔ Preview Stage ↔ Selection Store**:
  - Clicking `Male` / `Female` updates the store, persists to `localStorage`, hot-swaps the validated rig on the turntable without resetting camera orbit, and updates the profile specification readout.
  - Changing uniform preview swatch calls `applyUniform(...)` on the active rig in place.
  - Pointer drag / wheel updates damped yaw, clamped pitch, and clamped zoom radius; clicking `Reset View` smoothly eases back to default framing; clicking `Hide Controls` collapses the bottom dock for unobstructed inspection.
  - Clicking `Deploy` disposes preview-only listeners/render targets (keeping cached rig assets) and launches the selected mode with the persisted operator.
- **Suppressor Field Toggle FSM (Phase 3)**:
  - **Ownership Gate**: Inspects active weapon's Gunsmith/default attachment state (`ownedSuppressorId`). If `null`, displays feedback toast and aborts — never fabricates a suppressor.
  - **State Machine**: `IDLE` → `TILT_WEAPON` (weapon rotates ~35° inward & slightly forward into chest-cam workspace; firing/ADS/reload blocked) → `REACH_MUZZLE` (left-hand IK blends from handguard to suppressor body; when attaching, hand first reaches `magPouchAnchor`/belt pouch to retrieve stowed suppressor and carries it to barrel threads) → `TWIST_THREAD` (3–4 ergonomic wrist twist cycles rotating the suppressor mesh smoothly along barrel axial translation with metallic thread/click Web Audio cues) → `STOW_OR_CLEAR` (detached suppressor travels with left hand to pouch and stows hidden; attached suppressor locks onto muzzle anchor and updates ballistic/acoustic derived stats) → `RETURN_GRIP` (left hand returns to forend/foregrip; firing unlocked).
  - **Input Guard**: While `action === 'SUPPRESSOR_ATTACH' | 'SUPPRESSOR_DETACH'`, trigger pulls, ADS raises, melee bashes, and reloads are blocked cleanly; weapon switching safely cancels and restores the pre-action state.

### Secondary Physics Tuning & Strict Clamp Specification
- **Fixed-Step Accumulator**: `FIXED_DT = 1 / 120`, `MAX_SUBSTEPS = 4`, frame delta clamped upstream to `<= 0.05 s`, zero heap allocations per frame.
- **Channel Bounds**:
  - **Female `CHEST_L / R`**: Stiffness `(160, 140, 180) N/m`, damping ratio `0.55`, mass `0.45 kg`, linear clamp `X ±8 mm`, `Y [-14, +10] mm`, `Z [-6, +10] mm`, rotation `±0.06 rad`, max velocity `0.45 m/s` (maintaining `>= 2 mm` clearance inside the `>= 18 mm` plate-carrier/strap standoff).
  - **Female `GLUTE_L / R`**: Stiffness `(210, 190, 220) N/m`, damping ratio `0.62`, mass `0.75 kg`, linear clamp `X ±6 mm`, `Y [-10, +8] mm`, `Z ±8 mm`, rotation `±0.04 rad`, max velocity `0.35 m/s`.
  - **Male `BICEP / TRICEP_L / R`**: Stiffness `(320, 300, 340) N/m`, damping ratio `0.78`, mass `0.35 kg`, linear clamp `X/Z ±3 mm`, `Y ±4 mm`, rotation `±0.02 rad`, max velocity `0.22 m/s`.
  - **Male `FOREARM_L / R`**: Stiffness `(420, 400, 420) N/m`, damping ratio `0.82`, mass `0.22 kg`, linear clamp `X/Z ±2 mm`, `Y ±3 mm`, rotation `±0.015 rad`, max velocity `0.18 m/s`.
  - Unused channels per operator are locked (`enabled: false`, zero offset).

### Five-Phase Verification & Acceptance Gates
- **Phase 1**: Persisted store round-trip + URL override + interactive `MALE` / `FEMALE` turntable preview dock inside Main Menu Hub.
- **Phase 2**: Rig parity validator (`STRICT` & `SAFE_FALLBACK`), asset loader (upgraded rigs + `.glb` drop-in), shadow-only head/helmet masking, and spawn integration in Playground & Combat modes.
- **Phase 3**: Weapon socket alignment (`< 0.5 mm` / `< 0.1°`), left-hand IK convergence (`< 3.0 mm` across idle/sprint/crouch/ADS/recoil/reload), centered ADS sightline, and realistic firing-blocked suppressor twist/stow gated on suppressor ownership.
- **Phase 4**: `120 Hz` SoA secondary spring solver with verified clamp saturation, zero heap allocations over `10,000` consecutive steps, and `< 0.35 ms` CPU frame budget.
- **Phase 5**: 15-node XPBD/Verlet ragdoll colliding with `BodycamPhysicsWorld` (`< 2.0 mm` / `< 0.5°` frame-0 handoff), Vitest unit & integration suites, and headless Playwright WebGL pose-matrix verification (`0°`, `-45°`, `-70°`, `-85°` pitch, sprint, crouch, ADS, reload, inspect, ragdoll) for both operators.
