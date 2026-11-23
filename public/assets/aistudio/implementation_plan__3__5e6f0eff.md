# Bone-Driven Tactical Grenade Overhaul, Diegetic Power Throw & Full AI Parity

Unify every grenade, flashbang, smoke, thermite, and throwable sequence across first-person gameplay, Survival mode, remote multiplayer operators, and AI bots onto strict hand-bone attachment, smooth Two-Bone pin-pull and left-pocket stowing IK, natural eye-line left-hand aiming, seamless click-to-lob vs. hold-to-charge diegetic throw strength, separate safety lever release (with live overcook detonation), smooth weapon stowing, and identical AI combat rules.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> All revised control ergonomics, diegetic feedback rules, left-hand aiming postures, and AI parity decisions below have been incorporated into this updated blueprint. Please review and approve to begin implementation.

- **RMB Pin Pull / Ready Aim & Separate Lever Release:** First `RMB` press pulls and pockets the safety pin (`PIN_PULLED`) and brings the operator into Ready Aim stance without starting the fuse; a separate second `RMB` press explicitly releases the safety lever/spoon (`LEVER_RELEASED`) to ignite the hidden-variance chemical delay fuse—and holding a live grenade past fuse burn detonates directly in the operator's or AI's hand.
- **Seamless LMB Underhand Lob vs. Hold-to-Charge Overhand Throw:** A quick `LMB` click performs an effortless **Underhand Lob** for close doorways and short cover, whereas holding `LMB` continuously winds up throw strength from moderate toss up to a realistic full-force heave and releases on `LMB` release.
- **Pure Diegetic Power Feedback (No UI Power Bar):** Throw force is communicated exclusively through progressive throwing-arm draw-back behind the shoulder, subtle upper-body wind-up twist, physical grip tension, and subtle bodycam camera tension—with zero HUD charge meter.
- **Natural Left-Hand Aiming Pose:** After pocketing the extracted safety pin into the operator's left pocket, the left arm smoothly raises to guide naturally **just below eye level** (offset slightly left-of-center so center vision stays clear) during overhand aiming/wind-up, and drops smoothly to a **lower chest balance posture** during underhand lobs.
- **Strict Bone Attachment, Weapon Stow & Whole-Game Parity:** Held grenades stay `.attach()`ed directly inside the right palm socket (`updateWorldMatrix(true, false)` enforced after IK evaluation), equipped firearms smoothly stow during ordnance handling, military pin-pocketing doctrine applies everywhere, Survival throwables gain matching mechanics, and AI bots receive role-based finite grenade pouches (Frag, Flash, Smoke, Thermite) using identical 4-stage animations, teammate-safe targeting, in-hand overcook risk, and live drops on death.

---

## 1. Overview & Core Concept

- **What It Does:** Replaces camera-mounted floating grenades and simplified Survival throwables with one unified, anatomically driven throwing system shared across local players, Survival mode, third-person remote operators, and AI bots. Every throwable stays welded inside the throwing hand's palm and fingers; the off-hand uses smooth Two-Bone IK to extract the brass pin along its physical axis, **pocket it inside the left thigh/hip pocket** per real-life training, and then rise naturally below eye level to aim the throw—while giving players fluid control over gentle click-lobs, hard charged heaves, and risky separate lever cooking.
- **Target Audience / Persona:** Bodycam tactical FPS and Survival players who rely on physical weapon/hand cues rather than arcade meters, and who expect AI squadmates and opponents to play by the exact same tactical ordnance rules.
- **Key Value:** Makes throwing intuitive and physical—no floating geometry, no UI charge-bar clutter, immediate click-vs-hold muscle memory for lob vs. power throw, and full tactical parity when fighting alongside or against AI bots.

---

## 2. User Experience & Visual Design

