import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { CINEMATIC_VOICE_MANIFEST, CinematicVoiceCue } from '../cinematics/cinematicVoiceManifest';

const OUTPUT_DIR = path.resolve(process.cwd(), 'public', 'audio', 'cinematics');
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';

/**
 * Generates a single 24kHz mono 16-bit WAV file via Gemini 3.8 TTS and saves it to disk.
 * Gemini 3.8 TTS unary generateContent returns a complete WAV file (with 44-byte RIFF header)
 * in `inlineData.data` — write the decoded buffer directly without adding a second header.
 */
async function bakeCueWithGemini(ai: GoogleGenAI, cue: CinematicVoiceCue): Promise<Buffer> {
  const prompt = `[Direction: ${cue.stylePrompt}]\n${cue.text}`;
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: prompt,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: cue.geminiVoice,
          },
        },
      },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const base64Audio = part?.inlineData?.data;
  if (!base64Audio) {
    throw new Error(`No audio data returned for cue "${cue.id}"`);
  }
  return Buffer.from(base64Audio, 'base64');
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    console.error(
      '[bakeCinematicVoices] GEMINI_API_KEY is not set. Export GEMINI_API_KEY and re-run `npm run bake:cinematics` to bake static Gemini 3.8 TTS WAV files once.',
    );
    process.exitCode = 1;
    return;
  }

  const forceOverwrite = process.argv.includes('--force');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  let bakedCount = 0;
  let skippedCount = 0;

  for (const cue of CINEMATIC_VOICE_MANIFEST) {
    const outPath = path.join(OUTPUT_DIR, `${cue.id}.wav`);
    if (!forceOverwrite) {
      try {
        const stat = await fs.stat(outPath);
        if (stat.size > 44) {
          skippedCount += 1;
          console.log(`[skip] ${cue.id}.wav (${stat.size} bytes)`);
          continue;
        }
      } catch {
        // File does not exist yet — bake it now
      }
    }

    console.log(`[bake] ${cue.id} (${cue.speaker} / ${cue.geminiVoice}) via ${TTS_MODEL}...`);
    const wavBytes = await bakeCueWithGemini(ai, cue);
    await fs.writeFile(outPath, wavBytes);
    bakedCount += 1;
    console.log(`[saved] ${outPath} (${wavBytes.length} bytes)`);
  }

  console.log(
    `[bakeCinematicVoices] Complete — baked ${bakedCount}, skipped ${skippedCount}, total ${CINEMATIC_VOICE_MANIFEST.length} cues.`,
  );
}

void main();
