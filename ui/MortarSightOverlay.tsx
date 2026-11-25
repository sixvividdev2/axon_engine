import React from 'react';
import { MortarPlayerHudTelemetry } from '../combat/MortarEmplacementSystem';

interface MortarSightOverlayProps {
  mortar: MortarPlayerHudTelemetry | null;
  pdaOpen?: boolean;
}

/**
 * Diegetic 81mm Mortar Mil-Sim Optical Sight & Laying Telemetry.
 * - Optical Sight Mode ([RMB]): Circular elbow collimator eyepiece over the live 3D aiming stakes,
 *   etched NATO mil stadia, live cross-level spirit bubble, aiming-stake alignment chevron,
 *   and deflection/elevation mil drums.
 * - Over-Tube Mode: Unobstructed 3D viewport with a slim bottom mechanical instrument strip.
 * Zero backdrop-filter over WebGL, zero pulsing dots, strict tabular numerals.
 */
export const MortarSightOverlay: React.FC<MortarSightOverlayProps> = ({ mortar, pdaOpen }) => {
  if (!mortar) return null;

  const bubbleOffsetX = Math.max(-1, Math.min(1, mortar.bubbleErrorX)) * 34;
  const bubbleOffsetY = Math.max(-1, Math.min(1, mortar.bubbleErrorY)) * 34;
  const stakeOffsetPx = Math.max(-90, Math.min(90, mortar.stakeDriftMils * 1.45));
  const reloadPct = Math.round(Math.max(0, Math.min(1, mortar.reloadProgress01)) * 100);

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none">
      {/* Optical Elbow Collimator Eyepiece ([RMB]) */}
      {mortar.opticalSightActive && !pdaOpen && (
        <div className="absolute inset-0 flex items-center justify-center">
          {/* Dark optical tube surround using crisp radial gradient mask (no backdrop-filter) */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 31%, rgba(6,9,12,0.88) 36%, rgba(4,6,8,0.97) 58%)',
            }}
          />

          {/* Collimator Reticle & Etched NATO Mil Stadia */}
          <div className="relative flex h-[62vmin] w-[62vmin] items-center justify-center rounded-full border-2 border-neutral-800">
            <svg
              viewBox="-160 -160 320 320"
              className="h-full w-full"
              aria-hidden="true"
            >
              {/* Outer etched bezel ticks */}
              <circle cx="0" cy="0" r="154" fill="none" stroke="rgba(226,232,240,0.22)" strokeWidth="1" />
              {/* Primary deflection & elevation stadia hairlines */}
              <line x1="-140" y1="0" x2="-16" y2="0" stroke="rgba(235,242,248,0.78)" strokeWidth="1.2" />
              <line x1="16" y1="0" x2="140" y2="0" stroke="rgba(235,242,248,0.78)" strokeWidth="1.2" />
              <line x1="0" y1="-140" x2="0" y2="-16" stroke="rgba(235,242,248,0.78)" strokeWidth="1.2" />
              <line x1="0" y1="16" x2="0" y2="140" stroke="rgba(235,242,248,0.78)" strokeWidth="1.2" />

              {/* Center aiming-stake vertical index chevron */}
              <path
                d="M -6 10 L 0 0 L 6 10"
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1.6"
              />

              {/* Horizontal mil graduation hash ticks (every 20 mils) */}
              {[-100, -80, -60, -40, -20, 20, 40, 60, 80, 100].map((x) => (
                <line
                  key={`hx_${x}`}
                  x1={x}
                  y1={x % 40 === 0 ? -7 : -4}
                  x2={x}
                  y2={x % 40 === 0 ? 7 : 4}
                  stroke="rgba(235,242,248,0.72)"
                  strokeWidth="1.1"
                />
              ))}

              {/* Vertical elevation mil hash ticks */}
              {[-100, -80, -60, -40, -20, 20, 40, 60, 80, 100].map((y) => (
                <line
                  key={`vy_${y}`}
                  x1={y % 40 === 0 ? -7 : -4}
                  y1={y}
                  x2={y % 40 === 0 ? 7 : 4}
                  y2={y}
                  stroke="rgba(235,242,248,0.72)"
                  strokeWidth="1.1"
                />
              ))}

              {/* Live Aiming-Stake Reference Bar (shifts horizontally when baseplate recoil disturbs lay) */}
              <g transform={`translate(${stakeOffsetPx.toFixed(1)}, 0)`}>
                <line
                  x1="0"
                  y1="-54"
                  x2="0"
                  y2="-24"
                  stroke={Math.abs(mortar.stakeDriftMils) <= 4 ? '#34d399' : '#f97316'}
                  strokeWidth="3.2"
                />
                <line
                  x1="0"
                  y1="-54"
                  x2="0"
                  y2="-44"
                  stroke="#f8fafc"
                  strokeWidth="3.2"
                />
              </g>
            </svg>

            {/* Top Optical Drum Readout */}
            <div className="absolute top-6 flex items-center gap-4 border border-neutral-700/80 bg-neutral-950/90 px-3 py-1 font-mono-tabular text-[11px] tracking-wider text-neutral-100">
              <span>
                DEF <strong className="text-amber-300">{String(mortar.deflectionMils).padStart(4, '0')}</strong> MIL
              </span>
              <span className="text-neutral-600">|</span>
              <span>
                ELV <strong className="text-sky-300">{String(mortar.elevationMils).padStart(4, '0')}</strong> MIL ({mortar.elevationDeg.toFixed(1)}&deg;)
              </span>
            </div>

            {/* Bottom Cross-Level Spirit Bubble Vial inside Eyepiece */}
            <div className="absolute bottom-7 flex flex-col items-center gap-1.5">
              <div className="flex items-center gap-3">
                {/* Horizontal Cross-Level Vial */}
                <div className="relative h-4 w-24 overflow-hidden border border-neutral-600 bg-emerald-950/85">
                  <div className="absolute inset-y-0 left-1/2 w-[1px] -translate-x-2 bg-neutral-200/75" />
                  <div className="absolute inset-y-0 left-1/2 w-[1px] translate-x-2 bg-neutral-200/75" />
                  <div
                    className={`absolute top-0.5 h-2.5 w-3.5 rounded-full border ${
                      mortar.isLevelSettled
                        ? 'border-emerald-200 bg-emerald-300/85'
                        : 'border-amber-200 bg-amber-400/85'
                    }`}
                    style={{
                      left: `calc(50% - 7px + ${bubbleOffsetX.toFixed(1)}px)`,
                    }}
                  />
                </div>

                {/* Elevation Level Vial */}
                <div className="relative h-4 w-24 overflow-hidden border border-neutral-600 bg-emerald-950/85">
                  <div className="absolute inset-y-0 left-1/2 w-[1px] -translate-x-2 bg-neutral-200/75" />
                  <div className="absolute inset-y-0 left-1/2 w-[1px] translate-x-2 bg-neutral-200/75" />
                  <div
                    className={`absolute top-0.5 h-2.5 w-3.5 rounded-full border ${
                      mortar.isLevelSettled
                        ? 'border-emerald-200 bg-emerald-300/85'
                        : 'border-amber-200 bg-amber-400/85'
                    }`}
                    style={{
                      left: `calc(50% - 7px + ${bubbleOffsetY.toFixed(1)}px)`,
                    }}
                  />
                </div>
              </div>
              <div className="font-mono-tabular text-[10px] uppercase tracking-widest text-neutral-300">
                {mortar.isLevelSettled && Math.abs(mortar.stakeDriftMils) <= 4
                  ? 'BUBBLE LEVEL · STAKES INDEXED'
                  : `RE-LAY REQUIRED · STAKE ${mortar.stakeDriftMils >= 0 ? '+' : ''}${mortar.stakeDriftMils} MIL · HOLD [R]`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Slim Bottom 81mm Mortar Laying Instrument Bar (Always visible while seated) */}
      <div className="absolute inset-x-0 bottom-5 flex justify-center px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border border-neutral-700/90 bg-neutral-950/92 px-4 py-2 font-mono-tabular text-xs text-neutral-100 shadow-xl">
          <div className="flex items-center gap-2 border-r border-neutral-800 pr-3">
            <span className="font-bold uppercase tracking-wider text-amber-400">
              81MM {mortar.isCapturedEnemyPit ? 'CAPTURED' : mortar.sourceType}
            </span>
            <span className="text-[11px] text-neutral-400">
              {mortar.aiLoaderAlive ? 'AI LOADER 2.4S' : 'SOLO 4.2S'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div>
              <span className="text-[10px] uppercase text-neutral-400">DEF </span>
              <span className="font-semibold text-amber-300">
                {String(mortar.deflectionMils).padStart(4, '0')}
              </span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-neutral-400">ELV </span>
              <span className="font-semibold text-sky-300">
                {mortar.elevationDeg.toFixed(1)}&deg;
              </span>
              <span className="ml-1 text-[10px] text-neutral-400">
                ({mortar.elevationMils}m)
              </span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-neutral-400">EST RNG </span>
              <span className="font-semibold text-neutral-100">{mortar.estimatedRangeM}m</span>
              <span className="ml-1 text-[10px] text-neutral-400">
                TOF {mortar.estimatedFlightSec.toFixed(1)}s
              </span>
            </div>
          </div>

          {/* Propellant Charge Rings 1–4 */}
          <div className="flex items-center gap-1 border-l border-neutral-800 pl-3">
            <span className="mr-1 text-[10px] uppercase text-neutral-400">CHG</span>
            {([1, 2, 3, 4] as const).map((ch) => (
              <span
                key={ch}
                className={`inline-flex h-5 w-5 items-center justify-center border text-[11px] font-bold ${
                  mortar.chargeLevel === ch
                    ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                    : ch < mortar.chargeLevel
                      ? 'border-neutral-600 bg-neutral-800 text-neutral-300'
                      : 'border-neutral-800 bg-neutral-950 text-neutral-600'
                }`}
              >
                {ch}
              </span>
            ))}
          </div>

          {/* Spirit Level & Bore Status */}
          <div className="flex items-center gap-2 border-l border-neutral-800 pl-3">
            <span
              className={`text-[11px] font-semibold uppercase ${
                mortar.isLevelSettled ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {mortar.isLevelSettled ? 'LEVEL OK' : 'OFF-LEVEL [R]'}
            </span>
            <div className="h-2 w-16 overflow-hidden border border-neutral-700 bg-neutral-900">
              <div
                className={`h-full transition-all duration-75 ${
                  mortar.canFire ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                style={{ width: `${reloadPct}%` }}
              />
            </div>
            <span className="text-[11px] font-semibold uppercase text-neutral-200">
              {mortar.canFire ? 'READY [LMB]' : `LOAD ${reloadPct}%`}
            </span>
          </div>

          {/* Compact Key Legend */}
          <div className="hidden border-l border-neutral-800 pl-3 text-[10px] uppercase tracking-wide text-neutral-400 lg:block">
            WASD/Drag Lay · 1-4/Q-E Chg · RMB Sight · R Level · M Firing Table · F Exit
          </div>
        </div>
      </div>
    </div>
  );
};
