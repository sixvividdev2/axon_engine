import React, { useEffect, useRef, useState } from 'react';

export type AirlockTransitionDirection = 'to_outpost' | 'to_hideout';

interface AirlockTransitionOverlayProps {
  active: boolean;
  direction: AirlockTransitionDirection;
  /** Invoked once at peak decontamination mist occlusion (~720ms) to swap WebGL scenes cleanly */
  onMidpointSwap: () => void;
  /** Invoked when the ~1.8s airlock & transport cycle finishes clearing */
  onComplete: () => void;
}

const TOTAL_DURATION_MS = 1820;
const MIDPOINT_SWAP_MS = 720;

/**
 * Grounded ~1.8s bodycam airlock pressurization & decontamination transition overlay.
 * Uses pure GPU compositor properties (opacity + transform) and ZERO backdrop-filter,
 * cleanly masking the outgoing scene disposal and incoming 3D lobby mount at peak mist density.
 */
export const AirlockTransitionOverlay: React.FC<AirlockTransitionOverlayProps> = ({
  active,
  direction,
  onMidpointSwap,
  onComplete,
}) => {
  const [progress, setProgress] = useState(0);
  const midpointFiredRef = useRef(false);
  const onMidpointRef = useRef(onMidpointSwap);
  onMidpointRef.current = onMidpointSwap;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!active) {
      setProgress(0);
      midpointFiredRef.current = false;
      return;
    }

    midpointFiredRef.current = false;
    const startMs = performance.now();
    let rafId = 0;

    const step = (now: number) => {
      const elapsed = now - startMs;
      const p = Math.min(1, elapsed / TOTAL_DURATION_MS);
      setProgress(p);

      if (!midpointFiredRef.current && elapsed >= MIDPOINT_SWAP_MS) {
        midpointFiredRef.current = true;
        onMidpointRef.current();
      }

      if (elapsed < TOTAL_DURATION_MS) {
        rafId = requestAnimationFrame(step);
      } else {
        onCompleteRef.current();
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [active, direction]);

  if (!active) return null;

  // Stage curve:
  // 0.00 -> 0.36: rapid blast door seal & mist surge to full occlusion
  // 0.36 -> 0.64: dense full-screen decontamination occlusion (scene swap executes at 0.395)
  // 0.64 -> 1.00: smooth depressurization & mist dissipation as outer door/ramp opens
  const mistOpacity =
    progress < 0.36
      ? Math.min(1, Math.pow(progress / 0.36, 0.78))
      : progress < 0.64
        ? 1
        : Math.max(0, 1 - Math.pow((progress - 0.64) / 0.36, 1.15));

  // Heavy hydraulic shutter vignette framing lens during seal/unseal
  const shutterClose =
    progress < 0.34
      ? progress / 0.34
      : progress < 0.66
        ? 1
        : Math.max(0, 1 - (progress - 0.66) / 0.34);

  // Subtle crimson/amber emergency strobe wash pulsing during pressurization
  const strobeWave = 0.5 + 0.5 * Math.sin(progress * Math.PI * 7.5);
  const strobeAlpha = mistOpacity * (0.14 + strobeWave * 0.16);

  // Chamber pressure telemetry (101.3 kPa -> 148.6 kPa peak -> 101.3 kPa equalized)
  const pressureKpa = (101.3 + Math.sin(progress * Math.PI) * 47.3).toFixed(1);

  const stageLabel =
    progress < 0.34
      ? direction === 'to_outpost'
        ? 'AIRLOCK SEALED · PRESSURIZING'
        : 'TRANSPORT DOCKED · SEALING BULKHEAD'
      : progress < 0.66
        ? direction === 'to_outpost'
          ? 'DECONTAMINATION CYCLE · TRANSIT TO OUTPOST'
          : 'BIO-SCRUB CYCLE · RETURNING TO HIDEOUT'
        : direction === 'to_outpost'
          ? 'EQUALIZED · OPENING QUARANTINE RAMP'
          : 'EQUALIZED · UNSEALING HIDEOUT AIRLOCK';

  const mistDriftX = (progress - 0.5) * 46;
  const mistDriftY = (progress - 0.35) * 28;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 overflow-hidden select-none"
      aria-live="polite"
      role="status"
    >
      {/* Solid opaque decontamination base backing at peak occlusion so scene swap never flashes */}
      <div
        className="absolute inset-0 bg-[#14171a]"
        style={{ opacity: Math.min(1, mistOpacity * 1.06) }}
      />

      {/* Dense white/amber overhead decontamination vapor billows (pure compositor transform/opacity) */}
      <div
        className="absolute -inset-16"
        style={{
          opacity: mistOpacity * 0.92,
          transform: `translate3d(${mistDriftX}px, ${mistDriftY}px, 0) scale(${1 + mistOpacity * 0.08})`,
          background:
            'radial-gradient(ellipse 80% 65% at 32% 28%, rgba(236, 232, 220, 0.92) 0%, rgba(196, 178, 148, 0.72) 45%, rgba(28, 30, 34, 0.94) 100%)',
        }}
      />
      <div
        className="absolute -inset-16"
        style={{
          opacity: mistOpacity * 0.78,
          transform: `translate3d(${-mistDriftX * 0.85}px, ${-mistDriftY * 0.6}px, 0) scale(${1.06 - progress * 0.06})`,
          background:
            'radial-gradient(ellipse 75% 60% at 72% 68%, rgba(224, 214, 194, 0.88) 0%, rgba(154, 118, 72, 0.48) 52%, rgba(16, 18, 22, 0.95) 100%)',
        }}
      />

      {/* Emergency crimson/amber airlock strobe wash */}
      <div
        className="absolute inset-0"
        style={{
          opacity: strobeAlpha,
          background:
            strobeWave > 0.5
              ? 'radial-gradient(circle at 50% 18%, rgba(220, 38, 38, 0.78), rgba(127, 29, 29, 0.25) 62%, transparent 100%)'
              : 'radial-gradient(circle at 50% 18%, rgba(245, 158, 11, 0.72), rgba(146, 64, 14, 0.22) 62%, transparent 100%)',
        }}
      />

      {/* Subtle heavy bulkhead shutter edges */}
      <div
        className="absolute inset-x-0 top-0 h-14 bg-[#090b0d]"
        style={{
          opacity: shutterClose * 0.94,
          transform: `translate3d(0, ${(shutterClose - 1) * 100}%, 0)`,
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-14 bg-[#090b0d]"
        style={{
          opacity: shutterClose * 0.94,
          transform: `translate3d(0, ${(1 - shutterClose) * 100}%, 0)`,
        }}
      />

      {/* Minimal grounded bodycam chamber pressurization readout */}
      <div
        className="absolute inset-x-0 bottom-10 flex flex-col items-center gap-2 px-6"
        style={{ opacity: Math.min(1, mistOpacity * 1.15) }}
      >
        <div className="flex items-center gap-4 border border-amber-500/35 bg-[#0b0d10]/92 px-5 py-2.5 text-xs tracking-wider text-neutral-100">
          <span className="font-display font-semibold uppercase text-amber-300">
            {stageLabel}
          </span>
          <span className="text-neutral-600" aria-hidden="true">
            |
          </span>
          <span className="font-mono-tabular text-neutral-300">{pressureKpa} kPa</span>
        </div>
        <div className="h-1 w-64 overflow-hidden bg-white/12">
          <div
            className="h-full bg-amber-500"
            style={{ transform: `scaleX(${progress})`, transformOrigin: 'left center' }}
          />
        </div>
      </div>
    </div>
  );
};
