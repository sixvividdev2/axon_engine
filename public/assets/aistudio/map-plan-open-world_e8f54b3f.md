# Open World Road Network, Enterable Settlements & Roadside Infrastructure

Transform the 4km × 4km Perimeter Operations theater from open wilderness into a lived-in, tactical corridor network featuring paved highways, FOB connector spurs, dirt logging trails, river bridges, enterable houses and gas stations with full doorway/cover collision, and biome-authentic roadside landmarks—all streamed within the existing `<= 7.0ms` RX 480 frametime budget.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> All core scope decisions below were confirmed during clarification and will govern implementation.

- **Confirmed Decision 1 — Enterable Buildings & Interiors**: Houses, gas station convenience stores, roadside checkpoints, and rural barns will feature true **enterable interiors** with open doorways, recessed window openings for sightlines, interior partition walls, solid floors, roof canopies, and tactical cover props (counters, crates, shelving) backed by full player capsule collision and bullet-stopping cover.
- **Confirmed Decision 2 — Interconnected Road Network**: The theater will feature a unified multi-tier road network consisting of the **Main North-South Tactical Highway**, **Paved FOB Connector Spurs** linking Alpha FOB and Bravo FOB directly onto the highway, **Elevated Steel-Truss River Bridges** where roads cross the central river, and **Compacted Dirt Logging & Quarry Trails** branching into rural homesteads and remote overlooks.
- **Confirmed Decision 3 — Full Roadside & Rural Map Elements**: Every selected element category will be built and distributed organically along roads and settlements:
  1. **Highway Hardware**: W-beam steel guardrails along sharp curves and drop-offs, reflective highway distance/route signs, and sodium-vapor streetlights that glow automatically during dusk/night.
  2. **Utility & Tactical Corridors**: Roadside wooden utility poles with catenary power lines running beside main roads, concrete/sandbag military checkpoints with boom barriers, and steel-girder river bridges.
  3. **Rural & Regional Landmarks**: Enterable red/weathered timber barns, elevated municipal water towers, and guyed lattice radio masts visible from afar for long-range navigation.
  4. **Roadside Clutter & Cover**: Abandoned civilian sedans/pickups/cargo vans (angled along shoulders, gas forecourts, and checkpoint pileups), dumpsters, Jersey concrete barriers, and HESCO/sandbag positions.

---

## 1. Overview & Core Concept

- **What It Does**: Replaces the flat painted road stripe and sparse wilderness with a structured, navigable civilization layer layered directly onto the 4km heightfield. Players and vehicles follow graded asphalt highways and dirt trails between FOBs, clear enterable gas stations and roadside villages room-by-room, cross steel bridges over the carved river gorge, and use guardrails, wrecked vehicles, and building interiors as authentic ballistic cover.
- **Target Audience / Persona**: Open World tactical operators conducting solo or squad patrols, convoy ambushes, long-range recon, and night operations across Coastal Port, Conifer Valley, Highland Quarry, and Alpine Dam.
- **Key Value**: Gives the 4km theater unmistakable spatial scale, natural sightline lanes, recognizable navigation landmarks both on foot and on the 3D Tactical PDA, and rich CQB interior engagements without sacrificing `60+ FPS` streaming performance.

---

## 2. User Experience & Visual Design

### Key User Flows
1. **FOB Departure & Highway Navigation**: Spawning at Alpha FOB or Bravo FOB now places a paved connector spur directly out of the base perimeter onto the main 2-lane highway, guided by weathered route signs, wooden power poles, and overhead streetlights.
2. **Roadside Gas Station & Settlement Raids**: Following the highway or dirt spurs leads to illuminated **Fuel & Service Stations** (drive-under canopy, dual fuel pump islands, roadside price pylon, and an enterable mini-mart with counter and storage room) and **Roadside Hamlets / Homesteads** (clusters of enterable 1- and 2-room residential houses, timber barns, and fenced yards).
3. **River Crossing & Checkpoint Ambush**: Where the highway and rail-valley spur cross the carved river channel, terrain grades seamlessly into concrete abutments and steel-truss deck bridges with guardrails, flanked by sandbag/Jersey-barrier roadblock checkpoints and stalled civilian vehicles.
4. **Night Operations Atmosphere**: As the dynamic 90-minute clock enters dusk and night, gas station canopies, highway streetlights, radio mast aviation beacons, and checkpoint floodlights cast warm amber/sodium accents—making roadside settlements readable through NVGs and creating tactical light/shadow traps.
5. **Tactical PDA Cartography**: Pulling up the 3D Tactical PDA displays crisp vector road lines (double-line asphalt highways, solid FOB spurs, dashed dirt trails), bridge ticks, fuel station icons, and village markers over the elevation contours.

