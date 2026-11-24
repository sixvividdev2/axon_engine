# Realistic Character Faces, Global Z-Fighting Elimination & Starter Pump Shotgun Unlock

This update eliminates surface flickering and depth-buffer Z-fighting across every 3D scene in the game, places the first pump shotgun at the top of the Shotguns category unlocked from Rank 1 across all modes, and upgrades all human operators, AI factions, and infected zombies with realistic anatomical heads, independent eyeball gaze tracking, morph-target facial expressions, and Locker face-gear customization.

## User Review & Critical Decisions

> [!IMPORTANT]
> The decisions below reflect your confirmed choices from Phase 1 and lock in our implementation direction before modifying code.

- **Confirmed Decision 1 — Starter Pump Shotgun Order & Unlock**: The starter pump shotgun (**Remington 870 Police Magnum**, alongside its legacy pump alias) will be positioned **first** in the Shotguns category list and start unlocked at Rank 1 across Career Progression, Loadouts, the Hideout Gun Wall, and both PMC Alpha & PMC Bravo Open World starter kits (with the **Mossberg 590A1** right behind it in the pump lineup).
- **Confirmed Decision 2 — Operator Face Visibility & Locker Management**: AI operators and factions will use a realistic mix of **Open Face** and **Lowered Half Neck Gaiter** presets (with optional clear ballistic eyewear) so eyes, brows, and facial micro-expressions read clearly in close quarters. Players can manage their own operator's **Face Gear** (`Open Face`, `Neck Gaiter`, `Full Balaclava`) and **Eyewear** (`None`, `Clear Ballistic Glasses`, `Tinted Visor`) directly in the **Operator Locker** (both from the Main Menu and the Hideout Ready Room Locker) with a dedicated **Face Close-Up** camera toggle.
- **Confirmed Decision 3 — Global Z-Fighting Audit Scope**: Z-fighting and geometry flickering will be fixed across **all scenes** — first-person weapons/rails/attachments, combat maps/doors/decals, Open World buildings/roads/terrain/FOB compounds, Hideout & Zombies Outpost interiors, and the 3D Operator Preview turntable.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Zero-Flicker Rendering Across All Modes**: Eliminates coplanar overlapping geometry, tightens world/viewmodel camera near-far frustum ratios for crisp 24-bit depth precision, and applies proper depth offsets and `polygonOffset` bias to all surface decals, rails, wall trims, floor strips, and stage pedestals.
  2. **Immediate Pump Shotgun Access**: Reorders the Shotguns category so the Rank 1 starter pump shotgun sits cleanly at slot #1 and is immediately usable from a player's very first session in Battle, Infection, Hideout, Gunsmith, and Open World (both PMC Alpha and PMC Bravo).
  3. **Expressive, Living Characters (Human & Infected)**: Replaces legacy sphere/box heads with a shared anatomical head mesh featuring 15 baked morph targets (`morphTargetInfluences`), independent left/right eyeball pivots with micro-saccades and smooth gaze pursuit, vertical eyelid-to-gaze follow-through, and state-driven facial expressions — subtle, composed micro-expressions for tactical operators/AI (`0.10–0.45` blend range) and visceral, asymmetric snarls/flinches for zombies (`0.55–1.0+` blend range) — all gated by distance LOD to stay well inside the `<= 7.0ms` RX 480 frame budget.
- **Target Audience / Persona**: Tactical FPS players engaging in close-quarters bodycam gunfights, Infection survival rounds, Open World FOB interactions, and operator customization in the Locker.
- **Key Value**: Removes distracting visual flicker across every environment and firearm, gives new players immediate breacher shotgun capability at the top of the Shotguns tab, and makes close-quarters encounters with squadmates, hostile factions, and zombies feel startlingly alive and grounded.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Operator Locker & Face Customization (Main Menu + Hideout Locker)**:
   - Player opens the Operator Locker (from Main Menu or by interacting with the Ready Room Locker in the Hideout).
   - Inside the bottom dock, a new **Face & Eyes** tab sits alongside *Operator & Uniform*, *Gloves*, and *Helmet & NVG*.
   - Selecting **Face Gear** (`Open Face`, `Neck Gaiter`, `Full Balaclava`) or **Eyewear** (`None`, `Clear Glasses`, `Tinted Visor`) updates the 3D operator live and persists immediately across all game modes.
   - Clicking the **Inspect Face** camera toggle smoothly glides the turntable camera to a close-up portrait framing where the player sees natural eye blinking, micro-saccades, cornea glint, and live gaze tracking toward the camera, plus a quick expression preview selector (*Calm*, *Alert*, *Under Fire*).
