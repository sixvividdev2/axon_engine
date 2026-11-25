# Phase 4: Conquest Bomber Air Strikes & Two-Tier RX 480 Performance Benchmark

Completes the Conquest Fire Support architecture by adding host-authoritative **Bomber Air Strikes** (a 2-aircraft pool of twin-engine tactical strike jets executing deterministic 6-bomb runs along a rotatable `65m` corridor) integrated into the 3D PDA Fire Support tab, paired with a strictly dev-only **Two-Tier Automated Performance Benchmark** enforcing the RX 480 `≤ 1.5ms` CPU / `≤ 1.0ms` GPU / `≤ 16.6ms` frame budgets.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> All Phase 4 design choices from our alignment interview are locked in below. Review and approve to begin implementing Bomber Air Strikes, 3D PDA corridor controls, corridor smoke flares, and the dev performance harness.

- **Confirmed PDA Strike Selector & Heading Controls:** Inside the 3D PDA **Fire Support** tab, **`[1]`** selects **81mm Mortar Sweep** (5 rounds, `75s` cooldown) and **`[2]`** selects **Bomber Air Strike** (6-bomb `65m` corridor, `150s` cooldown). While Bomber Air Strike is selected, **`[Q]`** and **`[E]`** smoothly rotate the `65m` bombing corridor heading in real time at `60+ FPS` without leaking lean input to the bodycam, and **`[Space]`** dispatches the active strike.
- **Confirmed Bomber Silhouette:** **Twin-engine tactical strike jet (A-10 / Su-25 style)** built procedurally as a composite multi-part 3D rig (tapered armored fuselage, straight high-lift wings, twin rear-mounted turbofan nacelles, twin vertical tail fins, tinted bubble canopy, and underwing ordnance pylons) strictly under `3,500` triangles per aircraft with varied PBR roughness/metalness finishes.
- **Confirmed Battlefield Warning Cues:** Inbound bomber runs broadcast a **tactical radio callout**, trigger the **`P0`-protected Doppler jet roar**, and pop **corridor ground smoke flares** along the `65m` run so both friendly and enemy infantry have unmistakable audiovisual counter-play cues on the ground.
- **Confirmed Host-Authority & Budget Guarantees:**
  - Team must hold **≥ 50% of Conquest sectors** at call time, have `airStrikeCooldownSec <= 0`, and have `!activeStrike` (concurrent attempts reject with `"Airspace Busy — Strike Inbound"` without burning cooldown).
  - Target corridors overlapping either team's **`65m` HQ exclusion cylinder** are blocked without burning cooldown.
  - Exact **point-to-segment `45m` Danger Close** evaluation checks every friendly along the entire `65m` corridor segment (not just its midpoint).
  - The automated benchmark harness is strictly isolated behind `import.meta.env.DEV` so zero dev UI, query flags, or globals ship to production players.

---

## 1. Overview & Core Concept