### Visual Identity & Material Palette
- **Aesthetic Direction**: Grounded Eastern-European / Pacific-Northwest austere tactical realism—sun-faded asphalt, oxidized galvanized guardrails, weathered timber siding, rusted corrugated roofs, painted concrete curbs, and functional roadside signage (no arcade gloss or neon clutter).
- **Material & Color System**:
  - *Roadways*: Procedural asphalt canvas texture with worn tire tracks, double-amber centerlines, crisp white shoulder lines, and gravel verges; compacted reddish-brown gravel/mud texture for dirt trails.
  - *Residential Houses & Barns*: Muted clapboard plaster/timber walls (desaturated slate, weathered ochre, sage, faded brick), dark standing-seam or shingle pitched roofs, recessed dark window frames, and exposed concrete foundations skirted down into terrain slopes so no building ever floats.
  - *Gas Stations*: High-contrast utilitarian canopy fascia (industrial red/amber or petrol-teal trim), brushed steel fuel dispensers with hose nozzles, concrete apron pads, tiled convenience store interior, and warm overhead canopy emissive panels.
  - *Roadside Props & Vehicles*: Weathered matte clearcoat civilian wrecks (charcoal, faded navy, rust red, utility white, olive pickup), concrete Jersey barriers, galvanized steel guardrails, dark creosote utility poles, and dark-cable catenary spans.
- **Interactive Feedback & Audio Integration**:
  - Footstep surface detection automatically switches between **asphalt** (highways/spurs/gas aprons), **concrete** (house floors, checkpoints, bridge decks), **wood** (barns & interior floors), and **gravel** (dirt trails & road shoulders).
  - Entering any house, gas station store, or barn flips the interior acoustic probe (`isIndoor = true`) so weapon reports gain subtle indoor reverberation and footsteps dampen naturally.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Terrain-Graded Road Splines & Foundation Skirts**
  - *Chosen Approach*: Define all highways, FOB spurs, and dirt trails as deterministic polyline/spline segments in a central Road & Settlement Topology layer. The terrain heightfield gently flattens road cross-sections (banked to match longitudinal grade) and flattens circular building pads underneath every placed house, gas station, barn, and checkpoint; additionally, every building includes a deep concrete foundation plinth extending `-1.8m` downward.
  - *Why*: Eliminates floating walls, sunken doorways, and jagged stair-stepped roads across hilly terrain while preserving deterministic height queries everywhere on the 4km map.
  - *Alternatives Considered*: Raycasting buildings onto raw sloped terrain (causes tilted doorways and floating corners).

- **Decision 2 — Chunk-Streamed Merged Building Batches + Instanced Roadside Hardware**
  - *Chosen Approach*: Stream buildings and road ribbons strictly inside the existing `3×3` Active Ring (with low-poly silhouette proxies in the `5×5` Mid-Range Shell and tall landmarks like water towers and radio masts in the Horizon Layer). Inside each active chunk, combine static building walls/roofs by shared PBR material into merged chunk buffers, and front-pack repeated hardware (guardrail posts, power poles, streetlights, road signs, Jersey barriers, parked vehicles) into `THREE.InstancedMesh` batches, explicitly calling `.dispose()` on chunk unload.
  - *Why*: Keeps total draw calls comfortably within the `< 150–250` budget and preserves `<= 7.0ms` frametime on RX 480 hardware while supporting dozens of detailed enterable interiors across the 4km theater.
  - *Alternatives Considered*: Spawning individual Three.js meshes for every plank, wall, and prop (would exceed 1,000+ draw calls and trigger severe GC pauses on chunk crossings).