2. **Armory & Starter Pump Shotgun Flow**:
   - A brand-new Rank 1 player opens the Armory / Loadout Workbench, clicks **Shotguns**, and sees the starter pump shotgun right at the top of the list — unlocked, selectable, and ready to customize or take into the Hideout Gun Range, Battle, Infection, or Open World (including both PMC Alpha and PMC Bravo starter kits).
3. **Close-Quarters Combat & Infection Encounters**:
   - **Allied & Hostile Operators**: Within 25m, operators subtly scan their sector with micro-saccades, narrow their brows and squint slightly while aiming/ADS, clench their jaw and blink rapidly when suppressed or hit, and wear varied open-face / half-gaiter tactical kits.
   - **Zombies (Infection & Survival)**: Shambling zombies display uneven drooping eyelids, slack open jaws, and erratic twitching eyes; spotting or lunging at the player snaps their gaze onto the camera with wide crazed eyes, flared upper lips, snarling mouth corners, and hit-synced flinch grimaces.
4. **Flicker-Free Visual Inspection**:
   - Inspecting firearms in ADS or Gunsmith, walking through Hideout/Zombies Outpost rooms, crossing Open World roads/FOB courtyards, or fighting inside combat maps shows solid, crisp edges with zero shimmering surfaces.

### Visual Identity & Theme

- **Aesthetic Direction**: Gritty, grounded tactical bodycam realism — muted matte skin with realistic moisture variation (matte cheeks/forehead, subtly glossier lips, eyelids, and wet cornea specular highlight) rather than plastic or cartoonish shading.
- **Skin & Wear Variation**:
  - *Operators*: Natural skin-tone variation across bots/factions with subtle pore grain, brow shading, faint cheek/jaw shadow, and optional combat grime/sweat/blood wear that intensifies when injured.
  - *Zombies*: Mottled necrotic pallor, sunken orbital shadows, subdermal veining, coagulated mouth/jaw bloodstains, and bloodshot/cloudy sclera that darken and look unsettlingly locked-on under flashlight or NVG beams.
- **Locker UI Continuity**: Matches the existing matte tactical slate dock (`#0d1014`, `#12161c`, sharp `border-neutral-800` frames, amber `#f59e0b` active states, `font-display` + `font-mono-tabular`, zero `backdrop-blur`, zero viewport occlusion).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Shared Morph Targets (`morphTargetInfluences`) Over Per-Entity Face Skeletons**
  - *Chosen Approach*: Bake a compact, standardized 15-shape morph target dictionary into a single shared anatomical head `BufferGeometry` (`brow_inner_up`, `brow_outer_up`, `brow_furrow_down`, `eye_blink_l`, `eye_blink_r`, `eye_squint_l`, `eye_squint_r`, `eye_wide`, `cheek_raise`, `sneer_snarl_l`, `sneer_snarl_r`, `jaw_open`, `mouth_tense_grimace`, `lip_pull_upper`, `lip_corner_snarl`), paired with lightweight per-character eyeball pivot nodes (`eye_l`, `eye_r`).
  - *Why*: GPU vertex morph blending on a single shared geometry costs a fraction of a millisecond across dozens of bots/zombies while preserving distinct anatomical deformation around brows, eyelids, cheeks, nose, and jaw.
  - *Alternatives Considered*: Adding 15–20 extra skinning bones per character face would multiply matrix uploads and blow past the `<= 7.0ms` RX 480 budget in 18-zombie hordes or dense Open World firefights.

- **Decision 2 — Distance-Tiered Facial LOD & Zero-GC Updates**
  - *Chosen Approach*: Run full per-frame gaze pursuit, micro-saccades, eyelid coupling, and spring-damped morph blending only for visible characters within `25m`; step blinks/major state changes at reduced cadence between `25m–35m`; freeze facial ticks beyond `35m`. Pre-allocate all scratch vectors and state arrays with zero heap allocations inside `update()`.
  - *Why*: Facial micro-expressions and eye saccades are visually imperceptible past ~30m on a 1080p bodycam view, so culling distant updates keeps frame times locked with zero GC stutter.
  - *Alternatives Considered*: Updating every spawned entity across a 4km Open World map every frame would waste CPU cycles on off-screen or distant silhouettes.

