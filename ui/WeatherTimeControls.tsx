import React from 'react';
import { isInfectionMapId, TimeOfDayStartSetting, WeatherPresetId } from '../data/multiplayer';

export const WEATHER_PRESET_OPTIONS: ReadonlyArray<{ id: WeatherPresetId; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'sunny', label: 'Sunny' },
  { id: 'clear', label: 'Clear' },
  { id: 'overcast', label: 'Overcast' },
  { id: 'rainy', label: 'Rainy' },
  { id: 'stormy', label: 'Stormy' },
];

export const TIME_PRESET_STOPS: ReadonlyArray<{ label: string; hours: number }> = [
  { label: '00:00', hours: 0 },
  { label: '05:30', hours: 5.5 },
  { label: '12:00', hours: 12 },
  { label: '18:30', hours: 18.5 },
];

export function formatTimeOfDayLabel(setting: TimeOfDayStartSetting | undefined): string {
  if (setting === undefined || setting === 'auto') return 'Auto (Random)';
  const wrapped = ((setting % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.round((wrapped - h) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatWeatherPresetLabel(preset: WeatherPresetId | undefined): string {
  const found = WEATHER_PRESET_OPTIONS.find((w) => w.id === (preset ?? 'auto'));
  return found ? found.label : 'Auto';
}

interface WeatherTimeControlsProps {
  mapId: string;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
  editable?: boolean;
  accent?: 'amber' | 'red' | 'sky';
  compact?: boolean;
  onChangeWeather?: (weather: WeatherPresetId) => void;
  onChangeTimeOfDay?: (time: TimeOfDayStartSetting) => void;
}

export const WeatherTimeControls: React.FC<WeatherTimeControlsProps> = ({
  mapId,
  weatherPreset = 'auto',
  timeOfDayStart = 'auto',
  editable = true,
  accent = 'amber',
  compact = false,
  onChangeWeather,
  onChangeTimeOfDay,
}) => {
  const isIndoorFixed = isInfectionMapId(mapId);
  const isAutoTime = timeOfDayStart === 'auto' || timeOfDayStart === undefined;
  const numericTime = typeof timeOfDayStart === 'number' ? timeOfDayStart : 12;

  const activeCls =
    accent === 'red'
      ? 'border-red-500 bg-red-600/25 text-red-100'
      : accent === 'sky'
        ? 'border-sky-400 bg-sky-500/20 text-sky-200'
        : 'border-amber-400 bg-amber-500/20 text-amber-200';

  const labelAccentCls =
    accent === 'red'
      ? 'text-red-300'
      : accent === 'sky'
        ? 'text-sky-300'
        : 'text-amber-300';

  if (isIndoorFixed) {
    return (
      <div className="border border-neutral-800/90 bg-neutral-950/75 px-3.5 py-2.5 font-mono-tabular">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-wider">
          <span className="text-neutral-400">Weather &amp; Time of Day</span>
          <span className="text-neutral-500">Indoor Facility · Controlled Lighting</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border border-neutral-800 bg-neutral-950/88 font-mono-tabular ${
        compact ? 'space-y-2.5 p-3' : 'grid grid-cols-1 gap-4 p-4 lg:grid-cols-12'
      }`}
    >
      {/* Weather Condition Selector */}
      <div className={compact ? '' : 'lg:col-span-6'}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-400">
            Weather Condition
          </span>
          <span className="text-[10px] text-neutral-500">
            {weatherPreset === 'auto' ? 'Dynamic · Random Start' : 'Locked 5m min · Dynamic'}
          </span>
        </div>

        {editable ? (
          <div className="mt-1.5 grid grid-cols-3 gap-1 sm:grid-cols-6">
            {WEATHER_PRESET_OPTIONS.map((w) => {
              const active = weatherPreset === w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => onChangeWeather?.(w.id)}
                  className={`cursor-pointer border py-1.5 text-[10px] font-semibold uppercase transition-colors ${
                    active
                      ? activeCls
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
        ) : (
          <div className={`mt-1 text-xs font-semibold uppercase ${labelAccentCls}`}>
            {formatWeatherPresetLabel(weatherPreset)}
          </div>
        )}
      </div>

      {/* Time of Day Start Selector */}
      <div className={compact ? '' : 'lg:col-span-6'}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-400">
            Start Time · <span className={labelAccentCls}>{formatTimeOfDayLabel(timeOfDayStart)}</span>
          </span>
          <span className="text-[10px] text-neutral-500">1m real = 5m game</span>
        </div>

        {editable ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onChangeTimeOfDay?.(isAutoTime ? 12 : 'auto')}
                className={`cursor-pointer whitespace-nowrap border px-2.5 py-1 text-[10px] font-semibold uppercase transition-colors ${
                  isAutoTime
                    ? activeCls
                    : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Auto
              </button>
              <input
                type="range"
                min={0}
                max={24}
                step={0.5}
                value={numericTime}
                onChange={(e) => onChangeTimeOfDay?.(Number(e.target.value))}
                aria-label="Match Starting Time of Day"
                className="flex-1 accent-amber-400"
              />
              {TIME_PRESET_STOPS.map((stop) => {
                const active = !isAutoTime && Math.abs(numericTime - stop.hours) < 0.05;
                return (
                  <button
                    key={stop.label}
                    type="button"
                    onClick={() => onChangeTimeOfDay?.(stop.hours)}
                    className={`hidden cursor-pointer border px-1.5 py-1 text-[9px] font-semibold sm:inline-block ${
                      active
                        ? activeCls
                        : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {stop.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className={`mt-1 text-xs font-semibold uppercase ${labelAccentCls}`}>
            {formatTimeOfDayLabel(timeOfDayStart)} (1m = 5m)
          </div>
        )}
      </div>
    </div>
  );
};