- **Decision 3 — Unified Oriented Bounding Box (OBB) Physics & Ballistic Cover Registry**
  - *Chosen Approach*: Every building wall segment, doorway frame, roof slab, bridge deck/parapet, gas canopy pillar, fuel pump, and abandoned vehicle registers lightweight oriented collision boxes (`OBB` / walk-surface decks) with the active chunk. The world adapter queries only the player's current and adjacent active chunk colliders for:
    1. **Capsule Slide & Step-Up Collision**: Smooth horizontal sliding along walls, walking cleanly through `1.3m–2.2m` doorways and across elevated bridge decks over water.
    2. **Ballistics & AI Line-of-Sight Raycasts**: Bullets stop on concrete/metal/wood building walls, vehicle hulls, and barriers (playing surface-matched material impacts), while passing cleanly through open doorways and window bays.
    3. **Interior Acoustic Bounds**: Fast box-containment check marks indoor rooms so gunfire and footsteps use interior acoustics.
  - *Why*: Delivers zero-allocation, deterministic collision and real ballistic cover inside every enterable house and gas station without expensive triangle-mesh raycasting over the entire 4km world.
  - *Alternatives Considered*: Full Three.js triangle raycasting against all chunk meshes (causes frame spikes during automatic gunfire and breaks zero-GC guarantees).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     OPEN WORLD CIVILIZATION TOPOLOGY                         │
│  Deterministic 4km Road Graph (Highway, FOB Spurs, Dirt Trails, Bridges)     │
│  + Curated & Deterministic Site Catalog (Gas Stations, Settlements,          │
│    Checkpoints, Barns, Water Towers, Radio Masts)                            │
└───────────────┬──────────────────────────────────────────┬───────────────────┘
                │                                          │
                ▼                                          ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│    4-BIOME HEIGHTFIELD ENGINE      │    │     3D TACTICAL PDA CARTOGRAPHY    │
│  • Grades roadbeds & cross-slopes  │    │  • Draws highway, spurs & trails   │
│  • Levels pads for settlements,    │    │  • Marks bridges, gas stations,    │
│    gas stations & checkpoints      │    │    hamlets & radio/water towers    │
│  • Exposes road/bridge/pad masks   │    │    onto the PDA topo canvas        │
└───────────────┬────────────────────┘    └────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                 3-RING CHUNK STREAMER & ARCHITECTURE BUILDER                 │
│                                                                              │
│  Active Ring (3×3 Chunks)                                                    │
│  ├─ Terrain-conforming asphalt & dirt ribbon meshes (lane markings + verge) │
│  ├─ Enterable Structure Generator (merged PBR meshes + foundation plinths):  │
│  │   • 1- & 2-room Houses (doorways, recessed windows, interior partition)   │
│  │   • Gas Stations (illuminated canopy, pump islands, enterable mini-mart)  │
│  │   • Rural Barns & Military Checkpoints (sandbags, guard shack, barrier)   │
│  ├─ Steel-Truss River Bridges (walkable deck surface + girders + railings)   │
│  ├─ Instanced Roadside Hardware (guardrails, streetlights, utility poles +   │
│  │   catenary wires, route signs, Jersey barriers, abandoned vehicles)       │
│  └─ Per-Chunk Solid OBB, Walkable Deck & Indoor Volume Registry              │
│                                                                              │
│  Mid-Range Ring (5×5 Shell) & Horizon Layer                                  │
│  ├─ Simplified building silhouettes & road ribbons                           │
│  └─ Persistent tall landmarks (Water Towers, Guyed Radio Masts, Bridges)     │
│  └─ Explicit .dispose() of all chunk geometries & OBB records on unload      │
└───────────────┬──────────────────────────────────────────┬───────────────────┘
                │                                          │
                ▼                                          ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│     WORLD COLLISION & BALLISTICS   │    │     DAY/NIGHT ATMOSPHERE SYNC      │