- **Decision 3 — Geometric Separation + Frustum Tightening Over Global `logarithmicDepthBuffer`**
  - *Chosen Approach*: Fix actual root-cause coplanar overlaps across procedural weapons, maps, Hideout, Open World, and preview stages by introducing physical clearance (`>= 2mm` on close-up weapon/character attachments, `>= 10–25mm` on architectural/terrain slabs), adding `polygonOffset` only on true surface decals/markings, and tightening world camera `near`/`far` ratios (`near >= 0.08–0.12` on interior/arena cameras, `>= 0.25` on Open World, `far / near <= 16,000`).
  - *Why*: Physically separating coplanar surfaces eliminates flickering cleanly at every angle without breaking custom shaders, Scope Picture-in-Picture rendering, or adding `gl_FragDepth` GPU overhead.
  - *Alternatives Considered*: Enabling `logarithmicDepthBuffer: true` globally disables early-Z GPU rejection and can break custom `ShaderMaterial` depth outputs (scope lenses, fog, water, post-processing).

- **Decision 4 — Clean Neck Seam & Modular Headgear Compatibility**
  - *Chosen Approach*: Taper the anatomical head's lower neck cylinder to meet the torso collar cleanly, and size the **Neck Gaiter**, **Full Balaclava**, **Clear Ballistic Glasses**, **Tinted Visor**, and **MICH / Mil-Tec Helmets** with explicit radial clearance so every headgear combination fits without clipping into cheeks, nose, or brow during extreme expressions.
  - *Why*: Prevents facial morph deformations (jaw opening, brow furrow, snarling) from poking through masks or eyewear and eliminates face/mask Z-fighting.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### System Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         SHARED FACIAL RIG ENGINE                           │
│                                                                            │
│  ┌──────────────────────────┐       ┌───────────────────────────────────┐  │
│  │ Anatomical Head Geometry │       │     FacialExpressionController    │  │
│  │  • Sculpted edge loops   │       │  • FacialState machine (Human &   │  │
│  │  • 15 baked morph targets│──────▶│    Zombie profiles)               │  │
│  │  • PBR skin/roughness map│       │  • Spring/damp weight blender     │  │
│  │  • Recessed eye sockets  │       │  • Eye Gaze + Micro-Saccades      │  │
│  │  • eye_l / eye_r pivots  │       │  • Eyelid-to-pitch coupling       │  │
│  └──────────────────────────┘       │  • 25m / 35m Distance LOD culler  │  │
│                                     └─────────────────┬─────────────────┘  │
└───────────────────────────────────────────────────────┼────────────────────┘
                                                        │
        ┌─────────────────────────┬─────────────────────┼────────────────────┐
        ▼                         ▼                     ▼                    ▼
┌───────────────────┐   ┌───────────────────┐  ┌─────────────────┐  ┌────────────────┐
│ Operator Locker & │   │ Tactical Operators│  │ Infection Horde │  │ Survival       │
│ Local Skeleton    │   │ (Bots, Remote     │  │ Zombies         │  │ Zombies        │
│ • Face Gear & Eye │   │  Players, OW AI)  │  │ • Exaggerated   │  │ • Shared head  │
│   Gear Config     │   │ • Mixed Open-Face │  │   0.55–1.0+     │  │   & snarl/hit  │
│ • Live Portrait   │   │   & Neck Gaiter   │  │   snarl/jaw     │  │   expressions  │
│   Gaze Tracking   │   │ • 0.10–0.45 micro │  │ • Locked-on     │  │                │
│                   │   │   expressions     │  │   erratic gaze  │  │                │
└─────────┬─────────┘   └───────────────────┘  └─────────────────┘  └────────────────┘
          │ persists to
          ▼
┌────────────────────────────────────┐      ┌────────────────────────────────┐
│ Operator Gear Store (localStorage) │      │ Weapon Catalog & Progression   │
│ • faceGear: open | gaiter | mask   │      │ • Pump Shotgun #1 in Shotguns  │
│ • eyewear: none | clear | tinted   │      │ • Unlocked at Rank 1 & Starters│
└────────────────────────────────────┘      └────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│                 ENGINE-WIDE Z-FIGHTING ELIMINATION PASS                    │
│                                                                            │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ Camera Frustum │  │ Coplanar Offset │  │ Decal & Trim PolygonOffset  │  │
│  │ Tightening     │  │ & Separation    │  │ Standardization             │  │
│  │ • Near/Far cap │  │ • Weapons/Rails │  │ • Bullet holes, blood,      │  │
│  │ • Preview deck │  │ • Maps & Doors  │  │   paintings, signs, floor   │  │
│  │   separation   │  │ • Hideout/Range │  │   lines, road stripes       │  │
│  │                │  │ • Open World    │  │ • Automated regression test │  │
│  └────────────────┘  └─────────────────┘  └─────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **Facial Morph Target Spec (Shared 15-Target Contract)**:
  - *Brows*: `brow_inner_up`, `brow_outer_up`, `brow_furrow_down`
  - *Eyes & Lids*: `eye_blink_l`, `eye_blink_r`, `eye_squint_l`, `eye_squint_r`, `eye_wide`
  - *Cheeks & Nose*: `cheek_raise`, `sneer_snarl_l`, `sneer_snarl_r`
  - *Mouth & Jaw*: `jaw_open`, `mouth_tense_grimace`, `lip_pull_upper`, `lip_corner_snarl`
