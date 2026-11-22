# Stance-Coupled Recoil: Cheek-Weld Camera Shake vs. Hip-Fire Arm Sway

Split weapon firing recoil into two physically authentic biomechanical channels based on how the firearm is braced against the body: aiming down sights transfers crisp recoil shock directly through the cheek weld into the head and vision while keeping the weapon tightly controlled, whereas hip-firing isolates the camera and shifts recoil energy into looser horizontal arm and weapon sway.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> All four feel and tuning preferences were confirmed during discovery and are locked into this design. Review the stance matrix and tuning controls below before approving execution.

- **Confirmed Decision 1 — Tactical Point Aim Blend**: Point Aim sits halfway (`50%`) between full ADS cheek-weld camera shake and loose hip-fire arm sway, reflecting an off-cheek canted brace with moderate sight stability.
- **Confirmed Decision 2 — ADS Camera Shake Character**: Crisp cheek-weld jolt with fast-settling pitch/yaw impulse, subtle roll kick, and micro-translation punch—visceral in vision while keeping iron sights, red dots, and reticles clearly readable for follow-up shots.
- **Confirmed Decision 3 — Hip-Fire Horizontal Arm Sway**: Organic side-to-side horizontal swing and yaw drift that alternates polarity naturally and builds amplitude during sustained rapid fire, visibly moving both the weapon and IK-locked arms while leaving the player's view steady.
- **Confirmed Decision 4 — Magnified Optics & Live Tuning**: Magnified PiP scopes receive moderate attenuation (~68% of standard ADS shake) to keep long-range glass trackable, and two live sliders are exposed in both the Calibration Gym Tuner and Survival Rig Tuner so you can dial both channels in real time.

---

## 1. Overview & Core Concept

- **What It Does**: Replaces the current stance-blind recoil model—where ADS and hip-fire deliver identical viewmodel kick and identical mild chest-camera jolt—with a biomechanically grounded **Stance-Coupled Recoil Split** across both the Calibration Gym and Survival modes.
- **Target Audience / Persona**: Tactical shooter players testing 42+ weapons and optics in the Calibration Gym or surviving firefights in Cordon-04 who want authentic bodycam gunfeel where stance choice physically changes *what* shakes and *how* the gun behaves.
- **Key Value**:
  - **Real-world cheek-weld sensation in ADS**: Pressing the stock to your shoulder and cheek locks the firearm down (less wild barrel wander, tighter sight control) while transmitting crisp concussion and snap straight into your head and camera view.
  - **Physical hip-fire instability without nauseating camera bounce**: Firing from the hip keeps the horizon and vision calm while your arms, wrists, and firearm absorb the recoil through lively lateral swing, barrel yaw, and roll instability—naturally rewarding ADS for precision without artificial crosshair bloom.

---

## 2. User Experience & Visual Design

### Stance-by-Stance Firing Feel

| Stance | Cheek-Weld Coupling | Camera / Vision Shake | Weapon & Arm Stability |
| --- | :---: | --- | --- |
| **Primary ADS** | `1.00` (Full) | Crisp pitch/yaw snap, subtle roll jolt, micro-translation cheek punch; tamed to `~0.68x` on magnified PiP scopes | Tightly braced: reduced muzzle flop, controlled viewmodel climb, minimal horizontal arm sway |
| **Canted Optic ADS** | `0.92` (Near-Full) | Nearly full cheek-weld camera jolt matching an angled stock weld | Tightly braced with slight canted roll compliance |
| **Tactical Point Aim** | `0.50` (Halfway) | Balanced mid-level camera jolt—noticeable punch without full cheek-weld rattle | Mid-level horizontal arm sway and moderate rapid-fire wander |
| **Hip Fire (Non-ADS)** | `0.00` (Off-Cheek) | Minimal camera disturbance (`~0.25x` sympathetic jolt, negligible roll) so vision stays steady | Looser grip: amplified horizontal lateral arm swing, alternating rapid-fire side-to-side sway, stronger roll & free-aim climb |

### Key User Flows

