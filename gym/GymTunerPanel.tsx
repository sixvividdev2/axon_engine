import React, { useEffect, useState } from 'react';
import {
  BodycamLensPresetId,
  BodycamSDKConfig,
  getWeaponsByCategory,
  LENS_PRESETS,
  resolveWeaponProfile,
  WEAPON_CATEGORY_META,
  WeaponCategory,
} from '../bodycam-sdk';
import { AmmoVariantId, getAmmoVariantsForCaliber } from '../data/calibers';
import {
  getTacticalEquipmentDef,
  TACTICAL_BELT_SLOTS,
  TACTICAL_EQUIPMENT_LIST,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { GymSnapshot } from './GymEngine';
import { GYM_ZONE_PRESETS, GymZoneId } from './GymWorld';

interface GymTunerPanelProps {
  snapshot: GymSnapshot;
  onUpdateConfig: (patch: Partial<BodycamSDKConfig>) => void;
  onApplyLensPreset: (presetId: BodycamLensPresetId) => void;
  onResetConfig: () => void;
  onTeleportZone: (zone: GymZoneId) => void;
  onSwitchWeapon: (weaponId: string) => void;
  onSelectAmmoVariant: (variantId: AmmoVariantId) => void;
  onToggleFireMode: () => void;
  onToggleSuppressor: () => void;
  onToggleReticleIllumination: () => void;
  onToggleArmTrauma: () => void;
  onSelectTacticalEquipment: (equipmentId: TacticalEquipmentId) => void;
  onSelectTacticalBeltSlot: (slot: TacticalBeltSlot) => void;
  onToggleTacticalMountOnBelt: (visible: boolean) => void;
  onRestockTacticalEquipment: () => void;
  onQuickThrowTactical: () => void;
  onClose: () => void;
  onResumeLock: () => void;
  onReturnToMenu: () => void;
}

type TunerTab = 'optics' | 'controller' | 'weapon_audio' | 'tactical';

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  digits = 2,
  onChange,
}) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-neutral-300">{label}</span>
      <span className="font-mono-tabular text-amber-300">
        {value.toFixed(digits)}
        {unit}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="h-1.5 w-full cursor-pointer accent-amber-400"
    />
  </div>
);

