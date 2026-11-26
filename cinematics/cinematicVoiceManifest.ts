export type CinematicSequenceId =
  | 'prologue'
  | 'apc_to_outpost'
  | 'apc_to_hideout'
  | 'infection_breach'
  | 'heli_to_perimeter'
  | 'heli_to_conquest'
  | 'heli_to_battle';

export interface CinematicVoiceCue {
  readonly id: string;
  readonly sequence: CinematicSequenceId;
  /** Time offset in seconds within the cinematic timeline */
  readonly startSec: number;
  /** Display duration in seconds for the synchronized caption */
  readonly durationSec: number;
  readonly speaker: string;
  /** Gemini 3.8 TTS prebuilt voice name used when baking offline */
  readonly geminiVoice: 'Charon' | 'Fenrir' | 'Kore' | 'Puck' | 'Zephyr';
  /** Directing instruction passed to `speechMetadata.style` in the offline baker */
  readonly stylePrompt: string;
  /** Spoken transcript & rendered subtitle text */
  readonly text: string;
  /** Static runtime audio path (zero runtime API calls) */
  readonly audioUrl: string;
}

function cue(
  id: string,
  sequence: CinematicSequenceId,
  startSec: number,
  durationSec: number,
  speaker: string,
  geminiVoice: CinematicVoiceCue['geminiVoice'],
  stylePrompt: string,
  text: string,
): CinematicVoiceCue {
  return {
    id,
    sequence,
    startSec,
    durationSec,
    speaker,
    geminiVoice,
    stylePrompt,
    text,
    audioUrl: `/audio/cinematics/${id}.wav`,
  };
}

/**
 * Complete static voiceover cue manifest for the 48s Prologue and all expanded 24-26s transit cinematics.
 * Runtime gameplay plays only pre-baked static WAV files in `/audio/cinematics/` (or crisp radio squelch
 * clicks + captions if offline baking has not been run) — strictly zero runtime LLM API cost.
 */