### Key User Flows
1. **Draw Grenade & Smooth Weapon Stow (`H` / `4` / `5` or Survival Throwable Slot):**
   - Drawing ordnance initiates a smooth weapon stow blend (`0 → 1`) that lowers and tucks away the equipped firearm into sling retention while the right throwing hand seats the grenade body firmly inside its palm (`gripOffset`), fingers wrapped around the canister and clamping the steel safety spoon (`DRAWN`).
   - Switching weapons or pressing the draw key again before releasing the lever safely holsters/re-pins the grenade (`0` spent) and smoothly re-draws the firearm. Switching away while `LEVER_RELEASED` immediately tosses the live burning grenade clear.
2. **Pull Pin, Pocket Pin & Ready Aim (`RMB` Press When `DRAWN`):**
   - Pressing `RMB` enters `PIN_PULLED` (fuse **not** yet burning while spoon remains clamped):
     - Smoothstep Two-Bone IK (`0 → 1`) with a calibrated elbow pole guides the left hand cleanly onto the grenade's live world `pinAnchor`, closes thumb and index finger into a pinch pose, detaches the pull ring via `.attach()` to the left fingers along `pinPullAxis`, and sweeps down to tuck the pin into the operator's **left pocket** (`leftPocketAnchor`)—never tossing pins to the ground.
     - Immediately after pocketing the pin, the left arm smoothly raises forward **just below eye level** (slightly left-of-center to frame depth without obstructing aim), placing the operator in natural Ready Aim stance while the right hand holds the live-pinned grenade at mid-ready beside the chest/shoulder.
3. **Separate Safety Lever Release / Cook (`RMB` Press When `PIN_PULLED`):**
   - Pressing `RMB` again while aiming explicitly pops the safety lever off (`LEVER_RELEASED`): the throwing hand fingers slightly lift off the lever, the physical `spoonGroup` springs off from `spoonAnchor` with outward spin and clatter, the striker snap sound plays, and the hidden-variance pyrotechnic fuse ignites.
   - Because fuse burn runs live in real time, holding onto a spoonless grenade past its burn window causes it to **detonate directly in hand** (*poof* explosion, concussion/damage, and ragdoll/elimination—for both humans and AI).
4. **Seamless Underhand Lob vs. Charged Overhand Throw (`LMB` When `PIN_PULLED` or `LEVER_RELEASED`):**
   - **Quick `LMB` Click (`< 0.18s` hold):** Seamlessly executes an **Underhand Lob**. The left aiming hand drops smoothly from eye height down to a natural **lower chest balance pose** while the right hand scoops upward from hip height, releasing a gentle, low-bounce close-quarters lob (`~9.5–10.5 m/s`).
   - **Hold `LMB` (`≥ 0.18s`) → Release `LMB`:** Seamlessly enters **Overhand Power Charge**. As `LMB` is held (`~0.18s → ~1.0s`), throw velocity ramps smoothly up to a realistic max heave (`~22.5 m/s`, holding steady at max force until release):
     - *Diegetic Communication (Zero UI Power Bar):* Right throwing arm cocks steadily farther back behind the right ear/shoulder, upper torso rotates into an athletic throw wind-up, subtle grip/hand strain micro-tremor emerges near peak force, and subtle bodycam FOV compression + lean conveys tension—keeping the screen HUD clean of power bars.
     - *Eye-Line Left Aiming Hand:* Left arm holds forward **just below eye level**, subtly extending and tracking aim pitch to act as a natural human throwing guide until the whipping follow-through of `LMB` release.
   - On the exact release frame after `updateWorldMatrix(true, false)`, the `grenadeBody` detaches from `throwHandSocket` into physics flight (automatically popping the spoon mid-air if thrown directly from `PIN_PULLED`), and the firearm smoothly re-draws.
5. **AI Bots & Remote Players (Identical Rules & Visuals):**
   - Battle bots (Assault, Breacher, Support roles) and Infection co-op squadmates carry finite pouches matching player carry limits (`4` Frags, `2` Flash, `2` Smoke, `2` Thermite), restocking on respawn or Infection waves.
   - AI bots execute the exact same sequence—stowing weapons, pulling & pocketing pins, optionally cooking levers before release, aiming with the left hand below eye level (for distant overhand throws) or chest-height balance (for `< 9m` underhand lobs), checking allied safety radius before throwing lethal ordnance, and **dropping or detonating live spoonless grenades at their hand** if interrupted/killed while cooking.