- **What It Does:** Rewards teams that establish territorial dominance (`≥ 50%` of Conquest sectors) with a high-impact, deterministic close-air-support bomber run callable directly from the held 3D TAC-PDA. Players aim the corridor midpoint with LMB drag, orient the `65m` bombing line with `[Q]`/`[E]` to sweep trenches, streets, or contested FOB approaches, verify the live `45m` Danger Close capsule, and call in a low-pass twin-engine strike jet that roars overhead, drops 6 pooled aerial bombs along the smoke-marked corridor, and egresses cleanly.
- **Target Audience & Context:** Conquest solo skirmishers and multiplayer squads seeking combined-arms tactical payoff for sector control, plus engineers verifying that simultaneous 6-pit mortar salvos and bomber runs stay strictly inside the RX 480 `60+ FPS` performance envelope.
- **Key Value:** Closes the Conquest strategic loop—holding sectors unlocks decisive air superiority, while corridor smoke flares, Doppler jet audio, and strict cooldown/HQ exclusion rules keep ground combat fair, readable, and visually cinematic without frame-rate spikes.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Calling a Bomber Air Strike via the 3D TAC-PDA:**
   - Player opens the 3D PDA (`[P]` or `[M]`), switches to the **Fire Support** tab (`[Tab]`), and presses **`[2]`** to select **BOMBER AIR STRIKE** (`[1]` switches back to **81MM MORTAR SWEEP**).
   - At `60+ FPS`, the PDA screen swaps the circular mortar reticle for a crisp **`65m` oriented bombing corridor overlay** showing the approach arrow, 6 evenly spaced bomb-impact ticks, and a live **`45m` Danger Close capsule** that pulses amber/red whenever any friendly lies within `45m` of any point along the `65m` segment.
   - Holding or tapping **`[Q]`** / **`[E]`** smoothly rotates the corridor azimuth (`0°–359°`) while displaying exact magnetic heading degrees in tabular numerals.
   - The bottom command card clearly reports readiness or exact block states:
     - `READY · [SPACE] CALL AIR STRIKE` (when sectors `≥ 50%`, cooldown `0s`, airspace clear, and outside `65m` HQ exclusion)
     - `REQUIRES >= 50% SECTORS (X/Y HELD)`
     - `AIRSPACE BUSY — STRIKE INBOUND`
     - `HQ NO-FIRE ZONE (65M)`
     - `AIR STRIKE COOLDOWN · MM:SS`
   - Pressing **`[Space]`** dispatches the request through Host authority; on approval, radio confirmation triggers (`"Eagle-1 inbound on heading XXX°, corridor hot"`), the `150s` team cooldown starts, and the active corridor appears on friendly PDAs until the run completes.

2. **In-World Strike Run & Battlefield Counter-Play:**
   - **T-0s (Ingress & Ground Marking):** Red/amber tactical smoke canisters ignite along the start, center, and end of the `65m` corridor, sending thin rising plumes visible from ground level so alert defenders can sprint perpendicular to the bombing line.
   - **T+1.5s to T+5.5s (Low-Pass Flyby & Release):** The twin-engine strike jet sweeps in from the far theater perimeter along the exact heading vector at low attack altitude (`~58m`), banking subtly into the run with twin contrail streaks and the **`P0`-protected Doppler jet roar** sweeping overhead.
   - **Bomb Release & Detonation:** As the jet crosses the corridor entry, it releases **6 deterministic aerial bombs** (`~0.16s` release interval, `~13m` ground spacing across the `65m` line) from the shared `16`-slot ordnance pool. Each bomb falls along a ballistic trajectory with an incoming whistle (`P1`/`P2`), detonates with shockwave impulse, scorches the ground via the `24`-slot FIFO crater decal ring buffer, flashes the single pooled dynamic blast light, and applies exact impact damage (`100%` enemy, `100%` caller self-damage, `25%` teammate splash + suppression flinch).
   - **Egress:** The aircraft pitches upward into a clean climbing egress out of render range and returns to its inactive pool slot (`0ms` idle cost, `activeStrike = false`).

3. **Two-Tier Automated Dev Performance Benchmark (Dev Builds Only):**
   - Launching the app in dev mode with `?bench=fire_support` or invoking `window.__AXON_DEV_PERF_BENCH__()` runs a deterministic 10-second worst-case stress sequence: **6 active mortar pits firing salvos + 1 active 5-round mortar sweep + 1 simultaneous bomber air strike**.
   - Upon completion, it emits a structured JSON report summarizing `tier` (`A_SOFTWARE` vs `B_HARDWARE`), `cpuP95`, `totalFrameP95`, `gpuP95` (or `"SKIPPED_SOFTWARE_RENDERER"` / structural proxy fallback warning), `fireSupportDrawCalls`, `fireSupportTriangles`, `activeShadowCasters`, audio voice peak (`<= 12`), and pass/fail gate assertions.

### Visual Identity & Theme

