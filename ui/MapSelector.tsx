import React from 'react';
import { InfectionMapRecord } from '../engine/persistence/SaveManager';
import { IMapDefinition } from '../maps/types';

interface MapSelectorProps {
  maps: readonly IMapDefinition[];
  selectedMapId: string;
  onSelectMap: (mapId: string) => void;
  theme: 'tactical' | 'infection';
  infectionRecords?: Record<string, InfectionMapRecord>;
}

const MapPreviewArtwork: React.FC<{
  style: IMapDefinition['previewStyle'];
  theme: 'tactical' | 'infection';
  locked: boolean;
}> = ({ style, theme, locked }) => {
  if (style === 'cqb_pripyat') {
    return (
      <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="pripyatBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1b2b2c" />
            <stop offset="100%" stopColor="#0d1314" />
          </linearGradient>
        </defs>
        <rect width="320" height="130" fill="url(#pripyatBg)" />
        {/* U-shaped Soviet courtyard microdistrict + rusted vehicles & overgrown birch */}
        <g stroke="#5c8a85" strokeWidth="1.5" fill="none" opacity="0.82">
          <rect x="24" y="14" width="272" height="96" />
          <rect x="24" y="14" width="68" height="96" fill="#233738" opacity="0.65" />
          <rect x="228" y="14" width="68" height="96" fill="#233738" opacity="0.65" />
          <rect x="92" y="14" width="136" height="32" fill="#283d3d" opacity="0.65" />
        </g>
        {/* Overgrown courtyard trees & rusted cars */}
        <g fill="#4f6d4a" opacity="0.85">
          <circle cx="132" cy="74" r="9" />
          <circle cx="188" cy="70" r="8" />
          <circle cx="158" cy="86" r="7" />
        </g>
        <g fill="#8c5332" stroke="#d9a05b" strokeWidth="0.8">
          <rect x="114" y="56" width="14" height="7" transform="rotate(-14 121 59)" />
          <rect x="192" y="88" width="16" height="7" transform="rotate(11 200 91)" />
        </g>
        <text
          x="32"
          y="122"
          fill="#8cc4bd"
          fontSize="8.5"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.4"
        >
          PRIPYAT MICRODISTRICT · TEAL-AMBER DECAY
        </text>
      </svg>
    );
  }

  if (style === 'forest_compound') {
    return (
      <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="timberBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1b2621" />
            <stop offset="100%" stopColor="#0d1310" />
          </linearGradient>
        </defs>
        <rect width="320" height="130" fill="url(#timberBg)" />
        {/* River winding across valley */}
        <path
          d="M0 94 Q80 78 156 96 T320 82"
          fill="none"
          stroke="#3b6e82"
          strokeWidth="10"
          opacity="0.65"
        />
        {/* Airstrip with parallel edge lights */}
        <rect x="150" y="20" width="138" height="22" fill="#252c2b" stroke="#6c7b77" strokeWidth="1" />
        <g fill="#f5b942">
          <circle cx="160" cy="22" r="1.4" />
          <circle cx="185" cy="22" r="1.4" />
          <circle cx="210" cy="22" r="1.4" />
          <circle cx="235" cy="22" r="1.4" />
          <circle cx="260" cy="22" r="1.4" />
          <circle cx="160" cy="40" r="1.4" />
          <circle cx="185" cy="40" r="1.4" />
          <circle cx="210" cy="40" r="1.4" />
          <circle cx="235" cy="40" r="1.4" />
          <circle cx="260" cy="40" r="1.4" />
        </g>
        {/* Military base, helipad, radar, villages */}
        <g fill="#4f6d58" stroke="#b9d6be" strokeWidth="1">
          <rect x="42" y="26" width="24" height="16" />
          <rect x="74" y="32" width="22" height="15" />
          <rect x="164" y="54" width="32" height="16" />
          <rect x="204" y="54" width="32" height="16" />
          <circle cx="256" cy="64" r="10" fill="#2e3836" stroke="#f5c878" />
        </g>
        <text
          x="26"
          y="122"
          fill="#9abca2"
          fontSize="8.5"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.3"
        >
          VALLEY · AIRSTRIP · HELIPAD · RADAR · BUNKER
        </text>
      </svg>
    );
  }

  if (style === 'korsakov_substation') {
    return (
      <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="korsakovBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1c2229" />
            <stop offset="100%" stopColor="#0b0f14" />
          </linearGradient>
        </defs>
        <rect width="320" height="130" fill="url(#korsakovBg)" />
        {/* Industrial slate turbine hall + transformer bays */}
        <g stroke="#64748b" strokeWidth="1.4" fill="none">
          <rect x="24" y="18" width="170" height="84" fill="#161c24" />
          <rect x="204" y="18" width="92" height="84" strokeDasharray="6 4" />
        </g>
        {/* Three colossal turbine drums + sodium-vapor glow */}
        <g fill="#26303d" stroke="#f59e0b" strokeWidth="1.2">
          <circle cx="62" cy="60" r="16" />
          <circle cx="108" cy="60" r="16" />
          <circle cx="154" cy="60" r="16" />
        </g>
        {/* Blue emergency exit beacons */}
        <g fill="#38bdf8">
          <rect x="24" y="54" width="4" height="12" />
          <rect x="190" y="24" width="4" height="12" />
          <rect x="190" y="84" width="4" height="12" />
        </g>
        {/* Outdoor transformer gantries */}
        <g stroke="#94a3b8" strokeWidth="1.2">
          <rect x="220" y="30" width="24" height="18" fill="#1e293b" />
          <rect x="256" y="30" width="24" height="18" fill="#1e293b" />
          <rect x="220" y="70" width="60" height="20" fill="#1e293b" />
        </g>
        <text
          x="26"
          y="122"
          fill="#93c5fd"
          fontSize="8.5"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.3"
        >
          INDUSTRIAL SLATE · SODIUM-VAPOR · BLUE EXITS
        </text>
      </svg>
    );
  }

  if (style === 'kino_theater') {
    return (
      <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="kinoGlow" cx="50%" cy="22%" r="72%">
            <stop offset="0%" stopColor="#1e4a3d" />
            <stop offset="65%" stopColor="#0f1f1c" />
            <stop offset="100%" stopColor="#070d0d" />
          </radialGradient>
        </defs>
        <rect width="320" height="130" fill="url(#kinoGlow)" />
        {/* Art-Deco Noir Emerald & Brass Theater Schematic */}
        <g stroke="#b89448" strokeWidth="1.4" fill="none" opacity="0.88">
          <rect x="34" y="16" width="252" height="94" stroke="#356859" />
          <rect x="86" y="16" width="148" height="62" />
          <rect x="86" y="78" width="148" height="32" stroke="#d4af5f" />
          <rect x="102" y="20" width="116" height="15" fill="#18382f" stroke="#d4af5f" />
        </g>
        <g stroke="#34725f" strokeWidth="2.5" opacity="0.85">
          <line x1="108" y1="45" x2="148" y2="45" />
          <line x1="172" y1="45" x2="212" y2="45" />
          <line x1="108" y1="55" x2="148" y2="55" />
          <line x1="172" y1="55" x2="212" y2="55" />
          <line x1="108" y1="65" x2="148" y2="65" />
          <line x1="172" y1="65" x2="212" y2="65" />
        </g>
        {/* Warm amber projector cone beam */}
        <polygon points="154,78 166,78 194,24 126,24" fill="#f5b942" opacity="0.16" />
        <text
          x="38"
          y="122"
          fill="#a7d9c6"
          fontSize="8.5"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.3"
        >
          ART-DECO NOIR · STAGE · PROJECTION BOOTH
        </text>
      </svg>
    );
  }

  // Locked coming-soon placeholder art
  return (
    <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
      <rect width="320" height="130" fill={theme === 'infection' ? '#0e0708' : '#0f1216'} />
      <g stroke={theme === 'infection' ? '#4a1b20' : '#2a323c'} strokeWidth="1" opacity="0.65">
        <line x1="0" y1="0" x2="320" y2="130" />
        <line x1="320" y1="0" x2="0" y2="130" />
        <rect x="28" y="20" width="264" height="90" fill="none" strokeDasharray="6 6" />
      </g>
      <text
        x="160"
        y="69"
        textAnchor="middle"
        fill={locked ? '#8a555a' : '#8a94a0'}
        fontSize="11"
        fontFamily="IBM Plex Mono, monospace"
        letterSpacing="2.2"
      >
        SECTOR LOCKED
      </text>
    </svg>
  );
};