│  • Capsule slide against OBB walls │    │  • Toggles streetlight, canopy &   │
│  • Walkable bridge & floor heights │    │    aviation beacon emissives at    │
│  • Zero-GC ray-OBB bullet cover    │    │    dusk/night with zero allocations│
│  • Indoor room audio detection     │    │  • Keeps trees/rocks culled off    │
│  • Vehicle clearance on roadways   │    │    all road corridors & pads       │
└────────────────────────────────────┘    └────────────────────────────────────┘
```

### Data Model & Spatial Distribution
- **Road Segment Graph**:
  - `Main Highway (Route 41)`: Sweeping 2-lane paved highway (`11m` wide with painted double-yellow centerline and white shoulders) from **Delta Coastal Port** → **Pine Valley Gas & Hamlet** → **River Bridge Crossing** → **Timberline Rail Yard** → **Steppe Crossroads & Gas Station** → **Highland Quarry** → **Alpine Dam Approach**.
  - `FOB Paved Spurs`: Two-lane paved access roads (`9m` wide) branching directly from **PMC Alpha FOB** and **PMC Bravo FOB** onto Route 41, with checkpoint gatehouses near each junction.
  - `Dirt Logging & Rural Trails`: Compacted gravel/dirt tracks (`6.5m` wide) winding to timberline homesteads, coastal marsh shacks, highland farmsteads, and radio ridge overlooks.
- **Enterable Sites & Roadside Landmarks (Distributed Across All 4 Biomes)**:
  - **4 Roadside Gas Stations** (Coastal Port Approach, Conifer Valley Junction, Steppe Highway Rest Stop, Alpine Pass Fuel Depot): Concrete forecourt, 4-pillar lit overhead canopy, 2 fuel pump islands, roadside fuel price sign, enterable convenience store with checkout counter/shelving/back door, dumpster, and parked civilian vehicles.
  - **5+ Rural Settlements & Roadside Hamlets** (18–24 enterable houses total across biomes): Varied footprints (small cabin, L-shaped homestead, two-room bungalow) with open front/rear doors, waist-high window bays for firing ports, interior room divider, roof overhangs, and porch steps.
  - **3 Steel-Truss River Bridges**: Elevated deck bridges spanning the carved river corridor wherever Route 41 or valley spurs cross water, complete with concrete abutments, steel side trusses, guardrails, and solid walkable/drivable bridge deck height overrides.
  - **4+ Military Roadside Checkpoints**: Guard booth (enterable), angled concrete Jersey barriers creating chicane lanes, sandbag nests, striped boom arm, overhead floodlight mast, and stalled civilian wrecks.
  - **Rural Landmarks**: Enterable timber barns, elevated steel-leg water towers, and tall red/white guyed lattice radio masts placed on ridges and village edges (visible in the Horizon Proxy Layer).
  - **Continuous Corridor Props**: Instanced steel W-beam guardrails along steep highway embankments, highway mileage/route signs at junctions, sodium streetlights near stations/hamlets/FOB spurs, creosote power poles with hanging catenary cables following paved roads, and abandoned cars/pickups/vans providing roadside cover.

### Interactive Component & State Mapping
- **Chunk Streamer → World Adapter**: Active `3×3` chunks publish their `SolidObb[]`, `WalkDeck[]`, and `IndoorVolume[]` arrays to the streamer; the world adapter queries only loaded active chunks during `getGroundHeight`, `sweepCapsule`, `raycast`, `getSurfaceMaterial`, and `sampleInterior` (zero per-frame heap allocations).
- **Atmosphere Cycle → Emissive Night Fixtures**: Shared emissive materials for streetlights, gas station canopy panels, and radio mast beacons smoothly ramp intensity from `0.0` (day) to `1.8` (dusk/night) driven directly by the existing atmosphere controller—requiring zero per-lamp dynamic PointLights to preserve RX 480 performance.
- **Road & Site Topology → Tactical PDA & Foliage Culling**: The exact same road/pad clearance query both prevents trees, boulders, and scrub from spawning inside roadways, bridges, or house interiors AND draws the road network and POI markers accurately on the 3D Tactical PDA map.
- **Verification Plan**: Add automated unit tests verifying road/pad terrain grading, walkable bridge deck heights above river water, enterable doorway pass-through vs. solid wall capsule blocking, ray-OBB ballistic cover stops, indoor acoustic detection, draw-call/instance discipline, and full `.dispose()` cleanup on chunk unload.