### Visual Identity & Diegetic Feedback
- **Pure Bodycam HUD:** Retain concise contextual prompt cues (`[RMB] Pull Pin`, `[RMB] Release Spoon · [LMB] Click Lob / Hold Throw`) and fuse hazard warning when live, with **no throw-power slider or progress bar** anywhere on the HUD.
- **Physical Fidelity:** All four grenade archetypes (`m67_frag`, `m84_flash`, `m18_smoke`, `an_m14_thermite`) plus Survival's `rgd5_frag` share multi-material PBR construction with distinct separable body, steel safety spoon, and brass cotter ring nodes (`throw_bolt` shares bone-locked lob/overhand throw physics and left-hand aim posture without fake pin/spoon parts).

---

## 3. Key Product Decisions & Trade-Offs

- **`RMB` (Pin Pull / Lever Release) + `LMB` (Click Lob vs. Hold Charge Throw)**
  - *Chosen Approach:* Map `RMB` sequentially (`DRAWN → PIN_PULLED` on first click, `PIN_PULLED → LEVER_RELEASED` on second click) and reserve `LMB` exclusively for throwing (`quick click = underhand lob`, `hold + release = charged overhand throw`).
  - *Why:* Separates preparation/cooking cleanly from throwing, preserves intentional safety-lever cooking (with real overcook danger), and gives instant one-button access to both gentle lobs and variable-force throws without extra mode-toggle keys.
  - *Alternatives Considered:* Using Middle Mouse for lob toggles—replaced per user direction for seamless single-button click-vs-hold feel.

- **Diegetic Arm & Camera Tension vs. HUD Charge Meter**
  - *Chosen Approach:* Communicate throw force strictly via throwing-arm draw-back angle, torso coil, subtle grip tension tremor, left aiming hand extension, and subtle camera tension—suppressing any on-screen throw force bar.
  - *Why:* Reinforces raw bodycam immersion and encourages players to read real body language in both 1P and 3P duels.
  - *Alternatives Considered:* Adding a 0–100% power bar or arc predictor—rejected per user feedback.

- **Eye-Level Aim Hand (Overhand) vs. Lower-Chest Balance (Underhand Lob)**
  - *Chosen Approach:* Target left hand IK to an eye-line spatial aim socket (`just below eye level, left of reticle`) after pin pocketing and during overhand charging, smoothly blending down toward a lower-chest balance anchor (`leftChestBalanceSocket`) whenever a quick click triggers an underhand lob.
  - *Why:* Matches authentic real-life throwing biomechanics (extended lead arm as range/elevation sight for overhand throws; compact core balance for underhand tosses) while keeping the center sight picture unobstructed.
  - *Alternatives Considered:* Keeping left hand fixed at chest height or raised during both throw types—rejected for less realistic silhouette contrast.

- **Hand-Bone `.attach()` Parenting + Left-Pocket Pin Tuck**
  - *Chosen Approach:* Eliminate the camera-attached viewmodel node completely; attach held grenades directly to the character skeleton's `throwHandSocket` and transfer the separated `pullRing` into `leftPinPinchSocket` during extraction before tucking it into `leftPocketAnchor`.
  - *Why:* Guarantees zero floating or animation lag across all stances and modes while faithfully reflecting military range/field pin-pocketing doctrine.
  - *Alternatives Considered:* Hiding the pin instantly on pull or dropping pins onto the ground—rejected.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Unified Bone-Driven Architecture & Input Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                 SHARED SEPARABLE ORDNANCE & ANCHOR DEFINITIONS               │