export const CINEMATIC_VOICE_MANIFEST: readonly CinematicVoiceCue[] = [
  // =========================================================================
  // PROLOGUE CINEMATIC (48.0s)
  // Act 1A: Aerial Cinema Sweep (0-12s) -> Act 1B: Squadmate Gun-Cam Breach (12-23s)
  // Act 2: Interactive FP Helicopter Approach (23-38s) -> Act 3: Airlock Intake Briefing (38-48s)
  // =========================================================================
  cue(
    'prologue_act1_overwatch',
    'prologue',
    1.2,
    5.2,
    'OVERWATCH ACTUAL',
    'Charon',
    'Calm, authoritative tactical military dispatcher over encrypted satcom radio.',
    'Sector perimeter breached across three corridors. Drones confirm hostile movement inside the quarantine belt.',
  ),
  cue(
    'prologue_act1_dispatch',
    'prologue',
    7.0,
    4.4,
    'OVERWATCH ACTUAL',
    'Charon',
    'Measured tactical commander briefing an incoming operator over satcom.',
    'Vanguard breach element is already inside Sector Four. Switching to point-man weapon feed.',
  ),
  cue(
    'prologue_act1_guncam',
    'prologue',
    12.8,
    3.8,
    'BREACH LEAD',
    'Fenrir',
    'Urgent, clipped close-quarters tactical callout over throat mic during room clearing.',
    'Stacking left — pushing the corridor! Weapons hot, watch that crate!',
  ),
  cue(
    'prologue_act1_squadkill',
    'prologue',
    18.2,
    4.0,
    'BREACH LEAD',
    'Fenrir',
    'Sharp, focused squad leader confirming room cleared after a firefight.',
    'Two down — rear doorway clear! All hostiles neutralized, holding the hallway.',
  ),
  cue(
    'prologue_act2_pilot',
    'prologue',
    24.4,
    5.2,
    'VALKYRIE 2-1',
    'Puck',
    'Steady military helicopter pilot speaking through aviation headset over rotor wash.',
    'Valkyrie Two-One descending on Bunker Helipad Zero-One. Pad beacons are live — look sharp on approach.',
  ),
  cue(
    'prologue_act2_crew',
    'prologue',
    31.2,
    5.0,
    'CREW CHIEF',
    'Zephyr',
    'Experienced flight crew chief briefing a passenger inside an open helicopter troop bay.',
    'Skids coming down in ten seconds. Check your plates and gear — Commander Kovacs is waiting at the airlock.',
  ),
  cue(
    'prologue_act3_commander',
    'prologue',
    40.0,
    6.4,
    'OPS COMMANDER',
    'Kore',
    'Crisp, composed base commander welcoming an operator into an underground tactical bunker.',
    'Welcome to the Hideout. Check your firearms on the Arsenal wall, then report to the Ready Room or Perimeter Wing for tasking.',
  ),

  // =========================================================================
  // APC TRANSIT: HIDEOUT → INFECTION OUTPOST (24.5s, midpoint fade @ 14.8s)
  // =========================================================================
  cue(
    'apc_to_outpost_board',
    'apc_to_outpost',
    1.0,
    4.6,
    'CONVOY DRIVER',
    'Fenrir',
    'Gruff armored-vehicle driver speaking beside an idling diesel APC.',
    'Armor is hot and doors are unlocked. Take the passenger seat — we roll through Sector Four in five.',
  ),
  cue(
    'apc_to_outpost_roll',
    'apc_to_outpost',
    7.2,
    4.4,
    'CONVOY DRIVER',
    'Fenrir',
    'Steady armored transport driver accelerating down a dark concrete tunnel.',
    'Hatches locked. Pushing down the quarantine tunnel — keep your rifle close.',
  ),
  cue(
    'apc_to_outpost_arrive',
    'apc_to_outpost',
    16.4,
    5.4,
    'CONVOY DRIVER',
    'Fenrir',
    'Focused driver arriving at a fortified quarantine gate at night.',
    'Fortified Infection Outpost straight ahead. Stepping you out at the south yard — Outpost Commander is by the map board.',
  ),

  // =========================================================================
  // APC TRANSIT: INFECTION OUTPOST → HIDEOUT (24.5s, midpoint fade @ 14.8s)
  // =========================================================================
  cue(
    'apc_to_hideout_board',
    'apc_to_hideout',
    1.0,
    4.6,
    'CONVOY DRIVER',
    'Fenrir',
    'Steady armored-vehicle driver extracting an operator back to bunker.',
    'Climb in passenger side. Sealing armored doors and running the decon corridor back to the Hideout.',
  ),
  cue(
    'apc_to_hideout_roll',
    'apc_to_hideout',
    7.2,
    4.2,
    'CONVOY DRIVER',
    'Fenrir',
    'Calm convoy driver leaving a quarantine checkpoint.',
    'Clear of the perimeter wire. Heading underground to Sector Four Airlock.',
  ),
  cue(
    'apc_to_hideout_arrive',
    'apc_to_hideout',
    16.4,
    5.2,
    'CONVOY DRIVER',
    'Fenrir',
    'Relieved driver pulling into underground bunker airlock apron.',
    'Back inside Sector Four. Airlock seal is green — watch your step on the apron.',
  ),

  // =========================================================================
  // INFECTION MATCH BREACH (15.5s: 6s Convoy + 9.5s Squadmate 3-Kill Gun-Cam)
  // =========================================================================
  cue(
    'infection_breach_call',
    'infection_breach',
    0.8,
    4.4,
    'OUTPOST COMMANDER',
    'Kore',
    'Sharp, urgent combat dispatch over tactical radio.',
    'Breaching hot zone! Armored ramp drops in three — stack up and clear the entry hall!',
  ),
  cue(
    'infection_breach_kill',
    'infection_breach',
    7.4,
    3.6,
    'POINT MAN',
    'Fenrir',
    'Adrenaline-fueled close-quarters firefight callout.',
    'Hostiles in the corridor — engaging! Taking the flanker on the left!',
  ),
  cue(
    'infection_breach_clear',
    'infection_breach',
    12.0,
    2.9,
    'POINT MAN',
    'Fenrir',
    'Crisp tactical confirmation after dropping the last hostile.',
    'Third target down! Entry hall clear — move in!',
  ),

  // =========================================================================
  // HELICOPTER INSERTION: PERIMETER OPS (24.5s, midpoint fade @ 10.3s)
  // =========================================================================
  cue(
    'heli_perimeter_board',
    'heli_to_perimeter',
    1.0,
    4.6,
    'FLIGHT CREW',
    'Zephyr',
    'Aviation crew chief speaking over spinning helicopter blades.',
    'Rotors turning on Pad Zero-One. Strap into the starboard bench — lifting off for the Perimeter.',
  ),
  cue(
    'heli_perimeter_transit',
    'heli_to_perimeter',
    11.8,
    4.8,
    'VALKYRIE 2-1',
    'Puck',
    'Calm military helicopter pilot banking low over misty terrain.',
    'Crossing outer ridge at low altitude. Keep your eyes on the tree line — weather is closing in.',
  ),
  cue(
    'heli_perimeter_lz',
    'heli_to_perimeter',
    18.0,
    5.2,
    'VALKYRIE 2-1',
    'Puck',
    'Focused pilot calling final touchdown at a field landing zone.',
    'Green smoke spotted at FOB Landing Zone. Touching skids down — stay low on exit and check your mags.',
  ),

  // =========================================================================
  // HELICOPTER INSERTION: CONQUEST (26.0s, midpoint @ 10.3s, Gun-Cam @ 16.5s)
  // =========================================================================
  cue(
    'heli_conquest_board',
    'heli_to_conquest',
    1.0,
    4.6,
    'FLIGHT CREW',
    'Zephyr',
    'Aviation crew chief prepping large-scale territory assault insertion.',
    'Conquest assault package is green. Climb aboard Valkyrie Two-One — inserting straight into theater HQ.',
  ),
  cue(
    'heli_conquest_lz',
    'heli_to_conquest',
    11.4,
    4.4,
    'VALKYRIE 2-1',
    'Puck',
    'Helicopter pilot calling hot insertion into contested territory.',
    'Crossing the contested frontline now. Vanguard breach team is clearing the objective compound ahead.',
  ),
  cue(
    'heli_conquest_guncam',
    'heli_to_conquest',
    18.4,
    5.4,
    'BREACH LEAD',
    'Fenrir',
    'Urgent tactical squad leader clearing an interior compound during a battle.',
    'Multiple hostiles in the compound hall — three down! Sector beachhead is open, move in!',
  ),

  // =========================================================================
  // HELICOPTER INSERTION: BATTLE MODES (26.0s, midpoint @ 10.3s, Gun-Cam @ 16.5s)
  // =========================================================================
  cue(
    'heli_combat_board',
    'heli_to_battle',
    1.0,
    4.6,
    'FLIGHT CREW',
    'Zephyr',
    'Urgent tactical flight crew chief preparing combat drop.',
    'Combat lift is green! Board the starboard bench — inbound to active combat sector.',
  ),
  cue(
    'heli_combat_transit',
    'heli_to_battle',
    11.4,
    4.4,
    'OVERWATCH ACTUAL',
    'Charon',
    'Tactical air-ground controller over radio during hot LZ firefight.',
    'Gunship reports heavy small-arms fire ahead. Switching live to Vanguard point-man rail cam.',
  ),
  cue(
    'heli_combat_guncam',
    'heli_to_battle',
    18.4,
    5.4,
    'BREACH LEAD',
    'Fenrir',
    'Focused close-quarters breacher calling out neutralized threats.',
    'Contact front and right flank — three tangos down! Dropping you on the breach line!',
  ),
];

export function getVoiceCuesForSequence(
  sequence: CinematicSequenceId,
): readonly CinematicVoiceCue[] {
  return CINEMATIC_VOICE_MANIFEST.filter((c) => c.sequence === sequence);
}