- **Twin-Engine Strike Jet Silhouette:** Rugged matte slate-charcoal airframe (`roughness ~0.72`, `metalness ~0.18`), darker metallic turbofan cowlings (`roughness ~0.38`, `metalness ~0.78`), subtle warm amber afterburner core glow inside exhaust rings, low-visibility team wing-band stripe, and smoked polycarbonate canopy (`roughness ~0.12`). Zero shadow-map thrashing (strictly respects the `<= 1` active fire-support shadow caster ceiling).
- **PDA Fire Support Corridor Overlay:** Retains the strict obsidian/gunmetal/amber tactical instrument palette (`tabular-nums` for heading, countdowns, and sector ratios), clear `[1] MORTAR` / `[2] AIR STRIKE` mode selector tabs, directional ingress chevron, and high-contrast `45m` Danger Close capsule border.
- **Corridor Smoke Flares:** Soft, pooled billboard smoke puffs rising from 3 corridor flare markers (`start`, `mid`, `end`), tinted high-visibility crimson-orange for enemy runs / amber-gold for friendly runs, capped strictly inside the draw-call and triangle budget (`InstancedMesh` / pooled sprites with zero per-frame allocations).

### Interactive Feedback & Motion

- **Zero-GC Flight & Ordnance Kinematics:** Pre-allocated reusable vectors, quaternions, and matrices drive aircraft cruise, roll-in bank, climbing egress, falling bomb pitch alignment, and rising flare smoke puffs with smooth frame-rate-independent damping.
- **Protected `P0` Audio Priority:** Bomber Doppler flyby acquires a `P0` protected slot in the 12-voice `FireSupportVoicePool` so heavy simultaneous mortar shelling can never silence the incoming jet roar.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Shared Ordnance, Decal & Light Pools Across Mortars and Bombers**
  - *Chosen Approach:* Route bomber falling bombs, ground scorch decals, and blast lighting through the exact same hard-capped pools (`16` ordnance meshes, `24` FIFO scorch decals, `1` dynamic blast light, `12` priority audio voices) already established for mortars, plus a dedicated `2`-aircraft `bomberPool` and a single instanced flare-smoke pool (`1` draw call).
  - *Why:* Guarantees that simultaneous mortar salvos + bomber carpet runs stay strictly under the RX 480 ceilings (`<= 28` fire-support draw calls, `<= 18,000` triangles, `<= 1.5ms` CPU, `<= 1.0ms` GPU).
  - *Alternatives Considered:* Creating separate bomb, decal, and point-light pools per weapon system (rejected—doubles draw calls and risks breaching the `1.0ms` GPU ceiling).

- **Decision 2: Exact Point-to-Segment Distance for 45m Danger Close & 65m HQ Exclusion**
  - *Chosen Approach:* Evaluate both the `45m` Danger Close check (against friendly positions) and the `65m` HQ exclusion check (against both team HQs) using analytical 2D point-to-segment distance against `[corridorStart, corridorEnd]`.
  - *Why:* A `65m` corridor extends `32.5m` forward and backward from its center; checking only the center point would allow bombs to clip inside HQ spawn cylinders or miss friendlies near the corridor tips.
  - *Alternatives Considered:* Checking only the midpoint with an inflated radius (rejected—produces false positives perpendicular to the bombing line).

- **Decision 3: Deterministic Replicated Strike Corridor + Snapshotted Caller Attribution**
  - *Chosen Approach:* Host validates sector control (`≥ 50%`), cooldown, airspace lock, and HQ exclusion once on `REQUEST_AIR_STRIKE`, snapshots `callerPlayerId` + `callerName`, generates a deterministic seed, and broadcasts a compact strike-start packet (`corridorStart`, `corridorEnd`, `headingRad`, `seed`, `team`, `callerId`). Every client deterministically derives the exact same 6 bomb release points, impact positions, and arrival times.
  - *Why:* Zero per-frame aircraft network streaming (`< 200 bytes` total per strike), tamper-resistant host authority via the relay guard, and guaranteed kill attribution even if the caller dies or disconnects mid-run.

