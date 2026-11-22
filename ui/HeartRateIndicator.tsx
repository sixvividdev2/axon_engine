import React, { useEffect, useRef } from 'react';

export interface HeartRateIndicatorProps {
  bpm: number;
  stress: number;
  holdBreath?: boolean;
  bleeding?: boolean;
}

type CardiacZone = {
  label: string;
  stroke: string;
  glow: string;
  textClass: string;
  zoneClass: string;
};

function resolveCardiacZone(
  bpm: number,
  stress: number,
  holdBreath?: boolean,
  bleeding?: boolean,
): CardiacZone {
  if (bpm <= 0) {
    return {
      label: 'FLATLINE',
      stroke: '#ef4444',
      glow: 'rgba(239, 68, 68, 0.55)',
      textClass: 'text-red-400',
      zoneClass: 'text-red-400/90',
    };
  }
  if (bpm >= 145 || stress >= 0.82 || (bleeding && bpm >= 122)) {
    return {
      label: bleeding ? 'TRAUMA' : 'PEAK',
      stroke: '#ef4444',
      glow: 'rgba(239, 68, 68, 0.5)',
      textClass: 'text-red-300',
      zoneClass: 'text-red-400/95',
    };
  }
  if (bpm >= 118 || stress >= 0.48 || bleeding) {
    return {
      label: bleeding ? 'BLEED' : 'STRESS',
      stroke: '#f59e0b',
      glow: 'rgba(245, 158, 11, 0.42)',
      textClass: 'text-amber-200',
      zoneClass: 'text-amber-400/95',
    };
  }
  if (holdBreath) {
    return {
      label: 'HOLD',
      stroke: '#7dd3fc',
      glow: 'rgba(125, 211, 252, 0.35)',
      textClass: 'text-sky-200',
      zoneClass: 'text-sky-300/90',
    };
  }
  if (bpm >= 97) {
    return {
      label: 'ACTIVE',
      stroke: '#d4e7dc',
      glow: 'rgba(212, 231, 220, 0.3)',
      textClass: 'text-neutral-100',
      zoneClass: 'text-neutral-300/85',
    };
  }
  if (bpm >= 77) {
    return {
      label: 'READY',
      stroke: '#c6dfd1',
      glow: 'rgba(198, 223, 209, 0.28)',
      textClass: 'text-neutral-200/95',
      zoneClass: 'text-neutral-400/90',
    };
  }
  return {
    label: 'REST',
    stroke: '#b8d8c6',
    glow: 'rgba(184, 216, 198, 0.28)',
    textClass: 'text-neutral-200/90',
    zoneClass: 'text-neutral-400/85',
  };
}

/**
 * Synthesizes a realistic single-beat P-Q-R-S-T ECG sample for normalized cardiac cycle phase [0, 1).
 * Returns normalized vertical deflection in roughly [-0.35, +1.0].
 */
function sampleEcgWaveform(phase: number, stress: number): number {
  const gauss = (x: number, mu: number, sigma: number) => {
    const d = (x - mu) / sigma;
    return Math.exp(-0.5 * d * d);
  };

  // Compress complexes slightly at high tachycardia while preserving sharp QRS morphology
  const ampScale = 0.88 + stress * 0.16;
  const pWave = 0.13 * gauss(phase, 0.14, 0.028);
  const qWave = -0.16 * gauss(phase, 0.245, 0.0085);
  const rPeak = 1.0 * ampScale * gauss(phase, 0.27, 0.0095);
  const sDip = -0.32 * gauss(phase, 0.296, 0.0105);
  const tWave = 0.23 * gauss(phase, 0.46, 0.044);

  return pWave + qWave + rPeak + sDip + tWave;
}

const TRACE_W = 88;
const TRACE_H = 20;
const SAMPLE_COUNT = 88;