1. **Hip-Fire Tap vs. Burst**:
   - Single hip-fire shots kick the firearm backward and nudge the weapon and IK-locked arms horizontally with a natural wrist twist while the camera horizon barely flinches.
   - Holding full-auto or firing rapid semi-auto bursts ramps `rapidFireHeat`, driving an organic alternating left-right horizontal swing through the weapon pivot and both IK arms—making hip-fire feel physically untamed and less stable without shaking your head.
2. **Primary & Canted ADS Firing**:
   - Raising sights locks the stock into your shoulder and cheek. Firing now delivers a crisp, high-frequency camera shake (pitch impulse, micro yaw vibration, subtle roll snap, and a tight cheek-punch position jolt) that rattles your vision briefly and settles cleanly back onto target.
   - Simultaneously, the relative viewmodel climb, lateral displacement, and rotational flop are dialed down so your optic and reticle stay composed and controllable.
3. **Magnified PiP Scope Firing**:
   - When aiming through magnified glass (LPVO, PSO, sniper optics), the ADS cheek-weld camera shake automatically scales down to `~68%` so recoil still feels tactile and punchy without ripping the target out of the scope eye-box.
4. **Live Calibration in Both Tuners**:
   - Opening the Calibration Gym Tuner (`F1` -> **Weapon & Mic** tab) or Survival Rig Tuner (`F1` -> **Free-Aim Controller** section) presents two new live sliders right alongside existing weapon feel controls:
     - **ADS Cheek-Weld Camera Shake** (`0.00x` – `2.00x`, default `1.00x`)
     - **Hip-Fire Arm Recoil Sway** (`0.00x` – `2.00x`, default `1.00x`)
   - Changes take effect immediately on the next shot, persist through Gym JSON config export, and reset cleanly via **Reset Defaults**.

### Visual Identity & Theme

- **Aesthetic Direction**: Preserves the existing utilitarian tactical bodycam interface—zero new chrome or modal clutter.
- **Color Palette & Tokens**: Matches the existing matte charcoal surfaces (`bg-[#121518]` / `bg-neutral-950/95`), neutral structural borders (`border-neutral-800`), crisp neutral labels (`text-neutral-300`), and high-contrast amber active readouts (`text-amber-300` / `accent-amber-400`).
- **Typography & Hierarchy**: Uses the existing `font-mono-tabular` numeric readouts (`1.00x`) aligned right against compact `11px`–`12px` labels inside the existing slider row pattern.
- **Interactive Feedback & Motion**: All recoil channels are driven by frame-rate-independent 2nd-order damped springs—no jittery random frame offsets—yielding smooth organic acceleration, crisp impact peaks, and natural biomechanical settle.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Separate High-Frequency Camera Cheek-Weld Springs from Slow Sympathetic Body Jolt**
  - *Chosen Approach*: Keep the existing low-frequency sympathetic torso/chest recoil (`sympPitch`, `sympYaw`) for subtle body recoil while adding dedicated, higher-frequency **cheek-weld camera shake springs** (`camShakePitch`, `camShakeYaw`, `camShakeRoll`, `camShakePosX`, `camShakePosY`) that activate in proportion to `cheekWeldFactor` (`ADS = 1.0`, `CANTED_ADS = 0.92`, `POINT_AIM = 0.50`, `HIP = 0.0`).
  - *Why*: Simply cranking up the slow sympathetic spring would make ADS feel mushy and floaty like boat sway. A faster spring (`ω ≈ 26–34 rad/s`, slight underdamping `ζ ≈ 0.68`) creates the unmistakable crisp real-life slap against your cheekbone and vision while recovering fast enough to keep sights readable.
  - *Alternatives Considered*: Post-process screen-space UV shake was rejected because true 3D camera rotation + micro-translation naturally integrates with PiP scopes, 3D collimated optics, optic parallax, and whip shutter motion blur.