│  bodyGroup · spoonGroup · pullRingMesh                                       │
│  Sockets: gripOffset · pinAnchor · pinPullAxis · spoonAnchor                 │
│  (M67 Frag, M84 Flash, M18 Smoke, AN-M14 Thermite, Survival RGD-5 Frag)      │
└──────────────────────────────┬───────────────────────────┬───────────────────┘
                               │                           │
        ┌──────────────────────▼───────────┐   ┌───────────▼──────────────────┐
        │   1P SKELETON & SURVIVAL RIG     │   │  3P RIG & HOST-AUTH AI BOTS  │
        │ • throwHandSocket (hand_r palm)  │   │ • rightGlove grenadeSocket   │
        │ • leftPinPinchSocket +           │   │ • Role-based finite pouches  │
        │   leftPocketAnchor +             │   │ • Identical 4-stage FSM +    │
        │   leftEyeAimAnchor (below eye) + │   │   eye-level aim & lob logic  │
        │   leftChestBalanceAnchor         │   │ • Ally-safe throw gating     │
        │ • Skeleton updateWorldMatrix     │   │ • In-hand overcook & live   │
        │   before IK / release reads      │   │   drop at hand on death/stun │
        └──────────────────────┬───────────┘   └───────────┬──────────────────┘
                               │                           │
                               └─────────────┬─────────────┘
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│             THROW POWER, BALLISTICS & MULTIPLAYER SYNC LAYER                 │
│  • Seamless LMB detector: click (<0.18s) -> Lob (lower chest balance)        │
│                           hold (>=0.18s) -> Overhand Charge (0..100% force)  │
│  • Diegetic tension (arm draw-back + torso twist + FOV/camera compression)   │
│  • Release frame: grenadeBody detaches from bone ─► world projectile vel     │
│  • 20 Hz Handling Action Sync + Relayed Grenade/Spoon/Drop Events             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Revised 4-Stage Manual of Arms & Dual-Hand IK Flow

```
 [ HOLSTERED ] ── Draw (H/4/5) / AI Trigger ──► Weapon Stows Smoothly (0→1)
       ▲                                                │
       │ Swap/Holster (before lever off:                ▼
       │ re-pins cleanly, 0 spent)            [ DRAWN (Pin Intact) ]
       │                                       • Grenade .attach() to RightHand
       │                                       • Fingers wrap body + clamp spoon
       │                                                │
       │                                          RMB Press (1st)
       │                                                ▼
       │                                      [ PIN_PULLED (Ready Aim) ]
       │                                       • 2-Bone IK (0→1): LeftHand tracks
       │                                         live pinAnchor ─► pulls pin along
       │                                         pinPullAxis ─► tucks in leftPocket
       │                                       • LeftHand rises below eye level
       │                                         to aim throw (Reticle clear!)
       │                                       • Fuse STOPPED (spoon still held)
       │                                                │
       ├─────── LMB Click/Hold ─────────────┬── RMB Press (2nd, Optional Cook)
       │        (releases spoon mid-air)    │           ▼
       │                                    │  [ LEVER_RELEASED (LIVE FUSE!) ]
       │                                    │   • Right fingers lift off spoon
       │                                    │   • spoonGroup springs off from
       │                                    │     live spoonAnchor w/ spin
       │                                    │   • Overcook timer ─► POOF!
       │                                    │     (detonates in hand if too long)
       │                                    │           │
       │                                    ▼           ▼
       │                           [ LMB INPUT EVALUATION ]
       │                            ├── Quick Click (<0.18s):
       │                            │     UNDERHAND LOB (low scoop velocity,
       │                            │     LeftHand lowers to chest balance)
       │                            └── Hold (>=0.18s) ─► Release:
       │                                  OVERHAND CHARGE (arm draws behind ear,
       │                                  diegetic tension, LeftHand stays below
       │                                  eye aiming; launches on LMB release)
       │                                                │
       ▼                                                ▼
 [ POST-THROW ] ◄─── Exact Release Frame ──── Grenade Detaches from Hand Bone
  • Firearm smoothly un-stows (1→0)            (Projectile inherits bone pos &
  • 3P / AI syncs projectile & spoon            charged force + body velocity)
```