- **Decision 4: Honest Two-Tier Performance Gate (No Silent Passes)**
  - *Chosen Approach:* Detect software WebGL renderers (`SwiftShader`, `llvmpipe`, `softpipe`, `Basic Render`) from the WebGL renderer string for **Tier A** (enforcing `cpuP95 <= 1.5ms` + state invariants and reporting `gpuMs: "SKIPPED_SOFTWARE_RENDERER"`), while **Tier B** (hardware GPU) uses `EXT_disjoint_timer_query_webgl2` for `gpuP95 <= 1.0ms` and falls back loudly with an explicit console warning to hard structural GPU proxy ceilings (`fireSupportDrawCalls <= 28`, `fireSupportTriangles <= 18,000`, `activeShadowCasters <= 1`) plus `totalFrameP95 <= 16.6ms` if timer queries are unavailable or disjoint.
  - *Why:* Prevents false CI failures on headless software renderers while ensuring hardware CI never silently skips GPU validation.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### System & Component Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CONQUEST MATCH & HOST AUTHORITY                          │
│  ┌──────────────────────┐    ┌──────────────────────────┐   ┌──────────────┐ │
│  │ Conquest Sector Ctrl │───▶│ FireSupportAuthority     │◀─▶│ Relay Guard  │ │
│  │ • >= 50% Sector Gate │    │ • TeamFireSupportState   │   │ • Air Strike │ │
│  │ • HQ Exclusion (65m) │    │ • 150s Cooldown & Lock   │   │   Request &  │ │
│  └──────────────────────┘    │ • Caller ID Snapshot     │   │   Sync Guard │ │
│                              │ • Point-to-Segment 45m   │   └──────────────┘ │
│                              └────────────┬─────────────┘                    │
└───────────────────────────────────────────┼──────────────────────────────────┘
                                            │ Compact Corridor + Seed Packet
            ┌───────────────────────────────┼───────────────────────────────┐
            ▼                               ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────┐   ┌──────────────────────────┐
│ BomberAirStrikeSystem     │   │ 3D TAC-PDA Fire Support   │   │ Shared Pools & Audio     │
│ • 2-Aircraft Pool         │   │ • [1] Mortar / [2] Bomber │   │ • 16 Ordnance Meshes     │
│   (A-10/Su-25 <=3.5k tris)│   │ • [Q]/[E] Rotate Heading  │   │ • 24 FIFO Scorch Decals  │
│ • 6 Deterministic Bombs   │   │ • 60Hz 65m Corridor +     │   │ • 1 Pooled Blast Light   │
│ • Instanced Flare Smoke   │   │   45m Danger Close Capsule│   │ • 12-Voice Audio Pool    │
│ • 0ms Idle Cost           │   │ • 10Hz Cached Telemetry   │   │   (P0 Doppler Flyby)     │
└─────────────┬─────────────┘   └───────────────────────────┘   └──────────────────────────┘
              │
              ▼ (import.meta.env.DEV ONLY — dead-code stripped in production)
┌──────────────────────────────────────────────────────────────────────────────┐
│                TWO-TIER AUTOMATED PERF BENCHMARK HARNESS                     │
│  • Triggers: ?bench=fire_support | window.__AXON_DEV_PERF_BENCH__            │
│  • 10s Stress: 6 Active Mortar Pits + 1 Mortar Sweep + 1 Bomber Air Strike   │
│  • Tier A (Software GL): cpuP95 <= 1.5ms + Invariants (gpuMs: SKIPPED)       │
│  • Tier B (Hardware GL): cpuP95 <= 1.5ms, totalFrameP95 <= 16.6ms,           │
│    gpuP95 <= 1.0ms (EXT_disjoint_timer_query_webgl2 or loud structural       │
│    proxy fallback: drawCalls <= 28, tris <= 18,000, shadowCasters <= 1)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **`ActiveAirStrikeSummary` (Replicated, Max 2 — 1 per Team):**
  - `strikeId`, `team` (`'A' | 'B'`), `callerId`, `callerName`
  - `centerX`, `centerZ`, `headingRad`, `corridorLengthM` (`65`), `startX`, `startZ`, `endX`, `endZ`
  - `seed`, `elapsedSec`, `totalDurationSec`, `dangerClose`