export const HeartRateIndicator: React.FC<HeartRateIndicatorProps> = ({
  bpm,
  stress,
  holdBreath = false,
  bleeding = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef({
    bpm,
    stress,
    stroke: '#b8d8c6',
    glow: 'rgba(184, 216, 198, 0.28)',
  });

  const clampedBpm = Math.max(0, Math.round(bpm));
  const clampedStress = Math.min(1, Math.max(0, stress));
  const zone = resolveCardiacZone(clampedBpm, clampedStress, holdBreath, bleeding);

  liveRef.current.bpm = clampedBpm;
  liveRef.current.stress = clampedStress;
  liveRef.current.stroke = zone.stroke;
  liveRef.current.glow = zone.glow;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = TRACE_W * dpr;
    canvas.height = TRACE_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const samples = new Float32Array(SAMPLE_COUNT);
    const baselineY = TRACE_H * 0.68;
    const verticalScale = TRACE_H * 0.56;

    const drawStaticTrace = () => {
      const { bpm: curBpm, stress: curStress, stroke } = liveRef.current;
      ctx.clearRect(0, 0, TRACE_W, TRACE_H);

      // Subtle baseline reference line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, baselineY);
      ctx.lineTo(TRACE_W, baselineY);
      ctx.stroke();

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      const cycles = curBpm <= 0 ? 0 : Math.max(1, curBpm / 62);
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const x = (i / (SAMPLE_COUNT - 1)) * TRACE_W;
        const val =
          curBpm <= 0 ? 0 : sampleEcgWaveform(((i / SAMPLE_COUNT) * cycles) % 1, curStress);
        const y = baselineY - val * verticalScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (reducedMotion) {
      drawStaticTrace();
      const id = window.setInterval(drawStaticTrace, 500);
      return () => window.clearInterval(id);
    }

    let rafId = 0;
    let lastTime = performance.now();
    let beatPhase = 0;
    let writeHead = 0;
    let sampleAccum = 0;
    const sweepSamplesPerSec = 42; // ~2.1s full sweep across 88px monitor

    const renderFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) * 0.001));
      lastTime = now;

      const { bpm: curBpm, stress: curStress, stroke, glow } = liveRef.current;
      const beatsPerSec = curBpm > 0 ? curBpm / 60 : 0;

      sampleAccum += dt * sweepSamplesPerSec;
      const steps = Math.min(8, Math.floor(sampleAccum));
      if (steps > 0) {
        sampleAccum -= steps;
        const stepDt = 1 / sweepSamplesPerSec;
        for (let s = 0; s < steps; s++) {
          if (beatsPerSec > 0) {
            beatPhase = (beatPhase + stepDt * beatsPerSec) % 1;
            samples[writeHead] = sampleEcgWaveform(beatPhase, curStress);
          } else {
            samples[writeHead] = 0;
          }
          writeHead = (writeHead + 1) % SAMPLE_COUNT;
        }
      }

      ctx.clearRect(0, 0, TRACE_W, TRACE_H);

      // Subtle horizontal isoelectric line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, baselineY);
      ctx.lineTo(TRACE_W, baselineY);
      ctx.stroke();

      // Sweep monitor with leading blanking gap (7px) and phosphor age fade
      const gapSamples = 7;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 1; i < SAMPLE_COUNT; i++) {
        // Distance behind writeHead (0 = newest sample just written)
        const age = (writeHead - 1 - i + SAMPLE_COUNT) % SAMPLE_COUNT;
        const prevAge = (writeHead - 1 - (i - 1) + SAMPLE_COUNT) % SAMPLE_COUNT;
        if (age > SAMPLE_COUNT - gapSamples || prevAge > SAMPLE_COUNT - gapSamples) continue;

        const freshness = 1 - age / (SAMPLE_COUNT - gapSamples);
        const alpha = 0.16 + freshness * freshness * 0.84;

        const x0 = ((i - 1) / (SAMPLE_COUNT - 1)) * TRACE_W;
        const x1 = (i / (SAMPLE_COUNT - 1)) * TRACE_W;
        const y0 = baselineY - samples[i - 1] * verticalScale;
        const y1 = baselineY - samples[i] * verticalScale;

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Crisp leading phosphor cursor dot at active write position
      const headIdx = (writeHead - 1 + SAMPLE_COUNT) % SAMPLE_COUNT;
      const hx = (headIdx / (SAMPLE_COUNT - 1)) * TRACE_W;
      const hy = baselineY - samples[headIdx] * verticalScale;
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hx, hy, 1.05, 0, Math.PI * 2);
      ctx.fill();

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      className="flex items-center gap-2.5 font-mono-tabular leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.95)]"
      aria-label={`Heart rate ${clampedBpm} beats per minute, status ${zone.label}`}
    >
      <canvas
        ref={canvasRef}
        className="block h-[20px] w-[88px] shrink-0"
        width={TRACE_W}
        height={TRACE_H}
      />

      <div className="flex items-baseline gap-1.5">
        <span className="text-[9px] uppercase tracking-[0.14em] text-neutral-400/90">HR</span>
        <span className={`inline-block w-[3ch] text-right text-xs font-semibold ${zone.textClass}`}>
          {clampedBpm > 0 ? clampedBpm : '--'}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-neutral-400/85">BPM</span>
        <span className={`min-w-[4.5ch] text-right text-[9px] font-medium uppercase tracking-[0.14em] ${zone.zoneClass}`}>
          {zone.label}
        </span>
      </div>
    </div>
  );
};