### Subsystem State & Responsibility Mapping
- **Separable Ordnance & Socket Contracts:** Expose separated `bodyGroup`, `spoonGroup`, and `pullRingMesh` along with calibrated `gripOffset`, `pinAnchor`, `pinPullAxis`, and `spoonAnchor` across tactical grenades and Survival's `rgd5_frag`. Survival's `throw_bolt` uses the same bone-locked `throwHandSocket`, eye-level / chest-balance left hand, and click-lob vs. hold-charge physics without pin/spoon stages.
- **Skeleton Sockets, Matrix Order & Dual-Hand IK (`CharacterAnimator` — Bodycam & Survival):**
  - Add `throwHandSocket` (right palm), `leftPinPinchSocket` (left thumb/index opposition), `leftPocketAnchor` (left thigh/hip pocket), `leftEyeAimAnchor` (naturally extended just below eye level and slightly left of center), and `leftChestBalanceAnchor` (compact lower-chest balance during underhand lobs).
  - Call `skeleton.root.updateWorldMatrix(true, false)` after upper-body/right-arm solving so `pinAnchor`, `spoonAnchor`, and release transforms read current-frame positions cleanly.
  - Drive smoothstep (`0 → 1 → 0`) Two-Bone IK with elbow pole targets across the three sub-phases (`Pin Extraction → Left-Pocket Tuck → Eye-Level Aiming / Lob Balance`), plus progressive right-arm draw-back (`charge01: 0 → 1`) behind the shoulder, torso wind-up yaw, finger-lift release on spoon pop, and zero-allocation scratch vector reuse.
- **Bodycam Tension & Clean HUD Prompts:**
  - Apply subtle diegetic camera FOV tighten, posture lean, and hand micro-strain scaled by `charge01` + live-cook adrenaline—with zero throw-power HUD progress bar.
  - Update minimal HUD control hints dynamically per stage (`[RMB] Pull Pin` → `[RMB] Release Spoon · [LMB] Click Lob / Hold Throw` → `[LMB] Click Lob / Hold Throw` + live fuse hazard state), handling focus loss / pointer unlock cleanly so held states never stick.
- **Host-Authoritative AI Bots & Multiplayer Sync:**
  - Upgrade `BattleBotAI` so bots hold finite role-based ordnance counts visible on belt pouches, run the identical 4-stage grenade FSM (`DRAWN → PIN_PULLED → LEVER_RELEASED → CHARGE/THROW`), cook grenades tactically behind cover before peeking, pick Overhand power vs. `< 9m` Underhand Lob dynamically, respect ally blast clearance, suffer real in-hand detonation if stunned/overcooked while `LEVER_RELEASED`, and drop burning ordnance on death.
  - Extend `SyncedHandlingAction`, player/bot sync states (`equipmentId`, `charge01`, `throwStyle`), and server-validated `game:grenade_event` messages across both Cloudflare Durable Objects and local preview relay guards so remote players and bots animate every pin pull, pocket tuck, eye-level aim, flying spoon, throw release, and live drop identically.

### Verification Strategy
- **Bone Lock & Pin Pocketing Check:** Verify across Gym, Battle, Infection, and Survival that grenades sit tightly in the palm during aggressive movement/leaning/crouching/vaulting; confirm the left hand cleanly pinches `pinAnchor`, pulls the ring along `pinPullAxis`, tucks it into `leftPocketAnchor`, and raises naturally just below eye level to aim without occluding the reticle.
- **Control Flow & Diegetic Power Check:** Verify `RMB` pulls pin cleanly without burning fuse, a second `RMB` pops the flying spoon and starts live fuse (detonating in hand with full blast/damage if held too long), quick `LMB` clicks execute low-chest underhand lobs, holding `LMB` visibly winds up arm draw-back & camera tension with zero HUD power bar, and releasing `LMB` launches proportionally to charge duration.
- **Weapon Stow & AI/MP Parity Check:** Verify equipped firearms stow smoothly and return cleanly on throw or safe re-pin cancel; watch AI bots in Battle & Infection pull pins, pocket them, release spoons, lob over low cover or heave long frags/flashes/smokes/thermites, avoid friendly fire, drop live cooked grenades if eliminated, and synchronize accurately across connected multiplayer clients.
- **Compilation & Lint Gate:** Run TypeScript lint/type checks and full client + worker build checks cleanly once implementation finishes.