- **`TeamFireSupportState` (Extended for Air Strikes):**
  - `mortarSweepCooldownSec` (`75s`), `airStrikeCooldownSec` (`150s`), `activeStrike: boolean`, `callerPlayerId: string | null`, `activeStrikeId: string | null`
- **Multiplayer Packet Contracts:**
  - Air strike request packet (`REQUEST_AIR_STRIKE` payload carrying `centerX`, `centerZ`, `headingRad`, validated & sanitized by relay guard).
  - Host-only air strike launch / active summary synced inside the fire-support sync packet (strictly capped at 2 active strikes, finite clamped coordinates, and validated headings).
  - Host-only rejection packet reusing the existing rejection toast path (`"Airspace Busy — Strike Inbound"`, `"Requires ≥ 50% Conquest Sectors"`, `"Target Inside 65m HQ Exclusion Zone"`, `"Air Strike Cooldown Active"`).
- **Dev Benchmark Output Contract (`FireSupportBenchReport`):**
  - `tier`: `'TIER_A_SOFTWARE' | 'TIER_B_HARDWARE'`
  - `rendererString`, `durationSec`, `samples`
  - `cpuP95Ms`, `totalFrameP95Ms`, `gpuP95Ms: number | 'SKIPPED_SOFTWARE_RENDERER' | 'FALLBACK_STRUCTURAL_PROXY'`
  - `gpuWarning: string | null`
  - `structuralProxy`: `{ fireSupportDrawCalls, fireSupportTriangles, activeShadowCasters, peakAudioVoices }`
  - `invariants`: `{ pitCapRespected, bomberPoolCapRespected, ordnancePoolCapRespected, decalPoolCapRespected, deterministicImpactHash }`
  - `passed: boolean`, `failures: string[]`

### Interactive Component & State Mapping

- **3D PDA Strike Selection & Rotation:**
  - While the PDA is open on the `fire_support` tab in Conquest:
    - `[1]` selects `'mortar_sweep'`, `[2]` selects `'air_strike'` (with tactile PDA click SFX; does not switch weapon slots while PDA is open).
    - `[Q]` / `[E]` rotates `airStrikeHeadingRad` counter-clockwise / clockwise smoothly (continuous hold + tap precision; blocked from leaning bodycam while PDA is open on Fire Support).
    - `[Space]` dispatches either a 5-round mortar sweep or a bomber air strike based on the selected mode, routing through local authority in solo matches or the host relay in multiplayer.
- **Bomber Run Lifecycle & Impact Resolution:**
  - On strike start, the team's pre-allocated aircraft slot activates at the ingress offset (`-240m` along `-heading`), ignites the 3 corridor flare markers, schedules the `P0` Doppler flyby cue, and advances deterministically each frame.
  - At the 6 deterministic release timestamps, bombs spawn from the shared `16`-slot ordnance pool, descend onto the `65m` corridor line with micro-scatter derived strictly from `seed`, and invoke the shared Conquest explosion handler (scoring, killfeed with snapshotted `callerId`, `100%`/`100%`/`25%` damage rules, `24`-slot FIFO scorch decals, and pooled blast light).
  - `ENABLE_CONQUEST_FIRE_SUPPORT` kill-switch cleanly disables both mortar and bomber systems together when toggled off.
- **Automated Verification & Unit Tests:**
  - Expand the fire-support test suite to verify `≥ 50%` sector gating, `150s` cooldown & concurrent `"Airspace Busy — Strike Inbound"` non-burning rejection, exact point-to-segment `45m` Danger Close and `65m` HQ exclusion math, `2`-aircraft pool cap & deterministic 6-bomb impact hash, relay-guard sanitization of air-strike packets, and Tier A / Tier B benchmark report gating (including loud structural proxy fallback when `EXT_disjoint_timer_query_webgl2` is missing).