- **Decision 2 — Dedicated Horizontal Recoil Sway Springs Coupled Directly to Arm IK**
  - *Chosen Approach*: Add dedicated horizontal recoil translation (`recoilX`) and horizontal barrel yaw (`recoilYaw`) 2nd-order springs inside the weapon rig pose pipeline, driven by an alternating-polarity impulse that scales up with `rapidFireHeat` when off-cheek (hip-fire / point-aim). Because both arms are hard-locked to the firearm's grip and forend sockets via 2-bone IK every frame, swaying the weapon pivot horizontally automatically sways the entire arms/forearms/wrists assembly organically.
  - *Why*: Keeps the gun and hands 100% locked with zero hand-slip while visually shifting hip-fire recoil into the arms and weapon body rather than the camera.
  - *Alternatives Considered*: Animating elbow/shoulder pole offsets separately risked detaching hands from the weapon grip or fighting the IK solver.

- **Decision 3 — Decouple Camera Cheek-Weld Jolt from Viewmodel Base Alignment**
  - *Chosen Approach*: Apply the ADS camera shake cleanly to the rendered camera transform while letting the weapon's ADS sight alignment follow a steadier shoulder/head reference with controlled viewmodel recoil. That way, in ADS the camera/vision visibly shakes *more* than the braced viewmodel flops around, whereas in hip-fire the camera barely moves while the viewmodel and arms swing freely.
  - *Why*: If the weapon rig rigidly copied 100% of camera shake identically with zero relative damping, the gun would appear glued to the screen bezel rather than feeling physically braced in the shooter's hands while their head/vision jolts.

- **Decision 4 — Unified Behavior Across Both Calibration Gym and Survival Modes**
  - *Chosen Approach*: Implement identical stance-coupled recoil physics, magnified scope attenuation, and live Tuner sliders in both the standalone Bodycam SDK (Calibration Gym) and the Survival controller/rig pipeline, while ensuring non-firearm recoil impulses (melee swings, grenade blast shock, damage flinch) retain natural shock behavior.
  - *Why*: Ensures weapon feel calibrated in the Gym translates 1:1 into Survival firefights.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### System Architecture & Recoil Routing Diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         FIRE / RECOIL TRIGGER                             │
│    (Weapon Recoil Pitch/Yaw/KickBack + Caliber/Attachment Multipliers)    │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     STANCE COUPLING EVALUATOR                             │
│  Stance: HIP (0.00) │ POINT_AIM (0.50) │ CANTED_ADS (0.92) │ ADS (1.00)  │
│  + Magnified Scope Attenuation (~0.68x on PiP Optics)                     │
│  + Live Tuner Scales (adsCameraShakeScale, hipRecoilSwayScale)            │
└──────────────────┬───────────────────────────────────────┬────────────────┘
                   │                                       │
       [Camera / Cheek-Weld Channel]           [Arm & Weapon Stability Channel]
       Stronger in ADS · Minimal in Hip        Tighter in ADS · Stronger in Hip
                   │                                       │
                   ▼                                       ▼
┌─────────────────────────────────────┐ ┌───────────────────────────────────┐
│      BODYCAM CAMERA SPRINGS         │ │        WEAPON RIG SPRINGS         │
│  • Slow body recoil (sympPitch/Yaw) │ │  • recoilZ, recoilPitch, Roll     │
│  • Fast cheek-weld jolt:            │ │  • NEW recoilX (lateral arm sway) │
│    camShakePitch / Yaw / Roll       │ │  • NEW recoilYaw (horiz swing)    │
│    camShakePosX / PosY (micro-kick) │ │  • Alternating rapid-fire bias    │
│                                     │ │  • Stance-scaled sightMisalign    │
└──────────────────┬──────────────────┘ └─────────────────┬─────────────────┘
                   │                                      │
                   ▼                                      ▼
