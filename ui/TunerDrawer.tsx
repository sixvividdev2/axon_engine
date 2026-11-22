import React from 'react';
import { X } from 'lucide-react';
import { DEFAULT_TUNER_SETTINGS, GameSnapshot, TunerSettings } from '../engine/types';

interface TunerDrawerProps {
  snapshot: GameSnapshot;
  onUpdate: (patch: Partial<TunerSettings>) => void;
  onClose: () => void;
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (val: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}) => (
  <label className="block space-y-1">
    <div className="flex justify-between text-xs">
      <span className="text-neutral-300">{label}</span>
      <span className="font-mono-tabular text-amber-400">{display}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full accent-amber-500 cursor-pointer"
    />
  </label>
);

export const TunerDrawer: React.FC<TunerDrawerProps> = ({
  snapshot,
  onUpdate,
  onClose,
}) => {
  const t = snapshot.tuner;

  return (
    <aside className="fixed top-4 right-4 bottom-4 z-30 w-80 border border-neutral-800 bg-neutral-950/95 p-5 flex flex-col justify-between overflow-y-auto">
      <div className="space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-neutral-100 uppercase">
              Rig &amp; Optics Tuner
            </h3>
            <p className="text-[11px] text-neutral-400">Press F1 to close &amp; resume</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-neutral-100 cursor-pointer"
            aria-label="Close tuner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Free-Aim Controller */}
        <div className="space-y-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Free-Aim Controller
          </div>
          <SliderRow
            label="Deadzone Yaw Cone"
            value={t.deadzoneYawDeg}
            min={3}
            max={18}
            step={0.5}
            display={`±${t.deadzoneYawDeg.toFixed(1)}°`}
            onChange={(v) => onUpdate({ deadzoneYawDeg: v })}
          />
          <SliderRow
            label="Deadzone Pitch Cone"
            value={t.deadzonePitchDeg}
            min={3}
            max={14}
            step={0.5}
            display={`±${t.deadzonePitchDeg.toFixed(1)}°`}
            onChange={(v) => onUpdate({ deadzonePitchDeg: v })}
          />
          <SliderRow
            label="Torso Follow Stiffness"
            value={t.torsoFollowStiffness}
            min={4}
            max={24}
            step={0.5}
            display={t.torsoFollowStiffness.toFixed(1)}
            onChange={(v) => onUpdate({ torsoFollowStiffness: v })}
          />
          <SliderRow
            label="Min Weapon Down Pitch"
            value={t.minWeaponPitchDeg ?? -50}
            min={-65}
            max={-30}
            step={1}
            display={`${Math.round(t.minWeaponPitchDeg ?? -50)}°`}
            onChange={(v) => onUpdate({ minWeaponPitchDeg: v })}
          />
          <SliderRow
            label="Max Weapon Up Pitch"
            value={t.maxWeaponPitchDeg ?? 68}
            min={45}
            max={80}
            step={1}
            display={`+${Math.round(t.maxWeaponPitchDeg ?? 68)}°`}
            onChange={(v) => onUpdate({ maxWeaponPitchDeg: v })}
          />
          <SliderRow
            label="ADS Cheek-Weld Camera Shake"
            value={t.adsCameraShakeScale ?? 1.0}
            min={0}
            max={2.0}
            step={0.05}
            display={`${(t.adsCameraShakeScale ?? 1.0).toFixed(2)}x`}
            onChange={(v) => onUpdate({ adsCameraShakeScale: v })}
          />
          <SliderRow
            label="Hip-Fire Muzzle Recoil Drift"
            value={t.hipRecoilSwayScale ?? 1.0}
            min={0}
            max={2.0}
            step={0.05}
            display={`${(t.hipRecoilSwayScale ?? 1.0).toFixed(2)}x`}
            onChange={(v) => onUpdate({ hipRecoilSwayScale: v })}
          />
        </div>

        {/* Bodycam Optics */}
        <div className="space-y-2.5 border-t border-neutral-800 pt-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Bodycam Optics
          </div>
          <SliderRow
            label="Fisheye Distortion"
            value={t.fisheyeStrength}
            min={0}
            max={0.28}
            step={0.01}
            display={t.fisheyeStrength.toFixed(2)}
            onChange={(v) => onUpdate({ fisheyeStrength: v })}
          />
          <SliderRow
            label="Chromatic Aberration"
            value={t.chromaticAberration}
            min={0}
            max={0.008}
            step={0.0004}
            display={(t.chromaticAberration * 1000).toFixed(1)}
            onChange={(v) => onUpdate({ chromaticAberration: v })}
          />
          <SliderRow
            label="ISO Sensor Grain"
            value={t.isoGrain}
            min={0}
            max={0.12}
            step={0.005}
            display={t.isoGrain.toFixed(3)}
            onChange={(v) => onUpdate({ isoGrain: v })}
          />
          <SliderRow
            label="Auto-Exposure Speed"
            value={t.autoExposureSpeed}
            min={0.5}
            max={6}
            step={0.2}
            display={t.autoExposureSpeed.toFixed(1)}
            onChange={(v) => onUpdate({ autoExposureSpeed: v })}
          />
          <SliderRow
            label="Physical Optic Parallax"
            value={t.opticParallaxStrength ?? 1.0}
            min={0}
            max={2.0}
            step={0.05}
            display={`${(t.opticParallaxStrength ?? 1.0).toFixed(2)}x`}
            onChange={(v) => onUpdate({ opticParallaxStrength: v })}
          />
          <SliderRow
            label="WML Flashlight Cone"
            value={t.flashlightAngleDeg}
            min={14}
            max={42}
            step={1}
            display={`${t.flashlightAngleDeg}°`}
            onChange={(v) => onUpdate({ flashlightAngleDeg: v })}
          />
          {snapshot.exposureDebug && (
            <div className="pt-1 text-[11px] font-mono-tabular text-neutral-400">
              HDR Luma: {snapshot.exposureDebug.avgLuminance.toFixed(3)} · Exp:{' '}
              {snapshot.exposureDebug.exposure.toFixed(2)}x
            </div>
          )}
        </div>

        {/* Chest Mic Audio */}
        <div className="space-y-2.5 border-t border-neutral-800 pt-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Chest Mic Audio
          </div>
          <SliderRow
            label="Mic Clipping Drive"
            value={t.micClippingDrive}
            min={1}
            max={9}
            step={0.5}
            display={t.micClippingDrive.toFixed(1)}
            onChange={(v) => onUpdate({ micClippingDrive: v })}
          />
          <SliderRow
            label="Master Volume"
            value={t.masterVolume}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(t.masterVolume * 100)}%`}
            onChange={(v) => onUpdate({ masterVolume: v })}
          />
        </div>

        {/* Stealth & AI Debug */}
        <div className="space-y-2 border-t border-neutral-800 pt-3">
          <label className="flex items-center justify-between text-xs text-neutral-200 cursor-pointer">
            <span>Stealth &amp; AI Debug Visualization</span>
            <input
              type="checkbox"
              checked={t.debugStealthAI}
              onChange={(e) => onUpdate({ debugStealthAI: e.target.checked })}
              className="accent-amber-500 w-4 h-4 cursor-pointer"
            />
          </label>
          {t.debugStealthAI && snapshot.zombieDebugStats && (
            <div className="text-[11px] font-mono-tabular text-neutral-400">
              Alive: {snapshot.zombieDebugStats.totalAlive} · Investigating:{' '}
              {snapshot.zombieDebugStats.investigating} · Chasing:{' '}
              {snapshot.zombieDebugStats.chasing}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onUpdate({ ...DEFAULT_TUNER_SETTINGS })}
        className="mt-5 w-full py-2 text-xs font-medium border border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800 cursor-pointer"
      >
        Reset Defaults
      </button>
    </aside>
  );
};
