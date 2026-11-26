import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Crosshair, Radio, Volume2 } from 'lucide-react';
import {
  CinematicDirector,
  CinematicSnapshot,
} from './CinematicDirector';
import { CinematicSequenceId } from './cinematicVoiceManifest';

export interface CinematicOverlayProps {
  sequence: CinematicSequenceId;
  onMidpointSwap?: () => void;
  onComplete: () => void;
}

/**
 * Minimal, zero-clutter AAA Cinematic Viewport Overlay.
 * - Clean cinema view on aerial sweeps: zero center reticles, zero red dots, zero corner telemetry.
 * - Strictly zero backdrop-filter over WebGL, zero static pill badges, zero pulsing dots.
 * - [Space] toggles Pause / Play; Hold [Enter] (1.2s) skips smoothly.
 * - Shows a discreet non-blocking audio unlock button only if the browser blocked autoplay.
 */
export const CinematicOverlay: React.FC<CinematicOverlayProps> = ({
  sequence,
  onMidpointSwap,
  onComplete,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const directorRef = useRef<CinematicDirector | null>(null);
  const onMidpointSwapRef = useRef(onMidpointSwap);
  onMidpointSwapRef.current = onMidpointSwap;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const [snapshot, setSnapshot] = useState<CinematicSnapshot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (document.pointerLockElement) {
      document.exitPointerLock();
    }

    const director = new CinematicDirector(el, sequence, {
      onMidpointSwap: () => onMidpointSwapRef.current?.(),
      onComplete: () => onCompleteRef.current(),
    });
    directorRef.current = director;
    const unsub = director.subscribe((next) => setSnapshot(next));

    return () => {
      unsub();
      director.dispose();
      directorRef.current = null;
    };
  }, [sequence]);

  const showLetterbox = snapshot ? !snapshot.mouseLookActive : true;
  const isGunCam = snapshot?.cameraMode === 'gun_cam';
  const isCleanCinema = snapshot?.cameraMode === 'drone_aerial';

  return (
    <div
      className="fixed inset-0 z-50 select-none overflow-hidden bg-black"
      onPointerDown={() => directorRef.current?.unlockAudio()}
    >
      {/* Live 3D Cinematic Canvas */}
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {/* Subtle Cinematic Vignette (no blur) */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 56%, rgba(0,0,0,0.52) 100%)',
        }}
      />

      {/* Widescreen Letterbox Bars (auto-retracted during live FP Mouse-Look) */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 bg-black transition-[height] duration-300"
        style={{ height: showLetterbox ? '52px' : '0px' }}
      />
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 bg-black transition-[height] duration-300"
        style={{ height: showLetterbox ? '52px' : '0px' }}
      />

      {/* Minimal Top-Left Feed Label (hidden completely during clean aerial cinema sweeps) */}
      {snapshot && !isCleanCinema && snapshot.feedLabel && (
        <div className="pointer-events-none fixed left-6 top-16 flex flex-col gap-0.5 font-mono-tabular">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300">
            {isGunCam ? (
              <Crosshair className="h-3.5 w-3.5 text-amber-400" />
            ) : (
              <Radio className="h-3.5 w-3.5 text-amber-400" />
            )}
            <span>{snapshot.feedLabel}</span>
          </div>
          {snapshot.locationLabel && (
            <div className="text-xs font-medium tracking-wider text-neutral-300">
              {snapshot.locationLabel}
            </div>
          )}
          {snapshot.killConfirmedFlash && (
            <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-amber-300">
              HOSTILE NEUTRALIZED ({snapshot.killCount})
            </div>
          )}
        </div>
      )}

      {/* Synchronized Narrative Voiceover Captions (Bottom Center) */}
      {snapshot?.caption && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 w-full max-w-2xl -translate-x-1/2 px-6 text-center">
          <div className="inline-block border-l-2 border-amber-400 bg-[#07090c]/88 px-5 py-3 text-left">
            <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300">
              {snapshot.caption.speaker}
            </div>
            <p className="mt-1 text-sm leading-snug font-medium text-neutral-100">
              {snapshot.caption.text}
            </p>
          </div>
        </div>
      )}

      {/* Centered Pause Indicator when [Space] pauses playback */}
      {snapshot?.paused && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/55">
          <div className="flex flex-col items-center gap-3 border border-white/16 bg-[#0d1015] px-8 py-6 text-center">
            <Pause className="h-6 w-6 text-amber-400" />
            <div className="font-display text-xl font-bold uppercase tracking-widest text-neutral-50">
              Cinematic Paused
            </div>
            <div className="font-mono-tabular text-xs text-neutral-400">
              Press [Space] to Resume · Hold [Enter] to Skip
            </div>
            <button
              type="button"
              onClick={() => directorRef.current?.togglePause()}
              className="mt-1 flex cursor-pointer items-center gap-2 bg-amber-500 px-5 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Resume</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom-Right Minimal Controls: Optional Audio Unlock + [Space] Pause/Play + Hold [Enter] Skip */}
      {snapshot && (
        <div className="pointer-events-auto fixed bottom-3.5 right-6 flex items-center gap-3 font-mono-tabular text-[11px] text-neutral-300">
          {snapshot.audioBlocked && !snapshot.paused && (
            <button
              type="button"
              onClick={() => directorRef.current?.unlockAudio()}
              className="flex cursor-pointer items-center gap-1.5 border border-amber-400/50 bg-[#0d1015]/92 px-2.5 py-1 text-amber-300 transition-colors hover:border-amber-300 hover:text-white"
            >
              <Volume2 className="h-3.5 w-3.5" />
              <span>Click to Enable Audio</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => directorRef.current?.togglePause()}
            className="flex cursor-pointer items-center gap-1.5 border border-white/14 bg-[#0d1015]/92 px-2.5 py-1 text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-white"
          >
            {snapshot.paused ? (
              <Play className="h-3 w-3 text-amber-400" />
            ) : (
              <Pause className="h-3 w-3 text-amber-400" />
            )}
            <span>[Space] {snapshot.paused ? 'Play' : 'Pause'}</span>
          </button>

          <button
            type="button"
            onMouseDown={() => directorRef.current?.setEnterHeld(true)}
            onMouseUp={() => directorRef.current?.setEnterHeld(false)}
            onMouseLeave={() => directorRef.current?.setEnterHeld(false)}
            className="flex cursor-pointer flex-col gap-1 border border-white/14 bg-[#0d1015]/92 px-3 py-1 text-left text-neutral-200 transition-colors hover:border-amber-400/60"
          >
            <span>Hold [Enter] Skip</span>
            <div className="h-1 w-28 overflow-hidden bg-white/15">
              <div
                className="h-full bg-amber-400"
                style={{
                  width: `${Math.min(100, Math.round(snapshot.skipHoldProgress01 * 100))}%`,
                }}
              />
            </div>
          </button>
        </div>
      )}

      {/* Black Fade Scrim for Clean Act & Midpoint Scene Swaps */}
      <div
        className="pointer-events-none fixed inset-0 bg-black"
        style={{ opacity: snapshot?.fadeOpacity01 ?? 0 }}
      />
    </div>
  );
};