- **Facial State Input (`FacialExpressionState`)**:
  - `mode`: `'human' | 'zombie'`
  - `intent`: `'calm' | 'alert' | 'aiming' | 'suppressed' | 'injured' | 'shamble' | 'aggro' | 'lunge' | 'stagger' | 'dead'`
  - `stress01`, `injury01`, `flinchImpulse01`, `gazeTargetWorld` (or local yaw/pitch), `distanceToCameraM`, `isVisible`
- **Operator Locker Gear Extension (`OperatorGearConfig`)**:
  - `faceGear`: `'open_face' | 'neck_gaiter' | 'balaclava'` (default `'neck_gaiter'` so eyes, brows, and upper face are immediately visible out of the box)
  - `eyewear`: `'none' | 'clear_glasses' | 'tinted_visor'` (default `'none'` or `'clear_glasses'` for clear eye visibility)
  - Persisted cleanly inside the existing versioned gear storage key with backward-compatible normalization for existing saved profiles.
- **Starter Pump Shotgun Order & Unlock Consistency**:
  - Reorder the Shotguns catalog so the Rank 1 starter pump shotgun (**Remington 870 Police Magnum**) appears **first** in the Shotguns list, guaranteed unlocked at Rank 1 in Career Progression, Hideout Gun Wall, Loadout defaults, and both PMC Alpha & PMC Bravo Open World starter kits.

### Interactive Component & State Mapping

- **Locker Face & Eyes Tab**:
  - Clicking a **Face Gear** button (`Open Face`, `Neck Gaiter`, `Balaclava`) updates the persisted operator gear store, hot-swaps the mask geometry on the live 3D preview operator without recreating the WebGL context, and propagates to Battle, Infection, Hideout, Zombies Outpost, Gym, and Open World sessions.
  - Clicking an **Eyewear** button (`None`, `Clear Glasses`, `Tinted Visor`) swaps between exposed eyes, translucent anti-glare ballistic lenses (with `depthWrite: false` and proper `renderOrder` so eyes remain razor-sharp behind glass), and dark ballistic visors.
  - Clicking **Inspect Face** smoothly damps the preview orbit camera onto the operator's head (`y ≈ 1.62m`, close portrait distance) while the operator's eyes naturally track the camera and blink; clicking again or double-clicking resets to full-body framing.
  - Optional expression preview buttons in Face Inspect (*Calm*, *Alert*, *Combat*) let players test live brow/eye/jaw morph targets directly in the Locker.
- **AI & Combat Integration**:
  - Battle bots, Open World PMC/Sub-Faction AI, and Remote Players assign deterministic mixed `faceGear` (`open_face` / `neck_gaiter`) and `eyewear` (`none` / `clear_glasses`) per unit, driving their `FacialExpressionController` from live combat states (patrol -> `calm`, spotting/ADS -> `aiming`, taking fire/recoil/flinch -> `suppressed`/`injured`) and aiming their eyeballs at their target or aim vector.
  - Infection horde zombies and Survival zombies drive exaggerated asymmetric morph weights (`0.55–1.0+`), erratic shambling eye saccades, locked-on aggro stares, wide snarling jaws synchronized with melee lunges/plank tearing, and sharp hit-stagger flinches.
- **Z-Fighting Verification & Regression Suite**:
  - Systematic pass across procedural weapons/attachments (Picatinny rail clearance, optic clamp offset, receiver plates, barrel/muzzle sleeves), combat maps/doors (frames, rugs, signs, barricades, trim), Hideout/Outpost/Gym (floor mats, gun wall backings, target plates, range partitions), Open World (road-to-terrain offset, FOB concrete pads, prop bases), and Operator Preview Stage (separating the coplanar plinth/deck top faces).
  - Expand automated tests to verify zero coplanar overlaps, valid camera near/far precision ratios, all 15 morph target names + finite weights + distance LOD culling, and first-slot Rank 1 pump shotgun availability.
