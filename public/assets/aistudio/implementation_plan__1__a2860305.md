# Armory Realism, PBR, Recoil, Geometry-Driven Hand IK & Hand-Driven Reload Overhaul

## 1. Objective & Resolved Design Direction

Elevate every firearm across the armory (pistols, revolvers, SMGs/PDWs, carbines/rifles, DMRs, bolt-action rifles, and shotguns) from flat blocky silhouettes and fixed-pose animations to realistic, physically grounded multi-material 3D firearms with accurate ergonomics, distinct caliber-scaled recoil feel, geometry-derived hand/finger contact, and hand-driven mechanical animations.

### Confirmed Decisions
- **Staged Rollout:** Implemented cleanly across **3 focused phases** so visual geometry/PBR/recoil, hand/finger IK fitting, and mechanical reload/pump choreography can each be verified independently.
- **Iron Sights Styling:** Front sight posts match the **uniform matte dark steel** finish of their sight housing across all weapons, with **subtle white/tritium dot accents on pistols only** for fast close-range acquisition without washing out rifle/SMG sight pictures.
- **Heavy Caliber ADS Feel:** **Heavy realistic kick with brief recovery time**—preserving the Makarov PM (9×18mm) as the calibrated baseline, giving 9×19mm service pistols (Beretta M9, Glock 17, SIG P226) a slight bump, and making heavy calibers (.50 AE Desert Eagle, 12-gauge, 7.62 NATO, .338/.50) deliver authoritative camera impulse, muzzle rise, and brief controlled ADS sight re-settling.
- **Platform Compatibility:** Full compatibility with the existing Cloudflare Workers / D1 / Durable Objects deployment, multiplayer networking, Gym/Combat parity, 3D PDA, and NVG/Operator customization systems will remain untouched.

---