/**
 * Shared reusable MapSelector component used by both BATTLE (theme="tactical")
 * and INFECTION (theme="infection") screens.
 */
export const MapSelector: React.FC<MapSelectorProps> = ({
  maps,
  selectedMapId,
  onSelectMap,
  theme,
  infectionRecords,
}) => {
  const isInfection = theme === 'infection';

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {maps.map((map) => {
        const locked = map.status === 'coming_soon';
        const selected = !locked && selectedMapId === map.id;
        const record = isInfection ? infectionRecords?.[map.id] : undefined;

        const borderClass = locked
          ? isInfection
            ? 'border-red-950/60 bg-neutral-950/65 opacity-60 cursor-not-allowed'
            : 'border-neutral-800/70 bg-neutral-950/65 opacity-60 cursor-not-allowed'
          : selected
            ? isInfection
              ? 'border-red-500 bg-red-950/35 cursor-pointer'
              : 'border-amber-400 bg-neutral-900/95 cursor-pointer'
            : isInfection
              ? 'border-red-950/80 bg-neutral-950/85 hover:border-red-700/80 cursor-pointer'
              : 'border-neutral-800 bg-neutral-950/85 hover:border-neutral-600 cursor-pointer';

        return (
          <button
            key={map.id}
            type="button"
            disabled={locked}
            onClick={() => {
              if (!locked) onSelectMap(map.id);
            }}
            className={`group flex flex-col overflow-hidden border text-left transition-colors ${borderClass}`}
          >
            <div className="relative h-28 w-full overflow-hidden border-b border-neutral-800/80">
              <MapPreviewArtwork style={map.previewStyle} theme={theme} locked={locked} />
              {selected && (
                <div
                  className={`absolute top-2 right-2 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-widest ${
                    isInfection
                      ? 'bg-red-600 text-neutral-50'
                      : 'bg-amber-400 text-neutral-950'
                  }`}
                >
                  Selected
                </div>
              )}
            </div>

            <div className="flex flex-1 flex-col justify-between p-3.5">
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3
                    className={`font-display text-lg font-semibold uppercase tracking-wide ${
                      locked
                        ? 'text-neutral-500'
                        : isInfection
                          ? 'text-red-50'
                          : 'text-neutral-50'
                    }`}
                  >
                    {map.name}
                  </h3>
                </div>

                <div
                  className={`mt-0.5 font-mono-tabular text-[10px] uppercase tracking-wider ${
                    locked
                      ? 'text-neutral-500'
                      : isInfection
                        ? 'text-red-400/90'
                        : 'text-amber-300/90'
                  }`}
                >
                  {map.environmentTags.join(' · ')}
                </div>

                <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                  {map.description}
                </p>
              </div>

              {isInfection && !locked && (
                <div className="mt-3 flex items-center justify-between border-t border-red-950/70 pt-2 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  <span>Personal Record</span>
                  {record ? (
                    <span className="text-red-300">
                      Round {record.highestRound} · {record.bestKills} Kills
                    </span>
                  ) : (
                    <span className="text-neutral-500">No Runs Logged</span>
                  )}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
};