┌─────────────────────────────────────┐ ┌───────────────────────────────────┐
│        PERSPECTIVE CAMERA           │ │     WEAPON POSE GRAPH + 2-BONE IK │
│  • Vision / horizon shakes crisply  │ │  • WeaponPivot applies recoilX,   │
│    during ADS cheek-weld            │ │    recoilYaw, recoilPitch/Roll/Z  │
│  • Calm & steady during Hip-Fire    │ │  • Left & Right IK hands track    │
│                                     │ │    weapon sockets seamlessly      │
└─────────────────────────────────────┘ └───────────────────────────────────┘
```

### Data Model & Spring State

- **Stance Coupling Factor (`cheekWeld`)**:
  - Computed continuously from active stance (`ADS -> 1.0`, `CANTED_ADS -> 0.92`, `POINT_AIM -> 0.50`, `HIP -> 0.0`).
  - Camera shake gain interpolates smoothly from `~0.25x` (Hip) up to `1.00x` (ADS), modulated by `adsCameraShakeScale` and multiplied by `0.68` when a magnified PiP optic is active in primary ADS.
  - Weapon/arm horizontal sway & instability gain interpolates inversely from `1.00x` (Hip, full loose sway) down to `~0.22x` (ADS, tightly braced control), modulated by `hipRecoilSwayScale`.
- **Camera Cheek-Weld Spring State (Zero-GC Scalars)**:
  - `camShakePitch` / `camShakePitchVel` — crisp vertical vision punch (`ω ≈ 28 rad/s`, `ζ ≈ 0.72`).
  - `camShakeYaw` / `camShakeYawVel` — sharp horizontal cheek rattle (`ω ≈ 30 rad/s`, `ζ ≈ 0.68`).
  - `camShakeRoll` / `camShakeRollVel` — subtle visceral head-tilt snap (`ω ≈ 26 rad/s`, `ζ ≈ 0.70`).
  - `camShakePosX` / `camShakePosY` (with velocities) — millimeter-scale cheek-to-stock jolt applied in camera local right/up axes.
- **Weapon & Arm Horizontal Sway Spring State (Zero-GC Scalars)**:
  - `recoilX` / `recoilXVel` — lateral horizontal translation of the weapon pivot (and therefore IK arms), underdamped in hip-fire (`ζ ≈ 0.60`) for organic arm recovery.
  - `recoilYaw` / `recoilYawVel` — horizontal muzzle swing around the vertical axis, coupled with `recoilRoll` for natural wrist torque.
  - `hipSwingPolarity` (`+1` / `-1`) — tracks the last horizontal swing direction and alternates with organic variance (`~75%` flip bias on consecutive shots) while scaling amplitude by `0.65 + rapidFireHeat * 1.15`, so bursts naturally swing side-to-side.
- **Configuration & Tuner State**:
  - Add `adsCameraShakeScale: number` (default `1.0`) and `hipRecoilSwayScale: number` (default `1.0`) to both the SDK config (Calibration Gym + JSON export + reset defaults) and Survival `TunerSettings` (with fallback defaults for backward compatibility).

### Interactive Component & State Mapping

- **Calibration Gym Tuner (`Weapon & Mic` tab)**:
  - Slider: **ADS Cheek-Weld Camera Shake** (`0.00x`–`2.00x`, step `0.05`) -> calls config update handler -> live-read on every fired shot by the SDK controller.
  - Slider: **Hip-Fire Arm Recoil Sway** (`0.00x`–`2.00x`, step `0.05`) -> calls config update handler -> live-read on every fired shot by the SDK controller and weapon rig.
  - **Export Tuned Config JSON** & **Reset Defaults** automatically include and restore both fields.
- **Survival Rig Tuner (`Free-Aim Controller` section)**:
  - Slider: **ADS Cheek-Weld Camera Shake** (`0.00x`–`2.00x`, step `0.05`) -> updates Survival tuner state -> passed into recoil application on each shot.
  - Slider: **Hip-Fire Arm Recoil Sway** (`0.00x`–`2.00x`, step `0.05`) -> updates Survival tuner state -> passed into recoil application on each shot.
  - **Reset Defaults** restores both sliders to `1.00x`.
- **Non-Firearm Shock Preservation**:
  - Environmental blast waves, melee hits, and damage flinches pass an optional override flag or neutral stance mode so explosions and hits still jolt the camera appropriately even when not aiming down sights.