export const GymTunerPanel: React.FC<GymTunerPanelProps> = ({
  snapshot,
  onUpdateConfig,
  onApplyLensPreset,
  onResetConfig,
  onTeleportZone,
  onSwitchWeapon,
  onSelectAmmoVariant,
  onToggleFireMode,
  onToggleSuppressor,
  onToggleReticleIllumination,
  onToggleArmTrauma,
  onSelectTacticalEquipment,
  onSelectTacticalBeltSlot,
  onToggleTacticalMountOnBelt,
  onRestockTacticalEquipment,
  onQuickThrowTactical,
  onClose,
  onResumeLock,
  onReturnToMenu,
}) => {
  const [tab, setTab] = useState<TunerTab>('optics');
  const [copiedState, setCopiedState] = useState<'idle' | 'copied' | 'error'>('idle');
  const equippedProfile = resolveWeaponProfile(snapshot.equippedWeaponId);
  const [weaponCategory, setWeaponCategory] = useState<WeaponCategory>(
    equippedProfile.category ?? 'carbines',
  );

  useEffect(() => {
    if (equippedProfile.category) {
      setWeaponCategory(equippedProfile.category);
    }
  }, [equippedProfile.category]);

  const { config, telemetry } = snapshot;
  const categoryWeapons = getWeaponsByCategory(weaponCategory);
  const ammoVariants = getAmmoVariantsForCaliber(snapshot.activeCaliberId);

  const buildExportJson = (): string =>
    JSON.stringify(
      {
        sdkVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        config,
      },
      null,
      2,
    );

  const handleCopyJson = async () => {
    const json = buildExportJson();
    try {
      await navigator.clipboard.writeText(json);
      setCopiedState('copied');
      window.setTimeout(() => setCopiedState('idle'), 2200);
    } catch {
      setCopiedState('error');
      window.setTimeout(() => setCopiedState('idle'), 2200);
    }
  };

  const handleDownloadJson = () => {
    const json = buildExportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bodycam-sdk-config-${config.lensPreset}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="fixed top-0 right-0 z-30 flex h-screen w-[400px] max-w-[94vw] flex-col border-l border-neutral-800 bg-[#121518] text-neutral-100 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div>
          <div className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-amber-400">
            Portable SDK · F1 Calibration
          </div>
          <h2 className="font-display text-base font-bold uppercase tracking-wide text-neutral-50">
            SDK Tuning &amp; Telemetry
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono-tabular text-xs text-neutral-400">{snapshot.fps} FPS</span>
          <button
            type="button"
            onClick={onResumeLock}
            className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-2.5 py-1 font-mono-tabular text-[11px] font-semibold uppercase text-neutral-950 hover:bg-amber-400"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 px-2 py-1 font-mono-tabular text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>

      {/* Live Telemetry Strip */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-neutral-800 bg-[#0d1012] px-4 py-2.5 font-mono-tabular text-[11px]">
        <div className="flex justify-between">
          <span className="text-neutral-500">Speed / Elev</span>
          <span className="text-neutral-100">
            {telemetry.speedMps.toFixed(2)} m/s · {telemetry.posY.toFixed(2)}m
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Slope / Step</span>
          <span className={telemetry.steppedUp ? 'text-amber-300' : 'text-neutral-100'}>
            {telemetry.slopeAngleDeg.toFixed(1)}° · {(telemetry.stepSmoothOffsetY * 100).toFixed(0)}cm
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Surface</span>
          <span className="uppercase text-sky-300">{telemetry.currentSurface}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Acoustics</span>
          <span className="text-neutral-100">{telemetry.isIndoor ? 'Indoor Reverb' : 'Open Air'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Lean / Head</span>
          <span className={telemetry.leanClamped || telemetry.standBlockedByCeiling ? 'text-amber-300' : 'text-neutral-100'}>
            {(telemetry.leanMeters * 100).toFixed(0)}cm {telemetry.leanClamped ? '(CLAMP)' : ''}
            {telemetry.standBlockedByCeiling ? ' · LOW' : ''}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">HDR Luma / Exp</span>
          <span className="text-neutral-100">
            {telemetry.avgLuminance.toFixed(2)} · {telemetry.exposure.toFixed(2)}x
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Pullback / Misalign</span>
          <span className="text-neutral-100">
            {Math.round(telemetry.wallPullback * 100)}% · {telemetry.sightMisalignDeg.toFixed(1)}°
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">Whip / Breath</span>
          <span className="text-neutral-100">
            {telemetry.angularWhipRadPerSec.toFixed(1)} r/s · {telemetry.breathFreqHz.toFixed(2)} Hz
          </span>
        </div>
      </div>

      {/* Quick-Jump Test Bays */}
      <div className="border-b border-neutral-800 px-4 py-2">
        <div className="mb-1.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
          Teleport to Playground Bay
        </div>
        <div className="grid grid-cols-3 gap-1">
          {GYM_ZONE_PRESETS.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => onTeleportZone(z.id)}
              className="cursor-pointer truncate border border-neutral-800 bg-neutral-900 px-2 py-1 text-left font-mono-tabular text-[10px] text-neutral-200 hover:border-amber-400/70 hover:text-amber-300"
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Selector */}
      <div className="grid grid-cols-4 border-b border-neutral-800 font-mono-tabular text-[10px] uppercase">
        {(
          [
            ['optics', 'Optics'],
            ['controller', 'Rig'],
            ['weapon_audio', 'Weapon'],
            ['tactical', 'Tactical Belt'],
          ] as [TunerTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`cursor-pointer whitespace-nowrap border-b-2 px-1 py-2 text-center transition-colors ${
              tab === id
                ? 'border-amber-400 bg-neutral-900/90 font-semibold text-amber-300'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Scrollable Tuning Sliders */}
      <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
        {tab === 'optics' && (
          <>
            <div>
              <div className="mb-1.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Bodycam Lens Preset
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(Object.keys(LENS_PRESETS) as BodycamLensPresetId[]).map((presetId) => {
                  const preset = LENS_PRESETS[presetId];
                  const active = config.lensPreset === presetId;
                  return (
                    <button
                      key={presetId}
                      type="button"
                      onClick={() => onApplyLensPreset(presetId)}
                      className={`cursor-pointer whitespace-nowrap border px-2 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                        active
                          ? 'border-amber-400 bg-amber-500/15 font-semibold text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-between border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-xs">
              <span className="text-neutral-200">AXON // REC Timestamp Overlay</span>
              <input
                type="checkbox"
                checked={config.showRecOverlay}
                onChange={(e) => onUpdateConfig({ showRecOverlay: e.target.checked })}
                className="h-4 w-4 accent-amber-400"
              />
            </label>

            <SliderRow
              label="Fisheye Barrel Distortion"
              value={config.fisheyeStrength}
              min={0}
              max={0.35}
              step={0.01}
              onChange={(v) => onUpdateConfig({ fisheyeStrength: v })}
            />
            <SliderRow
              label="Chromatic Aberration"
              value={config.chromaticAberration}
              min={0}
              max={0.008}
              step={0.0002}
              digits={4}
              onChange={(v) => onUpdateConfig({ chromaticAberration: v })}
            />
            <SliderRow
              label="Shadow-Weighted ISO Grain"
              value={config.isoGrain}
              min={0}
              max={0.14}
              step={0.005}
              digits={3}
              onChange={(v) => onUpdateConfig({ isoGrain: v })}
            />
            <SliderRow
              label="HDR Auto-Exposure Speed"
              value={config.autoExposureSpeed}
              min={0.5}
              max={6.0}
              step={0.1}
              digits={1}
              onChange={(v) => onUpdateConfig({ autoExposureSpeed: v })}
            />
            <SliderRow
              label="Lens Dirt / Smudge Flare"
              value={config.lensDirtStrength}
              min={0}
              max={1.0}
              step={0.02}
              onChange={(v) => onUpdateConfig({ lensDirtStrength: v })}
            />
            <SliderRow
              label="Whip Shutter Motion Blur"
              value={config.motionBlurStrength}
              min={0}
              max={1.0}
              step={0.02}
              onChange={(v) => onUpdateConfig({ motionBlurStrength: v })}
            />
            <SliderRow
              label="Base Horizontal FOV"
              value={config.baseHFovDeg}
              min={84}
              max={114}
              step={1}
              unit="°"
              digits={0}
              onChange={(v) => onUpdateConfig({ baseHFovDeg: v })}
            />
            <SliderRow
              label="Physical Optic Parallax"
              value={config.opticParallaxStrength ?? 1.0}
              min={0}
              max={2.0}
              step={0.05}
              unit="x"
              onChange={(v) => onUpdateConfig({ opticParallaxStrength: v })}
            />
            <SliderRow
              label="Weapon Light Beam Cone"
              value={config.flashlightAngleDeg}
              min={16}
              max={42}
              step={1}
              unit="°"
              digits={0}
              onChange={(v) => onUpdateConfig({ flashlightAngleDeg: v })}
            />
          </>
        )}

        {tab === 'controller' && (
          <>
            <SliderRow
              label="Free-Aim Deadzone Yaw"
              value={config.deadzoneYawDeg}
              min={3}
              max={18}
              step={0.5}
              unit="°"
              digits={1}
              onChange={(v) => onUpdateConfig({ deadzoneYawDeg: v })}
            />
            <SliderRow
              label="Free-Aim Deadzone Pitch"
              value={config.deadzonePitchDeg}
              min={3}
              max={14}
              step={0.5}
              unit="°"
              digits={1}
              onChange={(v) => onUpdateConfig({ deadzonePitchDeg: v })}
            />
            <SliderRow
              label="Torso Spring Stiffness"
              value={config.torsoFollowStiffness}
              min={6.0}
              max={18.0}
              step={0.5}
              digits={1}
              onChange={(v) => onUpdateConfig({ torsoFollowStiffness: v })}
            />
            <SliderRow
              label="Max Auto Step-Up Height"
              value={config.maxStepUpM}
              min={0.15}
              max={0.40}
              step={0.01}
              unit="m"
              onChange={(v) => onUpdateConfig({ maxStepUpM: v })}
            />
            <SliderRow
              label="Step-Up Vertical Smooth Speed"
              value={config.stepSmoothSpeed}
              min={6.0}
              max={24.0}
              step={0.5}
              digits={1}
              onChange={(v) => onUpdateConfig({ stepSmoothSpeed: v })}
            />
            <SliderRow
              label="Ground Momentum Accel"
              value={config.groundAccel}
              min={6.0}
              max={24.0}
              step={0.5}
              digits={1}
              onChange={(v) => onUpdateConfig({ groundAccel: v })}
            />
            <SliderRow
              label="Strafe Reversal Weight Dip"
              value={config.strafeWeightDipStrength}
              min={0}
              max={2.0}
              step={0.05}
              onChange={(v) => onUpdateConfig({ strafeWeightDipStrength: v })}
            />
            <SliderRow
              label="Landing Knee-Compression Shock"
              value={config.landingShockScale}
              min={0}
              max={2.0}
              step={0.05}
              onChange={(v) => onUpdateConfig({ landingShockScale: v })}
            />
            <SliderRow
              label="Lean Max Lateral Offset"
              value={config.leanMaxOffsetM}
              min={0.14}
              max={0.36}
              step={0.01}
              unit="m"
              onChange={(v) => onUpdateConfig({ leanMaxOffsetM: v })}
            />
            <SliderRow
              label="Lean Max Camera Roll"
              value={config.leanMaxRollDeg}
              min={4}
              max={18}
              step={0.5}
              unit="°"
              digits={1}
              onChange={(v) => onUpdateConfig({ leanMaxRollDeg: v })}
            />
            <SliderRow
              label="Min Weapon Down Pitch"
              value={config.minWeaponPitchDeg}
              min={-65}
              max={-30}
              step={1}
              unit="°"
              digits={0}
              onChange={(v) => onUpdateConfig({ minWeaponPitchDeg: v })}
            />
            <SliderRow
              label="Max Weapon Up Pitch"
              value={config.maxWeaponPitchDeg}
              min={45}
              max={80}
              step={1}
              unit="°"
              digits={0}
              onChange={(v) => onUpdateConfig({ maxWeaponPitchDeg: v })}
            />

            <div className="border-t border-neutral-800 pt-2.5">
              <button
                type="button"
                onClick={onToggleArmTrauma}
                className={`w-full cursor-pointer border px-3 py-2 text-left font-mono-tabular text-[11px] uppercase transition-colors ${
                  snapshot.simulatedArmTrauma
                    ? 'border-red-500/80 bg-red-950/40 text-red-200'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600'
                }`}
              >
                Arm Trauma Tremor Test: {snapshot.simulatedArmTrauma ? 'ACTIVE (Rigid Hand+Gun Lock)' : 'OFF'}
              </button>
            </div>
          </>
        )}

        {tab === 'weapon_audio' && (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                <span>42-Weapon Armory Testbench</span>
                <button
                  type="button"
                  onClick={() => onSwitchWeapon('unarmed')}
                  className={`cursor-pointer border px-1.5 py-0.5 text-[9px] ${
                    snapshot.equippedWeaponId === 'unarmed'
                      ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600'
                  }`}
                >
                  Unarmed [0]
                </button>
              </div>
              <div className="mb-1.5 grid grid-cols-4 gap-1">
                {WEAPON_CATEGORY_META.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setWeaponCategory(cat.id)}
                    className={`cursor-pointer truncate border px-1.5 py-1 font-mono-tabular text-[10px] uppercase transition-colors ${
                      weaponCategory === cat.id
                        ? 'border-amber-400 bg-amber-500/18 font-semibold text-amber-200'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600'
                    }`}
                  >
                    {cat.shortLabel}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-1">
                {categoryWeapons.map((w) => {
                  const active = snapshot.equippedWeaponId === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => onSwitchWeapon(w.id)}
                      className={`flex cursor-pointer items-center justify-between border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                        active
                          ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600'
                      }`}
                    >
                      <span className="truncate">{w.name}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-neutral-400">
                        {w.massKg.toFixed(2)}kg · {w.caliberLabel}
                      </span>
                    </button>
                  );
                })}
              </div>

              {ammoVariants.length > 0 && snapshot.equippedWeaponId !== 'unarmed' && (
                <div className="mt-2 border-t border-neutral-800 pt-2">
                  <div className="mb-1 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Cartridge Variant ({snapshot.activeCaliberId.toUpperCase()})
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    {ammoVariants.map((v) => {
                      const active = snapshot.activeAmmoVariantId === v.id;
                      const muzzleVel = Math.round(
                        v.baseVelocityMs *
                          (equippedProfile.barrelVelocityMult ?? 1.0) *
                          snapshot.derivedStats.velocityMult,
                      );
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => onSelectAmmoVariant(v.id)}
                          className={`flex cursor-pointer items-center justify-between border px-2.5 py-1 font-mono-tabular text-[10px] transition-colors ${
                            active
                              ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                              : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600'
                          }`}
                        >
                          <span className="truncate font-semibold">{v.label}</span>
                          <span className="ml-2 shrink-0 text-neutral-400">
                            {v.bulletMassGrams}g · {muzzleVel}m/s{v.isSubsonic ? ' · SUB' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {snapshot.toggleablePumpSemi && (
                <button
                  type="button"
                  onClick={onToggleFireMode}
                  className="mt-1.5 w-full cursor-pointer border border-amber-500/60 bg-amber-500/12 px-2.5 py-1.5 font-mono-tabular text-[11px] font-semibold text-amber-200 hover:bg-amber-500/20"
                >
                  SPAS-12 Mode (Z): {snapshot.spas12Mode === 'semi' ? 'SEMI-AUTO' : 'PUMP ACTION'}
                </button>
              )}

              <button
                type="button"
                onClick={onToggleSuppressor}
                className="mt-1.5 w-full cursor-pointer border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-[11px] text-neutral-200 hover:border-amber-400/70"
              >
                Suppressor (G): {snapshot.suppressorAttached ? 'ATTACHED' : 'DETACHED'}
              </button>
              <button
                type="button"
                onClick={onToggleReticleIllumination}
                className="mt-1.5 flex w-full cursor-pointer items-center justify-between border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-[11px] text-neutral-200 hover:border-amber-400/70"
              >
                <span>Reticle Illumination (N): {snapshot.reticleIlluminated ? 'ON' : 'ETCHED'}</span>
                {snapshot.isMagnifiedOptic && (
                  <span className="text-amber-300">{snapshot.activeOpticZoom.toFixed(1)}x</span>
                )}
              </button>
            </div>

            <SliderRow
              label="Weapon Rotational Inertia"
              value={config.weaponInertiaScale}
              min={0.3}
              max={2.0}
              step={0.05}
              onChange={(v) => onUpdateConfig({ weaponInertiaScale: v })}
            />
            <SliderRow
              label="Rapid-Fire Sight Misalignment"
              value={config.sightMisalignStrength}
              min={0}
              max={2.2}
              step={0.05}
              onChange={(v) => onUpdateConfig({ sightMisalignStrength: v })}
            />
            <SliderRow
              label="ADS Cheek-Weld Camera Shake"
              value={config.adsCameraShakeScale ?? 1.0}
              min={0}
              max={2.0}
              step={0.05}
              unit="x"
              onChange={(v) => onUpdateConfig({ adsCameraShakeScale: v })}
            />
            <SliderRow
              label="Hip-Fire Muzzle Recoil Drift"
              value={config.hipRecoilSwayScale ?? 1.0}
              min={0}
              max={2.0}
              step={0.05}
              unit="x"
              onChange={(v) => onUpdateConfig({ hipRecoilSwayScale: v })}
            />
            <SliderRow
              label="Tactical Cant Angle"
              value={config.cantAngleDeg}
              min={20}
              max={48}
              step={1}
              unit="°"
              digits={0}
              onChange={(v) => onUpdateConfig({ cantAngleDeg: v })}
            />
            <SliderRow
              label="Wall Pullback Distance Scale"
              value={config.wallPullbackScale}
              min={0.6}
              max={1.5}
              step={0.05}
              onChange={(v) => onUpdateConfig({ wallPullbackScale: v })}
            />
            <SliderRow
              label="Chest-Mic Soft-Clip Drive"
              value={config.micClippingDrive}
              min={1.0}
              max={10.0}
              step={0.25}
              onChange={(v) => onUpdateConfig({ micClippingDrive: v })}
            />
            <SliderRow
              label="Tactical Vest / Gear Rattle"
              value={config.gearRattleGain}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => onUpdateConfig({ gearRattleGain: v })}
            />
            <SliderRow
              label="Master Volume"
              value={config.masterVolume}
              min={0}
              max={1.0}
              step={0.05}
              onChange={(v) => onUpdateConfig({ masterVolume: v })}
            />
          </>
        )}

        {tab === 'tactical' && (() => {
          const activeDef = getTacticalEquipmentDef(snapshot.tacticalEquipmentId);
          return (
            <div className="space-y-4 font-mono-tabular">
              {/* Specialized Tactical Equipment Slot */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                    Tactical Equipment Slot
                  </span>
                  <span className="text-[10px] text-neutral-400">
                    [H]/[5] Draw · LMB Pin · RMB Lever
                  </span>
                </div>

                <div className="space-y-1.5">
                  {TACTICAL_EQUIPMENT_LIST.map((item) => {
                    const active = snapshot.tacticalEquipmentId === item.id;
                    const fuseLabel =
                      item.fuseVarianceSec && item.fuseVarianceSec > 0
                        ? `${(item.fuseSec - item.fuseVarianceSec).toFixed(1)}–${(item.fuseSec + item.fuseVarianceSec).toFixed(1)}s`
                        : `${item.fuseSec.toFixed(1)}s`;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelectTacticalEquipment(item.id)}
                        className={`w-full cursor-pointer border px-3 py-2 text-left transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                            : 'border-neutral-800 bg-neutral-900/75 text-neutral-300 hover:border-neutral-600'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wider">
                            {item.name}
                          </span>
                          <span
                            className={`text-[10px] font-semibold uppercase ${
                              item.category === 'lethal' ? 'text-amber-400' : 'text-sky-400'
                            }`}
                          >
                            {item.category} · {fuseLabel}
                          </span>
                        </div>
                        <p className="mt-0.5 font-sans text-[11px] leading-snug text-neutral-400">
                          {item.description}
                        </p>
                        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-neutral-500">
                          <span>
                            {item.lethalRadiusM
                              ? `LETHAL ${item.lethalRadiusM.toFixed(0)}m · CAS ${item.blastRadiusM.toFixed(0)}m`
                              : `RAD ${item.blastRadiusM.toFixed(1)}m`}
                          </span>
                          <span>
                            {item.maxDamage > 0
                              ? `DMG ${item.maxDamage}${item.id === 'an_m14_thermite' ? '/s' : ''}`
                              : `SCREEN ${item.effectDurationSec.toFixed(0)}s`}
                          </span>
                          <span>WT {item.weightKg.toFixed(2)}kg</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Player Belt Mesh Assignment */}
              <div className="space-y-2 border-t border-neutral-800 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
                    Belt Mesh Assignment
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleTacticalMountOnBelt(!snapshot.tacticalMountOnBelt)}
                    className={`cursor-pointer border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      snapshot.tacticalMountOnBelt
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400'
                    }`}
                  >
                    {snapshot.tacticalMountOnBelt ? 'MOUNTED ON BELT' : 'STOWED'}
                  </button>
                </div>
                <p className="font-sans text-[11px] leading-snug text-neutral-400">
                  Mounts the active ordnance 3D mesh onto the operator&apos;s waist belt across
                  Playground, Battle, Infection, and Operator Preview.
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {TACTICAL_BELT_SLOTS.map((slot) => {
                    const active = snapshot.tacticalBeltSlot === slot.id;
                    return (
                      <button
                        key={slot.id}
                        type="button"
                        onClick={() => onSelectTacticalBeltSlot(slot.id)}
                        className={`cursor-pointer border px-2.5 py-2 text-left transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                            : 'border-neutral-800 bg-neutral-900/75 text-neutral-300 hover:border-neutral-600'
                        }`}
                      >
                        <div className="text-[10px] font-semibold uppercase tracking-wider">
                          {slot.label}
                        </div>
                        <div className="mt-0.5 font-sans text-[10px] leading-tight text-neutral-500">
                          {slot.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Pouch Readout & Live Test Controls */}
              <div className="space-y-2 border-t border-neutral-800 pt-3">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="uppercase tracking-wider text-neutral-400">Carried Supply</span>
                  <span className="font-semibold text-amber-300">
                    {activeDef.shortName} · {snapshot.grenadeCount}/{snapshot.grenadeMax}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={onRestockTacticalEquipment}
                    className="cursor-pointer whitespace-nowrap border border-emerald-600/70 bg-emerald-950/40 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 hover:bg-emerald-900/50"
                  >
                    Restock Pouch
                  </button>
                  <button
                    type="button"
                    onClick={onQuickThrowTactical}
                    className="cursor-pointer whitespace-nowrap border border-amber-400/70 bg-amber-500/15 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-amber-200 hover:bg-amber-500/25"
                  >
                    Quick Throw
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Footer Export & Mode Actions */}
      <div className="space-y-2 border-t border-neutral-800 bg-[#0d1012] p-3.5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleCopyJson()}
            className="flex-1 cursor-pointer whitespace-nowrap bg-amber-500 px-3 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
          >
            {copiedState === 'copied'
              ? 'Copied Tuned Config JSON'
              : copiedState === 'error'
                ? 'Clipboard Blocked — Use Download'
                : 'Export Tuned Config JSON'}
          </button>
          <button
            type="button"
            onClick={handleDownloadJson}
            className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono-tabular text-xs uppercase text-neutral-200 hover:border-amber-400/70"
          >
            .JSON
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onResetConfig}
            className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-800 px-2.5 py-1.5 font-mono-tabular text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
          >
            Reset Defaults
          </button>
          <button
            type="button"
            onClick={onReturnToMenu}
            className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-800 px-2.5 py-1.5 font-mono-tabular text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-white"
          >
            Return to Main Menu
          </button>
        </div>
      </div>
    </aside>
  );
};
