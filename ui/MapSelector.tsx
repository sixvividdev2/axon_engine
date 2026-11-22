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
            <stop offset="0%" stopColor="#172028" />
            <stop offset="100%" stopColor="#0c1014" />
          </linearGradient>
        </defs>
        <rect width="320" height="130" fill="url(#pripyatBg)" />
        {/* Brutalist schematic floorplan & atrium */}
        <g stroke="#4b647a" strokeWidth="1.5" fill="none" opacity="0.72">
          <rect x="26" y="16" width="268" height="98" />
          <rect x="112" y="16" width="96" height="98" stroke="#8cb6d6" />
          <line x1="26" y1="65" x2="112" y2="65" />
          <line x1="208" y1="65" x2="294" y2="65" />
          {/* Stairwell treads */}
          <path d="M126 30 H148 M126 36 H148 M126 42 H148 M126 48 H148" stroke="#d9a05b" />
          <path d="M172 82 H194 M172 88 H194 M172 94 H194 M172 100 H194" stroke="#d9a05b" />
        </g>
        {/* Pillars */}
        <g fill="#7ba2bf" opacity="0.8">
          <rect x="128" y="61" width="7" height="7" />
          <rect x="185" y="61" width="7" height="7" />
          <rect x="64" y="37" width="6" height="6" />
          <rect x="248" y="85" width="6" height="6" />
        </g>
        <text
          x="34"
          y="106"
          fill="#9db8cc"
          fontSize="9"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.6"
        >
          SECTOR 04 // 2-FLOOR ATRIUM
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
        {/* Rolling contour rings */}
        <g stroke="#3e5948" strokeWidth="1" fill="none" opacity="0.55">
          <ellipse cx="160" cy="65" rx="145" ry="54" />
          <ellipse cx="160" cy="65" rx="112" ry="42" />
        </g>
        {/* Compound perimeter wall */}
        <rect
          x="76"
          y="26"
          width="168"
          height="78"
          fill="none"
          stroke="#7aa384"
          strokeWidth="1.6"
          strokeDasharray="18 6"
        />
        {/* 3 Wooden Cabins + Watchtower */}
        <g fill="#4f6d58" stroke="#b9d6be" strokeWidth="1">
          <rect x="92" y="38" width="38" height="22" />
          <rect x="186" y="36" width="42" height="24" />
          <rect x="128" y="72" width="46" height="22" />
          <rect x="206" y="78" width="14" height="14" fill="#d97736" stroke="#f5c878" />
        </g>
        {/* Pine tree clusters */}
        <g fill="#2d4c36" opacity="0.9">
          <circle cx="38" cy="34" r="9" />
          <circle cx="54" cy="48" r="7" />
          <circle cx="42" cy="88" r="10" />
          <circle cx="276" cy="36" r="10" />
          <circle cx="288" cy="84" r="9" />
          <circle cx="264" cy="96" r="7" />
        </g>
        <text
          x="34"
          y="108"
          fill="#9abca2"
          fontSize="9"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.6"
        >
          PERIMETER // 3 CABINS · WATCHTOWER
        </text>
      </svg>
    );
  }

  if (style === 'kino_theater') {
    return (
      <svg viewBox="0 0 320 130" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="kinoGlow" cx="50%" cy="22%" r="72%">
            <stop offset="0%" stopColor="#5c161b" />
            <stop offset="65%" stopColor="#1b090c" />
            <stop offset="100%" stopColor="#090405" />
          </radialGradient>
        </defs>
        <rect width="320" height="130" fill="url(#kinoGlow)" />
        {/* Theater auditorium schematic: Stage -> Sloped Rows -> Lobby -> Projector */}
        <g stroke="#b8383f" strokeWidth="1.4" fill="none" opacity="0.85">
          {/* Outer wings */}
          <rect x="34" y="16" width="252" height="98" stroke="#6e2228" />
          {/* Main auditorium */}
          <rect x="86" y="16" width="148" height="66" />
          {/* Lobby */}
          <rect x="86" y="82" width="148" height="32" stroke="#d9a05b" />
          {/* Stage proscenium */}
          <rect x="102" y="20" width="116" height="16" fill="#3a1116" stroke="#e05252" />
        </g>
        {/* Auditorium seat rows */}
        <g stroke="#99282f" strokeWidth="2.5" opacity="0.8">
          <line x1="108" y1="46" x2="148" y2="46" />
          <line x1="172" y1="46" x2="212" y2="46" />
          <line x1="108" y1="56" x2="148" y2="56" />
          <line x1="172" y1="56" x2="212" y2="56" />
          <line x1="108" y1="66" x2="148" y2="66" />
          <line x1="172" y1="66" x2="212" y2="66" />
        </g>
        {/* Projector cone beam */}
        <polygon points="154,82 166,82 194,24 126,24" fill="#f5b942" opacity="0.11" />
        <text
          x="42"
          y="108"
          fill="#d9898d"
          fontSize="9"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1.6"
        >
          5 ZONES // LOBBY · STAGE · BOOTH
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