## 2. System Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│               PHASE 1: PROCEDURAL ARMORY & MATERIAL PIPELINE               │
│                                                                            │
│  Shared Sub-Assembly Builders           Upgraded PBR Material Library      │
│  ├─ buildHollowBarrel()                 ├─ Satin / Parkerized Gunmetal     │
│  ├─ buildBeveledReceiverOrSlide()       ├─ Brushed Stainless / Chrome      │
│  ├─ buildGripAssembly() [-15°..-22°]    ├─ Figured Walnut & Laminate Wood  │
│  ├─ buildTriggerAndGuard() [open loop]  ├─ Stippled / Checkered Polymer    │
│  └─ buildContouredMagazine()            └─ Pitch-Black Recessed Cavities   │
│                     │                                   │                  │
│                     └─────────────────┬─────────────────┘                  │
│                                       ▼                                    │
│   WeaponModelAssembly + Exact Surface Sockets (#MUZZLE, #OPTIC, #GRIP,     │
│   #MAG, #CANT) + Box3 Dynamic Gunsmith Framing + Caliber Recoil Profile    │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ Auto-computed bounds & geometry
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│            PHASE 2: GEOMETRY-DRIVEN HAND & FINGER POSE SOLVER              │
│                                                                            │
│  Geometry Bounds ──► handPoseProfile { gripWidth, gripDepth, gripAngle,    │
│                        triggerReach, supportRadius, supportStyle }         │
│  ├─ primaryHandSocket  (palm web flush on backstrap, wrist on rake angle)  │
│  ├─ supportHandSocket  (pistol cup / #GRIP snap / handguard / pumpSlide)   │
│  ├─ 10-Finger Curl Solver (zero-clip wrap for Makarov vs Desert Eagle)     │
│  └─ Trigger Discipline Controller (straight index on frame when not ready) │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ Continuous IK blend (0.08–0.12s)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│        PHASE 3: HAND-DRIVEN MECHANICAL ANIMATIONS & PUMP SHOTGUNS          │
│                                                                            │
│  Master-Slave Constraint Layer (zero telekinetic parts)                    │
│  ├─ Magazine locked to supportHandMagSocket along exact magwell/grip axis  │
│  ├─ Pump forend + action bars locked to support hand axial Z travel        │
│  ├─ Two-Stage Asymmetric Pump Cycle (ADS-persistent + shell ejection)      │
│  ├─ Shell-by-Shell Tubular Reload + Empty Breech Load + Fire Interrupt     │
│  └─ Class Reloads (Pistol/Makarov Heel, AR Bolt Slap, MP5 Slap, AK Rock)   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Phased Implementation Plan

### Phase 1: Procedural Weapon Meshes, Iron Sights, Grip Rake, PBR Materials, Caliber Recoil & Gunsmith Framing

#### 1.1 Global Grip Rake Fix & Realistic Class-Specific Magazines
- **Global Grip Rotation Sign Reversal:** Reverse the inverted X-axis pitch sign across every firearm class (weapons face `-Z`, so downward `-Y` grip geometry must pitch rearward toward `+Z` with a negative X rotation):
  - **Pistols & Revolvers:** `15°–18°` rearward rake from vertical.
  - **Rifles, Carbines, SMGs, DMRs, Bolt-Actions & Shotguns:** `18°–22°` rearward rake from vertical, seated flush beneath the rear of the lower receiver behind the trigger guard with zero seam gap.
- **Class-Specific Magazine Alignment & Contoured Geometry:**
  - Replace flat rectangular "lego-block" magazines with beveled, tapered, ribbed, or curved profiles (including polymer waffle/ribbed mags, curved AK/MP5 banana mags with locking lugs, tapered pistol double-stack bodies, and flared baseplates).
  - **Grip-Fed Pistols & Grip-Fed SMGs:** Align the `#MAG` socket, magazine home orientation, and physical ejection/insertion vector directly to the `15°–18°` rearward grip rake so magazines seat cleanly inside the grip frame.
  - **Magwell-Fed Rifles, Carbines & DMRs:** Keep the magazine well and `#MAG` socket completely independent of the pistol grip; insert STANAG/box/curved magazines straight vertically or angled slightly forward (`0°` to `+5°` toward the muzzle, never tilted rearward toward the grip).

#### 1.2 Shared Anatomical Sub-Assembly Builders & Platform Details
Replace flat box primitives across all firearm classes with reusable sculpted builders that output properly beveled, shadowed geometry:
- **`buildHollowBarrel`:** Cylindrical outer barrel, chamfered muzzle crown ring, and recessed pitch-black inner bore cylinder (`#08080a`, matte) so every barrel reads with authentic hollow depth from front and 3/4 angles (eliminating solid gray noses like the Desert Eagle front view), plus optional muzzle threads, birdcage flash hiders, and machined compensator ports.
- **`buildBeveledReceiverOrSlide`:** Extruded 2D cross-section shapes (`ExtrudeGeometry` with `bevelEnabled: true` and 2–3 bevel segments) producing chamfered pistol slides, the signature tapered triangular Desert Eagle barrel shroud with vent slots, and distinct upper/lower rifle receiver profiles separated by a recessed dark parting seam (`#101216`).
- **`buildGripAssembly`:** Rearward-raked beveled frame core, slightly raised textured side grip panels (`roughness ~0.85`), ergonomic backstrap swell/beavertail, and subtly protruding magazine baseplate at the heel.
- **`buildTriggerAndGuard`:** True open-loop trigger guard enclosing real negative space around a curved internal trigger shoe (eliminating solid trigger blocks).
- **Platform-Specific Surface Detail:**
  - **Pistols (Makarov, Beretta M9, SIG P226, Glock 17, Jericho 941, Desert Eagle, MP-443, PL-15):** Front/rear slide serrations, recessed ejection port exposing the contrasting metallic barrel hood, under-barrel Picatinny dust-cover slots on modern rails, and sculpted external hammers/beavertails on hammer-fired models.
  - **Long Guns & SMGs:** Ventilated/quad-rail/M-LOK handguards with distinct rail teeth (`#181b20`), separate cylindrical gas block & front sight tower, beveled flared magwells, charging handles, forward assists, dust covers, multi-piece buffer tubes/collapsible stocks, and dual action bars + bottom loading gate on shotguns.

#### 1.3 Iron Sights Unification & MP5 Open V-Notch Diopter
- **Front Sight Post Unification:** Assign every weapon's front sight post the same matte dark steel finish as its surrounding sight housing/hood so the post blends naturally with the sight silhouette without distracting neon-colored full blades.
- **Pistol-Only Subtle Dots:** Add small, realistic high-contrast white/tritium dot inlays strictly on pistol front/rear iron sights (leaving rifles, carbines, SMGs, DMRs, bolt-actions, and shotguns pure dark steel).
- **MP5 Rear Diopter Fix:** Replace the solid obstructing rear cylinder on the MP5 with an authentic H&K rotating drum assembly featuring sculpted protective ear wings and a genuine open V-notch / aperture cut aligned directly to the sight axis, giving an unobstructed view through the rear notch to the hooded circular front post.

#### 1.4 Upgraded Multi-Material PBR Finish Library
Enforce a minimum of **4 distinct PBR materials** per firearm using procedural canvas textures (albedo in `SRGBColorSpace`, roughness, and bump/normal maps with computed tangents where needed) backed by `RoomEnvironment` IBL reflections:
- **Gunmetal (Anodized / Parkerized):** Deep matte-satin steel (`#22262c` / `#343942`, `metalness: 0.75–0.80`, `roughness: 0.38–0.44`) with subtle edge wear and micro-grain variation.
- **Brushed Stainless & Chrome Steel (Desert Eagle, Revolvers, Exposed Barrels/Bolts):** Directional anisotropic brushed steel grain (`metalness: 0.88–0.94`, `roughness: 0.18–0.26`) with fine micro-scratches and contrasting dark steel controls, safety levers, and sights so metallic specular highlights roll naturally across beveled edges.
- **Wood Furniture (AK, Mosin, Shotguns, Makarov Bakelite/Walnut):** Multi-tone procedural walnut & laminated wood grain with matching roughness and bump channels (`metalness: 0.04`, `roughness: 0.52–0.64`) instead of flat brown color.
- **Checkered / Stippled Polymer:** Micro-textured matte dark polymer (`#181a1e`, `metalness: 0.05`, `roughness: 0.82–0.86`) for grips, handguards, and polymer frames.
- **Recessed Negative Space:** Pitch-black ultra-matte cavity material (`#08080a`, `metalness: 0.0`, `roughness: 0.95`) for bores, ejection ports, magwells, and seam channels.

#### 1.5 Caliber-Scaled Camera Shake & Recoil Feel
Recalibrate per-caliber impulse multipliers and damped recovery springs across the armory:
- **Baseline (1.0×):** Makarov PM (9×18mm)—preserved as the exact reference feel.
- **Service 9×19mm Pistols (Beretta M9, Glock 17, SIG P226, MP-443, PL-15, Jericho 941):** Modest increase (~1.18×–1.25×) over Makarov for crisper snap without harsh whip.
- **Mid-Heavy & Rifle Calibers (.45 ACP, 5.56 NATO, 5.45×39, 7.62×39, 7.62 NATO):** Progressive scaling in camera pitch/roll punch, axial kickback, and brief sight recovery.
- **Powerhouse Heavy Calibers (.50 AE Desert Eagle, 12-Gauge Buckshot/Slug, .338 / .50 BMG):** Strong visceral camera shake impulse, pronounced upward muzzle climb, roll torque, and brief realistic ADS re-centering time so firing the Desert Eagle or 12-gauge feels unmistakably powerful.

#### 1.6 Dynamic `Box3` Gunsmith Framing & Flush Attachment Sockets
- Compute exact `THREE.Box3` bounding box and bounding sphere of the active showcase weapon (re-evaluated when attachments change) to center the weapon over the vise cradle and calculate ideal camera orbit distance dynamically from field-of-view, ensuring compact pistols sit at a comfortable medium framing with zero near-plane clipping while long rifles fit completely in view.
- Re-anchor `#MUZZLE`, `#OPTIC`, `#GRIP`, `#MAG`, `#RAIL`, and `#CANT` sockets flush onto the updated beveled geometry surfaces.

---

### Phase 2: Geometry-Driven Hand & Finger Pose Mapping

#### 2.1 Auto-Computed `handPoseProfile` & Geometry-Derived Sockets
Every weapon assembly will generate a `handPoseProfile` directly from its constructed sub-assembly transforms and `Box3` dimensions:
```
handPoseProfile {
  gripWidthM, gripDepthM, gripAngleRad, triggerReachM,
  supportRadiusM,
  supportStyle: 'pistol_cup' | 'handguard_cradle' | 'vertical_grip' | 'angled_grip' | 'pump_slide'
}
```
- **Primary Hand Socket:** Automatically derived from the upper rear backstrap/beavertail tang of `buildGripAssembly`, orienting the right wrist cleanly to the corrected `15°–22°` rearward grip rake so the palm web seats flush against the frame without floating or intersecting the receiver.
- **Support Hand Socket:**
  - **Pistols:** Two-handed thumbs-forward support grip wrapped over the left grip panel and primary knuckles.
  - **Equipped Foregrips (`#GRIP`):** Automatically snaps support hand socket onto the attached vertical or angled foregrip geometry and switches `supportStyle` accordingly.
  - **Bare Long Guns:** Cradles the handguard cleanly at ~55%–65% of handguard length based on measured handguard radius.
  - **Pump-Action Shotguns:** Parented directly to the reciprocating `pumpSlideNode` so the support hand moves 1:1 with the forend at all times.

#### 2.2 Parametric 10-Finger Curl Solver & Automatic Trigger Discipline
- Extend the articulated finger pose solver (all 10 fingers: proximal, intermediate, distal phalanges + 2-joint thumbs) to compute curl angles directly from `gripWidthM`, `gripDepthM`, and `supportRadiusM`:
  - Thick double-stack / magnum grips (e.g., Desert Eagle) open finger joint flexion proportionally so fingertips rest flush on the frontstrap rather than clipping inside the grip.
  - Slim grips (e.g., Makarov PM) curl more tightly for natural wrap.
  - Support hand fingers adapt smoothly across pistol cup, handguard cradle, vertical foregrip wrap, angled foregrip C-clamp, and shotgun pump ribs.
- **Automatic Trigger Discipline:** Extend the right index finger straight and resting cleanly along the receiver/frame outside the trigger guard during **sprint, reload, weapon inspect, mag-check, low-ready, and suppressor actions**; curl smoothly onto the internal curved trigger shoe only when aiming, ready to fire, or firing.

---

### Phase 3: Hand-Driven Mechanical Animations, Pump-Action Shotguns & Class-Authentic Reloads

#### 3.1 Master-Slave Hand-to-Part Constraint System
Eliminate all "telekinetic" moving parts where magazines, slides, bolts, or pumps animate independently of hands:
- **Magazine Lock:** During reload strip, swap, and insertion, the physical magazine mesh is hard-parented to `supportHandMagSocket` on the support palm and guided strictly along the weapon's exact magwell or rearward grip axis (`0°..+5°` for magwell-fed rifles, `15°–18°` rearward for grip-fed pistols/SMGs).
- **Pump Forend Lock:** On pump-action shotguns, the support hand IK target is welded to `pumpSlideNode`; axial `pumpTravel` (`0..1`) drives both the forend, dual action bars, bolt carrier, and the locked left hand simultaneously with zero lag.
- **Charging Handle / Slide Contact:** During dry reload chambering, the support hand (or primary hand for bolt-action handles) physically reaches, grasps, and tracks the slide serrations, charging handle, or bolt catch through the exact travel stroke.

#### 3.2 Authentic Pump-Action Shotgun Cycle & Tubular Reload
- **Two-Stage Asymmetric Post-Shot Pump Cycle:**
  ```
  [Shot Fired] ─► Stage 0 (0.04s recoil/unlock)
               ─► Stage 1: Crisp Rearward Extraction (0.11–0.14s)
                    • Forend + action bars + bolt travel rearward
                    • Spent 12ga hull ejects at apex of stroke
                    • Brief mechanical dwell (0.04s)
               ─► Stage 2: Decisive Forward Lockup (0.12–0.15s)
                    • Forend slams forward chambering fresh shell
                    • Crisp metallic lockup clack + subtle forward counter-impulse
  ```
  - **ADS-Persistent:** Players remain aimed down sights through the pump cycle with a realistic subtle dip and roll cant during the extraction stroke before snapping back on target.
- **Shell-by-Shell Tubular Reload:**
  - Cant shotgun `35°–45°` to expose the underside loading gate; support hand draws individual 12-gauge shell meshes from the pouch/belt and feeds each shell upward into the tubular magazine, incrementing ammo count one shell at a time.
  - **Emergency Empty-Chamber Load (`ammo === 0`):** Support hand racks the pump rearward to lock open the ejection port, drops the first live shell directly into the open breech, racks the pump forward to chamber, then transitions seamlessly into loading remaining shells into the underside tube.
  - **Click-to-Fire Reload Interrupt:** Pressing fire mid-reload immediately aborts further shell insertion, completes any active chamber closure if needed, blends the support hand back to `pumpSlideNode` smoothly, and fires.

#### 3.3 Class-Authentic Reload Choreography & Continuous IK Blending
- **Pistols:** Strict trigger discipline; cant pistol `25°–35°` into the workspace; free-fall mag drop on push-button pistols (or support-hand heel-strip on the **Makarov PM**); insert fresh magazine smoothly along the `15°–18°` rearward grip rake with a firm upward palm seat; on empty reload, release slide stop or perform an overhand/slingshot rear slide rack.
- **AR-15 / Modern Carbines (M4A1, HK416, etc.):** Strip/drop mag along vertical/slight-forward magwell axis, seat fresh magazine with crisp upward tug check, and execute a tactile left-side **bolt-catch paddle slap** on empty reloads (or T-charging handle pull when dry).
- **MP5:** On empty reload, lock the forward left-side cocking handle upward into the H&K notch, swap the curved magazine, and execute the signature downward **H&K slap** to send the bolt home.
- **AK-Pattern Rifles:** Authentic **rock-and-lock** curved magazine motion (hook front lug first, rock rear lug upward into latch) and reach under/over the receiver to pull and release the right-side charging handle on empty.
- **Continuous IK Blending:** All transitions across idle, ADS, reload phases, pump cycles, bolt cycles, and firing use continuous `0.08s–0.12s` cubic ease-in-out IK blending with pre-allocated scratch transforms (zero GC per frame) to eliminate popping or joint snapping.

---

## 4. Verification Strategy

- **Phase 1 Checks:** Visually inspect pistols (Desert Eagle, Makarov, Beretta M9, Glock 17) and long guns (M4A1, AK, MP5, Pump Shotgun) in the Gunsmith Bench and Gym—confirming rearward grip rake across all weapons, hollow dark bores from front 3/4 view, brushed metallic steel reflections on the Desert Eagle, wood grain on wood-stocked weapons, uniform dark steel front sight posts (with subtle pistol dots only), unobstructed open V-notch sight picture on the MP5, balanced Gunsmith camera framing, and clear recoil progression from Makarov -> Beretta/Glock -> Desert Eagle & 12-gauge.
- **Phase 2 Checks:** Verify zero palm/finger clipping on both wide (Desert Eagle) and slim (Makarov) grips, automatic foregrip socket snapping when attaching vertical/angled grips, support hand lock on pump forends, and strict index-finger trigger discipline during sprint, inspect, and reload.
- **Phase 3 Checks:** Verify zero floating magazines during reloads across pistol, AR, MP5, and AK platforms; test ADS-persistent pump cycling, shell-by-shell tubular reload, empty-chamber breech load, and click-to-fire reload interrupt on pump shotguns.
- **Automated Build & Regression Checks:** Run TypeScript/lint checks, full production bundle compilation, and existing automated test suite after each phase to ensure zero regressions across Gym, Combat, Operator/NVG, PDA, and Multiplayer systems.
