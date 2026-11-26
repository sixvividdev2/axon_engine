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
  readonly geminiVoice: 'Charon' | 'Fenrir' | 'Kore' | 'Puck' | 'Orus';
  /** Directing instruction used by the one-time offline voice baker */
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
 * Complete static voiceover cue manifest for the Prologue and all mandatory transit cinematics.
 * Runtime gameplay plays only pre-baked static WAV files in `/audio/cinematics/` (or clean local
 * radio cue synthesis if offline baking has not yet been run) — zero LLM API cost at runtime.
 */
export const CINEMATIC_VOICE_MANIFEST: readonly CinematicVoiceCue[] = [
  // =========================================================================
  // PROLOGUE CINEMATIC (Act 1: Drone Sweep + Gun-Cam Breach → Act 2: FP Heli Arrival → Act 3: Intake)
  // =========================================================================
  cue(
    'prologue_act1_overwatch',
    'prologue',
    0.8,
    4.6,
    'OVERWATCH ACTUAL',
    'Charon',
    'Calm, authoritative tactical military dispatcher over encrypted satcom radio.',
    'Sector perimeter breached across three corridors. Drones confirm hostile movement inside the quarantine belt.',
  ),
  cue(
    'prologue_act1_guncam',
    'prologue',
    6.4,
    3.6,
    'BREACH LEAD',
    'Fenrir',
    'Urgent, clipped tactical CQB callout over close-range throat mic during a room-clearing firefight.',
    'Contact front! Weapons hot — tango down, corridor clear!',
  ),
  cue(
    'prologue_act2_pilot',
    'prologue',
    11.4,
    4.4,
    'VALKYRIE 2-1',
    'Orus',
    'Steady helicopter pilot speaking through aviation headset over rotor wash.',
    'Descending on Bunker Helipad Zero-One. Keep your head on a swivel — pad lights are live.',
  ),
  cue(
    'prologue_act3_commander',
    'prologue',
    18.2,
    4.6,
    'OPS COMMANDER',
    'Kore',
    'Crisp, composed base commander welcoming an operator into an underground tactical bunker.',
    'Welcome to the Hideout. Check your weapons on the Arsenal wall, then report to the Ready Room.',
  ),

  // =========================================================================
  // APC TRANSIT: HIDEOUT → INFECTION OUTPOST
  // =========================================================================
  cue(
    'apc_to_outpost_board',
    'apc_to_outpost',
    0.7,
    3.8,
    'CONVOY DRIVER',
    'Fenrir',
    'Gruff armored-vehicle driver speaking beside an idling diesel APC.',
    'Armor is hot and doors are unlocked. Grab the passenger side — we roll in five.',
  ),
  cue(
    'apc_to_outpost_arrive',
    'apc_to_outpost',
    7.8,
    3.6,
    'CONVOY DRIVER',
    'Fenrir',
    'Focused armored-vehicle driver arriving at a fortified quarantine gate at night.',
    'Quarantine Outpost gate straight ahead. Step clear — Outpost Commander is waiting by the map board.',
  ),

  // =========================================================================
  // APC TRANSIT: INFECTION OUTPOST → HIDEOUT
  // =========================================================================
  cue(
    'apc_to_hideout_board',
    'apc_to_hideout',
    0.7,
    3.6,
    'CONVOY DRIVER',
    'Fenrir',
    'Steady armored-vehicle driver extracting an operator back to bunker.',
    'Hop in passenger side. Sealing hatches and running decon route back to the Hideout.',
  ),
  cue(
    'apc_to_hideout_arrive',
    'apc_to_hideout',
    7.6,
    3.4,
    'CONVOY DRIVER',
    'Fenrir',
    'Relieved driver pulling into underground bunker airlock apron.',
    'Back inside Sector Four. Airlock is green — watch your step on the ramp.',
  ),

  // =========================================================================
  // INFECTION MATCH BREACH (RAPID APC BREACH + GUN-CAM KILL SHOT)
  // =========================================================================
  cue(
    'infection_breach_call',
    'infection_breach',
    0.6,
    3.2,
    'OUTPOST COMMANDER',
    'Kore',
    'Sharp, urgent combat dispatch over tactical radio.',
    'Breaching hot zone! Ramp drops in three — watch the doorway!',
  ),
  cue(
    'infection_breach_kill',
    'infection_breach',
    4.6,
    2.6,
    'POINT MAN',
    'Fenrir',
    'Adrenaline-fueled close-quarters firefight callout.',
    'Infected in the hall — dropped him! Move in!',
  ),

  // =========================================================================
  // HELICOPTER INSERTION: PERIMETER OPS
  // =========================================================================
  cue(
    'heli_perimeter_board',
    'heli_to_perimeter',
    0.7,
    3.8,
    'FLIGHT CREW',
    'Orus',
    'Aviation crew chief over spinning helicopter blades.',
    'Birds turning on the pad. Strap into the troop bay — heading out to the Perimeter.',
  ),
  cue(
    'heli_perimeter_lz',
    'heli_to_perimeter',
    8.2,
    3.6,
    'VALKYRIE 2-1',
    'Orus',
    'Calm helicopter pilot calling final approach to a field landing zone.',
    'Thirty seconds to touchdown at FOB Landing Zone. Check your mag and stay low on exit.',
  ),

  // =========================================================================
  // HELICOPTER INSERTION: CONQUEST & BATTLE MODES
  // =========================================================================
  cue(
    'heli_combat_board',
    'heli_to_battle',
    0.7,
    3.6,
    'FLIGHT CREW',
    'Orus',
    'Urgent tactical flight crew chief preparing combat drop.',
    'Combat lift is green! Board starboard bench — inbound to hot combat sector.',
  ),
  cue(
    'heli_combat_guncam',
    'heli_to_battle',
    7.4,
    3.4,
    'OVERWATCH ACTUAL',
    'Charon',
    'Tactical air-ground controller over radio during hot LZ firefight.',
    'Vanguard squad already engaged in sector — hostile down! Dropping you on the flank.',
  ),
  cue(
    'heli_conquest_board',
    'heli_to_conquest',
    0.7,
    3.6,
    'FLIGHT CREW',
    'Orus',
    'Aviation crew chief prepping large-scale territory assault insertion.',
    'Conquest assault package is up. Climb aboard — inserting directly into theater HQ.',
  ),
  cue(
    'heli_conquest_lz',
    'heli_to_conquest',
    7.4,
    3.5,
    'VALKYRIE 2-1',
    'Orus',
    'Helicopter pilot calling hot insertion into contested territory.',
    'Crossing frontline now — gunship cleared the ridge. Touching down, go, go, go!',
  ),
];

export function getVoiceCuesForSequence(
  sequence: CinematicSequenceId,
): readonly CinematicVoiceCue[] {
  return CINEMATIC_VOICE_MANIFEST.filter((c) => c.sequence === sequence);
}
