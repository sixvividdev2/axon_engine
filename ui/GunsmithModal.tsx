import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import {
  BALLISTICS_TEST_MATERIALS,
  BallisticsCameraPreset,
  BallisticsSimViewport,
} from '../arena/BallisticsSimViewport';
import { GunsmithPinProjection } from '../arena/GunsmithBench';
import {
  getWeaponsByCategory,
  resolveWeaponProfile,
  simulateMaterialPenetration,
  simulateTrajectoryProfile,
  WEAPON_CATEGORY_META,
  WeaponCategory,
} from '../bodycam-sdk';
import {
  ATTACHMENT_SLOTS,
  ATTACHMENTS,
  AttachmentDef,
  AttachmentSlot,
  DerivedWeaponStats,
  getBallisticSimMaxRangeM,
  getCompatibleAttachments,
  getDefaultZeroDistanceM,
  getRequiredRailAdapterId,
  getZeroDistancePresets,
  RETICLE_COLOR_OPTIONS,
  ReticleColorId,
  WeaponAttachments,
} from '../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantId,
  BaseCaliberId,
  BulletCoreType,
  getAmmoVariantsForCaliber,
} from '../data/calibers';
import {
  getAttachmentRequiredGunLevel,
  getWeaponUnlockRank,
  MAX_GUN_LEVEL,
  WeaponProgressRecord,
  xpRequiredForNextGunLevel,
} from '../data/progression';

type GunsmithTab = 'modify' | 'ballistics';

interface GunsmithModalProps {
  weaponId: string;
  weaponName: string;
  caliberLabel: string;
  activeCaliberId: BaseCaliberId;
  activeAmmoVariantId: AmmoVariantId;
  toggleablePumpSemi: boolean;
  spas12Mode: 'semi' | 'pump';
  attachments: WeaponAttachments;
  stats: DerivedWeaponStats;
  pins: readonly GunsmithPinProjection[];
  zeroDistanceM?: number;
  zeroElevationMrad?: number;
  heightOverBoreM?: number;
  onSelectWeapon: (weaponId: string) => void;
  onSelectAmmoVariant: (variantId: AmmoVariantId) => void;
  onToggleFireMode: () => void;
  onSelectAttachment: (slot: AttachmentSlot, attachmentId: string | null) => void;
  onSelectReticleColor: (slot: 'optic' | 'canted', colorId: ReticleColorId) => void;
  onSelectZeroDistance?: (distanceM: number) => void;
  onAdjustElevationMrad?: (elevationMrad: number) => void;
  onTestFireSound?: () => void;
  onTurretClickSound?: (up: boolean) => void;
  onStripAll: () => void;
  onOrbit: (dx: number, dy: number) => void;
  onZoom: (deltaY: number) => void;
  onClose: () => void;
  careerRank?: number;
  weaponProgress?: WeaponProgressRecord;
  isWeaponUnlocked?: (weaponId: string) => boolean;
  isAttachmentUnlocked?: (attachmentId: string) => boolean;
}

function formatAttachmentBadges(def: AttachmentDef): string[] {
  const tags: string[] = [];
  if (def.caliberOverride) {
    tags.push(`CAL → ${def.caliberOverride.toUpperCase()}`);
  }
  if (def.grantsPicatinnyRail) {
    tags.push('Picatinny Bridge');
  }
  if (def.velocityMult && Math.abs(def.velocityMult - 1) > 0.005) {
    const pct = Math.round((def.velocityMult - 1) * 100);
    tags.push(`${pct > 0 ? '+' : ''}${pct}% Vel`);
  }
  if (def.massKg !== 0) {
    tags.push(`${def.massKg > 0 ? '+' : ''}${def.massKg.toFixed(2)}kg`);
  }
  if (def.ergonomicsDelta !== 0) {
    tags.push(`${def.ergonomicsDelta > 0 ? '+' : ''}${def.ergonomicsDelta} Ergo`);
  }
  if (def.recoilPitchMult < 0.99) {
    tags.push(`-${Math.round((1 - def.recoilPitchMult) * 100)}% Recoil`);
  }
  if (def.zoomLevels && def.zoomLevels.length > 1) {
    tags.push(`${def.zoomLevels[0]}–${def.zoomLevels[def.zoomLevels.length - 1]}x Variable`);
  } else if (def.adsZoomFactor && def.adsZoomFactor >= 1.5) {
    tags.push(`${def.adsZoomFactor.toFixed(1)}x Zoom`);
  }
  if (def.isSuppressor) {
    tags.push('Suppressed');
  } else if (def.slot === 'muzzle') {
    tags.push('Loud Brake');
  }
  if (def.enablesFlashlight) tags.push('[F] Light');
  if (def.enablesLaser) tags.push('[L] Laser');
  if (def.capacityOverride) tags.push(`${def.capacityOverride} Rds`);
  return tags;
}

function coreBadgeLabel(coreType: BulletCoreType): string {
  switch (coreType) {
    case 'tungsten_ap':
      return 'W-AP';
    case 'solid_steel':
      return 'STEEL';
    case 'steel_core_ap':
      return 'AP-SC';
    case 'lead_fmj':
      return 'FMJ';
    case 'lead_jhp':
      return 'JHP';
    case 'soft_lead':
      return 'LEAD';
    case 'frangible_pellet':
      return 'FRANG';
  }
}

function damageColorClass(ratio: number): string {
  if (ratio >= 0.72) return 'text-emerald-400';
  if (ratio >= 0.48) return 'text-amber-300';
  if (ratio >= 0.28) return 'text-orange-400';
  return 'text-red-400';
}

export const GunsmithModal: React.FC<GunsmithModalProps> = ({
  weaponId,
  weaponName,
  caliberLabel,
  activeCaliberId,
  activeAmmoVariantId,
  toggleablePumpSemi,
  spas12Mode,
  attachments,
  stats,
  pins,
  zeroDistanceM,
  zeroElevationMrad,
  heightOverBoreM = 0.056,
  onSelectWeapon,
  onSelectAmmoVariant,
  onToggleFireMode,
  onSelectAttachment,
  onSelectReticleColor,
  onSelectZeroDistance,
  onAdjustElevationMrad,
  onTestFireSound,
  onTurretClickSound,
  onStripAll,
  onOrbit,
  onZoom,
  onClose,
  careerRank = 1,
  weaponProgress,
  isWeaponUnlocked,
  isAttachmentUnlocked,
}) => {
  const activeProfile = resolveWeaponProfile(weaponId);
  const category: WeaponCategory = activeProfile.category ?? 'carbines';
  const gunLevel = weaponProgress?.level ?? 1;
  const gunXp = weaponProgress?.xp ?? 0;
  const gunNextXp = xpRequiredForNextGunLevel(gunLevel);
  const gunXpPct = Math.min(100, (gunXp / Math.max(1, gunNextXp)) * 100);
  const activeWeaponUnlocked = isWeaponUnlocked ? isWeaponUnlocked(weaponId) : true;
  const activeWeaponReqRank = getWeaponUnlockRank(weaponId);

  const [activeTab, setActiveTab] = useState<GunsmithTab>('modify');
  const [selectedSlot, setSelectedSlot] = useState<AttachmentSlot | null>('optic');
  const [activeCategory, setActiveCategory] = useState<WeaponCategory>(category);

  // Local fallbacks if parent doesn't supply zeroing callbacks
  const [localZeroDist, setLocalZeroDist] = useState<number>(() =>
    attachments.zeroDistanceM ?? getDefaultZeroDistanceM(category),
  );
  const [localElevationMrad, setLocalElevationMrad] = useState<number>(
    () => attachments.zeroElevationMrad ?? 0,
  );

  // Ballistics Simulator UI controls
  const [cameraPreset, setCameraPreset] = useState<BallisticsCameraPreset>('full_range');
  const [slowMo, setSlowMo] = useState(false);
  const [selectedMaterialIdx, setSelectedMaterialIdx] = useState(2); // Mild Steel 8mm default
  const [testRangeM, setTestRangeM] = useState<number>(100);
  const [obliquityDeg, setObliquityDeg] = useState<number>(0);
  const [dockCollapsed, setDockCollapsed] = useState(false);

  const draggingRef = useRef(false);
  const dragModeOrbitRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const simMountRef = useRef<HTMLDivElement | null>(null);
  const simViewportRef = useRef<BallisticsSimViewport | null>(null);

  const effectiveZeroDistM = zeroDistanceM ?? attachments.zeroDistanceM ?? localZeroDist;
  const effectiveElevationMrad =
    zeroElevationMrad ?? attachments.zeroElevationMrad ?? localElevationMrad;
  const maxSimRangeM = getBallisticSimMaxRangeM(category);
  const zeroPresets = getZeroDistancePresets(category);

  useEffect(() => {
    if (activeProfile.category) {
      setActiveCategory(activeProfile.category);
    }
  }, [activeProfile.category]);

  useEffect(() => {
    setTestRangeM((prev) => Math.min(prev, maxSimRangeM));
  }, [maxSimRangeM]);

  const ammoVariants = getAmmoVariantsForCaliber(activeCaliberId);
  const activeAmmo = AMMO_VARIANTS[activeAmmoVariantId] ?? ammoVariants[0];

  const effectiveVelMps = activeAmmo
    ? activeAmmo.baseVelocityMs * (activeProfile.barrelVelocityMult ?? 1.0) * stats.velocityMult
    : activeProfile.muzzleVelocityMps;
  const effectiveEnergyJ = activeAmmo
    ? 0.5 * (activeAmmo.bulletMassGrams * 0.001) * effectiveVelMps * effectiveVelMps
    : 0;

  // SSOT Ballistics Trajectory & Material Penetration computation
  const trajectoryProfile = useMemo(() => {
    if (!activeAmmo) return null;
    return simulateTrajectoryProfile({
      ammo: activeAmmo,
      barrelVelocityMult: activeProfile.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: stats.velocityMult,
      heightOverBoreM,
      zeroDistanceM: effectiveZeroDistM,
      extraElevationMrad: effectiveElevationMrad,
      maxRangeM: maxSimRangeM,
      sampleStepM: Math.max(2, Math.round(maxSimRangeM / 110)),
    });
  }, [
    activeAmmo,
    activeProfile.barrelVelocityMult,
    stats.velocityMult,
    heightOverBoreM,
    effectiveZeroDistM,
    effectiveElevationMrad,
    maxSimRangeM,
  ]);

  const activeTestMaterial = BALLISTICS_TEST_MATERIALS[selectedMaterialIdx] ?? BALLISTICS_TEST_MATERIALS[2];

  const impactSpeedAtTestRange = useMemo(() => {
    if (!trajectoryProfile || trajectoryProfile.points.length === 0) return effectiveVelMps;
    const pts = trajectoryProfile.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (testRangeM >= pts[i].distanceM && testRangeM <= pts[i + 1].distanceM) {
        const span = Math.max(1e-4, pts[i + 1].distanceM - pts[i].distanceM);
        const f = (testRangeM - pts[i].distanceM) / span;
        return pts[i].velocityMs + (pts[i + 1].velocityMs - pts[i].velocityMs) * f;
      }
    }
    return pts[pts.length - 1].velocityMs;
  }, [trajectoryProfile, testRangeM, effectiveVelMps]);

  const penetrationResult = useMemo(() => {
    if (!activeAmmo) return null;
    return simulateMaterialPenetration({
      ammo: activeAmmo,
      impactSpeedMs: impactSpeedAtTestRange,
      material: activeTestMaterial.materialId,
      thicknessM: activeTestMaterial.thicknessM,
      obliquityDeg,
      barrelVelocityMult: activeProfile.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: stats.velocityMult,
    });
  }, [
    activeAmmo,
    impactSpeedAtTestRange,
    activeTestMaterial,
    obliquityDeg,
    activeProfile.barrelVelocityMult,
    stats.velocityMult,
  ]);

  // Mount & tear down dedicated 3D Wireframe BallisticsSimViewport when tab is active
  useEffect(() => {
    if (activeTab !== 'ballistics') {
      if (simViewportRef.current) {
        simViewportRef.current.dispose();
        simViewportRef.current = null;
      }
      return;
    }
    const el = simMountRef.current;
    if (!el) return;

    const vp = new BallisticsSimViewport(el);
    simViewportRef.current = vp;
    vp.setCameraPreset(cameraPreset);

    return () => {
      vp.dispose();
      if (simViewportRef.current === vp) {
        simViewportRef.current = null;
      }
    };
  }, [activeTab]);

  // Push live ballistic & attachment state into BallisticsSimViewport
  useEffect(() => {
    const vp = simViewportRef.current;
    if (!vp || !trajectoryProfile || !penetrationResult) return;
    vp.updateConfig({
      profile: activeProfile,
      attachments,
      trajectory: trajectoryProfile,
      penetration: penetrationResult,
      testMaterial: activeTestMaterial,
      testRangeM,
      obliquityDeg,
      zeroElevationMrad: effectiveElevationMrad,
      isSuppressed: stats.isSuppressed,
    });
  }, [
    activeTab,
    activeProfile,
    attachments,
    trajectoryProfile,
    penetrationResult,
    activeTestMaterial,
    testRangeM,
    obliquityDeg,
    effectiveElevationMrad,
    stats.isSuppressed,
  ]);

  useEffect(() => {
    simViewportRef.current?.setSlowMo(slowMo);
  }, [slowMo]);

  const handleSetZeroDistance = (distM: number) => {
    setLocalZeroDist(distM);
    onSelectZeroDistance?.(distM);
    onTurretClickSound?.(distM >= effectiveZeroDistM);
  };

  const handleAdjustElevation = (nextMrad: number) => {
    const clamped = Math.round(Math.max(-15, Math.min(25, nextMrad)) * 10) / 10;
    const up = clamped >= effectiveElevationMrad;
    setLocalElevationMrad(clamped);
    onAdjustElevationMrad?.(clamped);
    onTurretClickSound?.(up);
  };

  const handleCameraPreset = (preset: BallisticsCameraPreset) => {
    setCameraPreset(preset);
    simViewportRef.current?.setCameraPreset(preset);
  };

  const handleTestFire = () => {
    simViewportRef.current?.triggerTestFire(slowMo);
    onTestFireSound?.();
  };

  const handlePointerDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    draggingRef.current = true;
    dragModeOrbitRef.current = e.button === 2 || e.shiftKey;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastPosRef.current.x;
    const dy = e.clientY - lastPosRef.current.y;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    if (activeTab === 'ballistics') {
      simViewportRef.current?.panDrag(dx, dy, dragModeOrbitRef.current);
    } else {
      onOrbit(dx, dy);
    }
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (activeTab === 'ballistics') {
      simViewportRef.current?.zoomWheel(e.deltaY);
    } else {
      onZoom(e.deltaY);
    }
  };

  const activeSlotMeta = selectedSlot
    ? ATTACHMENT_SLOTS.find((s) => s.slot === selectedSlot) ?? null
    : null;
  const compatibleForSlot = selectedSlot
    ? getCompatibleAttachments(weaponId, selectedSlot, attachments, true)
    : [];
  const installedId = selectedSlot ? attachments[selectedSlot] ?? null : null;
  const installedDef = installedId ? ATTACHMENTS[installedId] ?? null : null;
  const showReticleColorPicker =
    (selectedSlot === 'optic' || selectedSlot === 'canted') &&
    Boolean(installedDef?.hasIlluminatedReticle);
  const activeReticleColor: ReticleColorId =
    (selectedSlot === 'canted' ? attachments.cantedReticleColor : attachments.reticleColor) ??
    'red';

  const hasAnyAttachment = Boolean(
    attachments.railAdapter ||
      attachments.optic ||
      attachments.canted ||
      attachments.muzzle ||
      attachments.tactical ||
      attachments.foregrip ||
      attachments.magazine,
  );

  // Modular caliber conversion attachments available on this weapon (Barrett MRAD / Desert Eagle XIX)
  const caliberConversions = useMemo(() => {
    return getCompatibleAttachments(weaponId, 'magazine', attachments, false).filter((d) =>
      Boolean(d.caliberOverride),
    );
  }, [weaponId, attachments]);

  const categoryWeapons = getWeaponsByCategory(activeCategory);

  return (
    <div
      className="fixed inset-0 z-30 select-none overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Interactive 3D viewport layer */}
      {activeTab === 'ballistics' ? (
        <div
          ref={simMountRef}
          className="fixed inset-0 cursor-grab bg-[#060c17] active:cursor-grabbing"
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onWheel={handleWheel}
        />
      ) : (
        <div
          className="fixed inset-0 cursor-grab active:cursor-grabbing"
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onWheel={handleWheel}
        />
      )}

      {/* Top Bar: Workbench Title, Mode Tabs, and Exit Action */}
      <div className="pointer-events-none fixed top-4 right-5 left-5 z-20 flex flex-wrap items-start justify-between gap-3">
        <div className="pointer-events-auto border border-slate-700/80 bg-[#080d16]/94 px-4 py-2.5 text-neutral-100">
          <div className="flex items-center gap-2 font-mono-tabular text-[10px] tracking-[0.16em] text-slate-400">
            <span>Armorer Bench</span>
            {activeProfile.country && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-slate-200">{activeProfile.country}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="text-amber-300">Zero {effectiveZeroDistM}m</span>
            {Math.abs(effectiveElevationMrad) > 0.01 && (
              <span className="text-sky-300">
                {effectiveElevationMrad > 0 ? '+' : ''}
                {effectiveElevationMrad.toFixed(1)} MRAD
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-3">
            <h2 className="font-display text-xl font-bold tracking-wide text-neutral-50">
              {weaponName}
            </h2>
            <span className="font-mono-tabular text-xs text-slate-300">{caliberLabel}</span>
            {toggleablePumpSemi && (
              <button
                type="button"
                onClick={onToggleFireMode}
                className="cursor-pointer whitespace-nowrap border border-amber-500/70 bg-amber-500/15 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold text-amber-200 hover:bg-amber-500/25"
              >
                Mode: {spas12Mode === 'semi' ? 'Semi-Auto' : 'Pump Action'} [Z]
              </button>
            )}
          </div>
          <div className="mt-1 font-mono-tabular text-[11px] text-slate-400">
            {activeTab === 'ballistics'
              ? 'Drag to pan · Right-drag to angle · Scroll to zoom · Unlimited zero-ammo test fire'
              : 'Drag to orbit 360° · Scroll to zoom · Click a socket pin to mount parts'}
          </div>
          {activeTab === 'modify' && (
            <div className="mt-2 flex items-center gap-3 border-t border-slate-800 pt-1.5 font-mono-tabular text-[10px]">
              {activeWeaponUnlocked ? (
                <>
                  <span className="text-amber-300">
                    Gun Lv. {gunLevel} / {MAX_GUN_LEVEL}
                  </span>
                  <div className="h-1.5 w-24 overflow-hidden bg-slate-900">
                    <div className="h-full bg-amber-400" style={{ width: `${gunXpPct.toFixed(1)}%` }} />
                  </div>
                  <span className="text-slate-400">
                    {gunXp}/{gunNextXp} XP
                  </span>
                </>
              ) : (
                <span className="flex items-center gap-1.5 text-red-400">
                  <Lock className="h-3 w-3" />
                  Locked — Career Rank {activeWeaponReqRank} required (Rank {careerRank})
                </span>
              )}
            </div>
          )}
        </div>

        {/* Center/Right Tab Switcher + Ballistics Sim Action Strip + Exit */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <div className="flex border border-slate-700/80 bg-[#080d16]/94 p-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('modify')}
              className={`cursor-pointer whitespace-nowrap px-3.5 py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                activeTab === 'modify'
                  ? 'bg-amber-400 text-neutral-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Modify Parts
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ballistics')}
              className={`cursor-pointer whitespace-nowrap px-3.5 py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                activeTab === 'ballistics'
                  ? 'bg-sky-400 text-neutral-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Zero &amp; Ballistics
            </button>
          </div>

          {activeTab === 'ballistics' && (
            <div className="flex items-center gap-1 border border-slate-700/80 bg-[#080d16]/94 p-0.5">
              {(
                [
                  { id: 'cutaway', label: 'Cutaway' },
                  { id: 'full_range', label: 'Full Range' },
                  { id: 'impact_plate', label: 'Impact Plate' },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleCameraPreset(p.id)}
                  className={`cursor-pointer whitespace-nowrap px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                    cameraPreset === p.id
                      ? 'bg-slate-200 font-semibold text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}

              <div className="mx-0.5 h-5 w-px bg-slate-700" />

              <button
                type="button"
                onClick={handleTestFire}
                className="cursor-pointer whitespace-nowrap bg-emerald-500 px-3.5 py-1.5 font-mono-tabular text-[11px] font-bold text-neutral-950 transition-colors hover:bg-emerald-400"
              >
                Test Fire
              </button>
              <button
                type="button"
                onClick={() => setSlowMo((s) => !s)}
                className={`cursor-pointer whitespace-nowrap border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                  slowMo
                    ? 'border-sky-400 bg-sky-500/20 font-semibold text-sky-200'
                    : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
                }`}
              >
                0.15× Slow-Mo
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer whitespace-nowrap border border-slate-700 bg-[#080d16]/94 px-4 py-2 font-mono-tabular text-xs font-medium text-neutral-100 transition-colors hover:border-amber-400 hover:text-amber-300"
          >
            Esc / E · Exit Bench
          </button>
        </div>
      </div>

      {/* ========================= MODIFY PARTS TAB ========================= */}
      {activeTab === 'modify' && (
        <>
          {/* 3D-Projected Socket Pins anchored over the firearm */}
          {pins.map((pin) => {
            if (!pin.visible) return null;
            const compat = getCompatibleAttachments(weaponId, pin.slot, attachments, true);
            if (compat.length === 0) return null;

            const currentPartId = attachments[pin.slot];
            const currentPart = currentPartId ? ATTACHMENTS[currentPartId] : null;
            const isSelected = selectedSlot === pin.slot;

            return (
              <button
                key={pin.slot}
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedSlot(isSelected ? null : pin.slot);
                }}
                style={{
                  transform: `translate3d(${pin.x.toFixed(1)}px, ${pin.y.toFixed(1)}px, 0) translate(-50%, -50%)`,
                }}
                className="fixed top-0 left-0 z-10 flex cursor-pointer items-center gap-1.5 text-left transition-colors focus:outline-none"
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center border ${
                    isSelected
                      ? 'border-amber-300 bg-amber-400'
                      : currentPart
                        ? 'border-amber-400/90 bg-neutral-950'
                        : 'border-neutral-400 bg-neutral-950/85'
                  }`}
                >
                  <span
                    className={`h-1 w-1 ${
                      isSelected
                        ? 'bg-neutral-950'
                        : currentPart
                          ? 'bg-amber-400'
                          : 'bg-neutral-300'
                    }`}
                  />
                </span>
                <span
                  className={`border px-2 py-0.5 font-mono-tabular text-[10px] leading-tight tracking-wider ${
                    isSelected
                      ? 'border-amber-400 bg-neutral-950/96 text-amber-200'
                      : currentPart
                        ? 'border-amber-500/60 bg-neutral-950/90 text-neutral-100 hover:border-amber-400'
                        : 'border-neutral-700/90 bg-neutral-950/86 text-neutral-300 hover:border-neutral-400'
                  }`}
                >
                  <span className="font-semibold">{pin.pinLabel}</span>
                  <span className="ml-1.5 text-neutral-400">
                    {currentPart ? currentPart.shortName : 'BARE'}
                  </span>
                </span>
              </button>
            );
          })}

          {/* Right-Side Slot Attachment Picker Drawer */}
          {selectedSlot && activeSlotMeta && (
            <div
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              className="fixed top-20 right-5 z-20 flex max-h-[calc(100vh-230px)] w-80 flex-col border border-neutral-800 bg-neutral-950/94 text-neutral-100"
            >
              <div className="flex items-center justify-between border-b border-neutral-800 px-3.5 py-2.5">
                <div>
                  <div className="font-mono-tabular text-[10px] tracking-widest text-amber-400">
                    Socket · {activeSlotMeta.pinLabel}
                  </div>
                  <div className="font-display text-sm font-semibold tracking-wide text-neutral-50">
                    {activeSlotMeta.title}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSlot(null)}
                  className="cursor-pointer border border-neutral-800 px-2 py-0.5 font-mono-tabular text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
                >
                  Close
                </button>
              </div>

              <div className="flex flex-col gap-1.5 overflow-y-auto p-3">
                {/* Reticle Color Picker: shown ONLY for red dots, holos & illuminated-reticle scopes */}
                {showReticleColorPicker && (selectedSlot === 'optic' || selectedSlot === 'canted') && (
                  <div className="mb-1 border border-neutral-800 bg-neutral-900/90 px-3 py-2">
                    <div className="flex items-center justify-between font-mono-tabular text-[10px] tracking-wider text-neutral-400">
                      <span>Emitter / Reticle Color</span>
                      <span className="text-amber-300">{activeReticleColor.toUpperCase()}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                      {RETICLE_COLOR_OPTIONS.map((opt) => {
                        const activeColor = activeReticleColor === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => onSelectReticleColor(selectedSlot, opt.id)}
                            className={`flex cursor-pointer items-center justify-center gap-1.5 border px-1.5 py-1 font-mono-tabular text-[10px] transition-colors ${
                              activeColor
                                ? 'border-amber-400 bg-neutral-950 text-neutral-50'
                                : 'border-neutral-800 bg-neutral-950/70 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                            }`}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{
                                backgroundColor: opt.swatch,
                              }}
                            />
                            <span>{opt.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Bare / Factory Strip Option */}
                <button
                  type="button"
                  onClick={() => onSelectAttachment(selectedSlot, null)}
                  className={`cursor-pointer border px-3 py-2 text-left transition-colors ${
                    !installedId
                      ? 'border-amber-400 bg-amber-500/12 text-amber-200'
                      : 'border-neutral-800 bg-neutral-900/70 text-neutral-300 hover:border-neutral-600'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono-tabular text-xs font-semibold">
                    <span>Factory Bare (None)</span>
                    {!installedId && <span className="text-[10px] text-amber-300">Mounted</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">
                    Remove {activeSlotMeta.pinLabel.toLowerCase()} attachment and restore baseline handling.
                  </div>
                </button>

                {compatibleForSlot.length === 0 ? (
                  <div className="border border-neutral-800/80 bg-neutral-900/50 px-3 py-3 font-mono-tabular text-xs text-neutral-500">
                    No compatible parts for this socket on {weaponName}.
                  </div>
                ) : (
                  compatibleForSlot.map((def) => {
                    const isMounted = installedId === def.id;
                    const badges = formatAttachmentBadges(def);
                    const attUnlocked = isAttachmentUnlocked ? isAttachmentUnlocked(def.id) : true;
                    const reqGunLv = getAttachmentRequiredGunLevel(def.id);
                    const reqAdapterId = getRequiredRailAdapterId(def, weaponId, attachments);
                    const reqAdapterDef = reqAdapterId ? ATTACHMENTS[reqAdapterId] ?? null : null;
                    const canMount =
                      activeWeaponUnlocked && !reqAdapterId && (attUnlocked || isMounted);

                    return (
                      <div
                        key={def.id}
                        className={`border px-3 py-2 text-left transition-colors ${
                          reqAdapterId
                            ? 'border-amber-500/40 bg-neutral-950/85 text-neutral-300'
                            : !canMount
                              ? 'border-neutral-800/70 bg-neutral-950/70 text-neutral-500 opacity-70'
                              : isMounted
                                ? 'border-amber-400 bg-amber-500/14 text-neutral-50'
                                : 'border-neutral-800 bg-neutral-900/75 text-neutral-200 hover:border-neutral-500'
                        }`}
                      >
                        <button
                          type="button"
                          disabled={!canMount}
                          onClick={() => {
                            if (!canMount) return;
                            onSelectAttachment(selectedSlot, isMounted ? null : def.id);
                          }}
                          className={`w-full text-left ${canMount ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono-tabular text-xs font-semibold text-neutral-50">
                              {def.name}
                            </span>
                            {isMounted ? (
                              <span className="shrink-0 font-mono-tabular text-[10px] font-semibold text-amber-300">
                                Mounted
                              </span>
                            ) : reqAdapterDef ? (
                              <span className="flex shrink-0 items-center gap-1 font-mono-tabular text-[10px] text-amber-400">
                                <Lock className="h-3 w-3" />
                                Needs {reqAdapterDef.shortName}
                              </span>
                            ) : !attUnlocked ? (
                              <span className="flex shrink-0 items-center gap-1 font-mono-tabular text-[10px] text-red-400">
                                <Lock className="h-3 w-3" />
                                Gun Lv.{reqGunLv}
                              </span>
                            ) : (
                              <span className="shrink-0 font-mono-tabular text-[10px] text-emerald-400/90">
                                Available
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[11px] leading-snug text-neutral-400">
                            {def.description}
                          </p>
                          {badges.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono-tabular text-[10px] text-slate-300">
                              {badges.map((tag, idx) => (
                                <span key={tag}>
                                  {idx > 0 && <span className="mr-2 text-slate-600">·</span>}
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                        {reqAdapterDef && activeWeaponUnlocked && (
                          <button
                            type="button"
                            onClick={() => onSelectAttachment('railAdapter', reqAdapterDef.id)}
                            className="mt-2 w-full cursor-pointer border border-amber-400/80 bg-amber-500/15 px-2 py-1 font-mono-tabular text-[10px] font-semibold text-amber-200 transition-colors hover:bg-amber-500/25"
                          >
                            Mount {reqAdapterDef.shortName} Adapter First
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Bottom Dock: 7-Category 42-Weapon Armory + Cartridge Loader + Ballistic Telemetry */}
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="fixed right-5 bottom-3 left-5 z-20 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between"
          >
            {/* Left/Center Armory & Ammunition Selector */}
            <div className="flex max-w-4xl flex-col gap-1.5 border border-neutral-800 bg-neutral-950/92 p-2">
              {/* Row 1: 7 Firearm Categories + Strip Bare */}
              <div className="flex flex-wrap items-center gap-1">
                {WEAPON_CATEGORY_META.map((cat) => {
                  const catActive = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveCategory(cat.id)}
                      className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] font-semibold tracking-wider transition-colors ${
                        catActive
                          ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                      }`}
                    >
                      {cat.shortLabel}
                    </button>
                  );
                })}

                <div className="mx-1 h-4 w-px bg-neutral-800" />

                <button
                  type="button"
                  disabled={!hasAnyAttachment}
                  onClick={onStripAll}
                  className={`border px-2.5 py-1 font-mono-tabular text-[10px] tracking-wider transition-colors ${
                    hasAnyAttachment
                      ? 'cursor-pointer border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-red-500/70 hover:text-red-300'
                      : 'cursor-not-allowed border-neutral-900 bg-neutral-950 text-neutral-600'
                  }`}
                >
                  Strip Bare
                </button>
              </div>

              {/* Row 2: Firearms in Selected Category */}
              <div className="flex flex-wrap items-center gap-1">
                {categoryWeapons.map((w) => {
                  const active = w.id === weaponId;
                  const unlocked = isWeaponUnlocked ? isWeaponUnlocked(w.id) : true;
                  const reqRank = getWeaponUnlockRank(w.id);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => onSelectWeapon(w.id)}
                      className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1 font-mono-tabular text-[11px] transition-colors ${
                        active
                          ? 'border-amber-400 bg-amber-500 font-semibold text-neutral-950'
                          : unlocked
                            ? 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600 hover:text-neutral-50'
                            : 'border-neutral-900 bg-neutral-950/90 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300'
                      }`}
                    >
                      {!unlocked && <Lock className="h-3 w-3 shrink-0 opacity-80" />}
                      <span>{w.name}</span>
                      {!unlocked && (
                        <span
                          className={
                            active ? 'text-[9px] text-neutral-900' : 'text-[9px] text-neutral-500'
                          }
                        >
                          R{reqRank}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Row 3: Ammunition Variant Loader */}
              {ammoVariants.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 border-t border-neutral-800/80 pt-1.5">
                  <span className="mr-1 font-mono-tabular text-[10px] tracking-wider text-neutral-500">
                    Ammo:
                  </span>
                  {ammoVariants.map((variant) => {
                    const selected = variant.id === activeAmmoVariantId;
                    const velMps = Math.round(
                      variant.baseVelocityMs *
                        (activeProfile.barrelVelocityMult ?? 1.0) *
                        stats.velocityMult,
                    );
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => onSelectAmmoVariant(variant.id)}
                        className={`flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 font-mono-tabular text-[10px] transition-colors ${
                          selected
                            ? 'border-sky-400 bg-sky-500/18 text-sky-100'
                            : 'border-neutral-800 bg-neutral-900/90 text-neutral-300 hover:border-neutral-600'
                        }`}
                      >
                        <span className="font-semibold">{variant.shortName}</span>
                        <span className="text-neutral-400">
                          {variant.bulletMassGrams}g · {velMps}m/s · BC{' '}
                          {variant.ballisticCoefficient.toFixed(2)}
                        </span>
                        <span className="text-[9px] text-amber-300">
                          {coreBadgeLabel(variant.coreType)}
                        </span>
                        {variant.isSubsonic && (
                          <span className="text-[9px] text-emerald-300">SUB</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Live Telemetry Readout */}
            <div className="grid grid-cols-4 gap-x-4 gap-y-1.5 border border-neutral-800 bg-neutral-950/92 px-3.5 py-2.5 font-mono-tabular text-[11px]">
              <div>
                <div className="text-[9px] text-neutral-500">Mass</div>
                <div className="text-neutral-100">{stats.totalMassKg.toFixed(2)} kg</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Ergo</div>
                <div className="text-amber-300">{stats.ergonomics} / 100</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Muzzle Vel</div>
                <div className="text-sky-300">{Math.round(effectiveVelMps)} m/s</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Energy</div>
                <div className="text-neutral-100">{Math.round(effectiveEnergyJ)} J</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Capacity</div>
                <div className="text-neutral-100">{stats.magCapacity} rds</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Recoil</div>
                <div className="text-neutral-100">{Math.round(stats.recoilPitchMult * 100)}%</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Optic</div>
                <div className="text-neutral-100">
                  {stats.opticZoomLevels.length > 1
                    ? `${stats.opticZoomLevels[0]}–${stats.opticZoomLevels[stats.opticZoomLevels.length - 1]}x`
                    : stats.adsZoomFactor >= 1.5
                      ? `${stats.adsZoomFactor.toFixed(1)}x`
                      : '1.0x'}
                </div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500">Systems</div>
                <div className="text-[10px] text-neutral-200">
                  {[
                    stats.hasFlashlight ? 'Light' : null,
                    stats.hasLaser ? 'Laser' : null,
                    stats.isSuppressed ? 'Supp' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Iron'}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ==================== ZERO & BALLISTICS WIREFRAME SIM TAB ==================== */}
      {activeTab === 'ballistics' && trajectoryProfile && penetrationResult && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          className="fixed right-5 bottom-3 left-5 z-20 flex flex-col items-center"
        >
          {/* Collapse / Expand Dock Handle */}
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            className="mb-1 cursor-pointer border border-slate-700/80 bg-[#080d16]/94 px-3 py-0.5 font-mono-tabular text-[10px] text-slate-300 hover:border-slate-500 hover:text-white"
          >
            {dockCollapsed ? '▴ Show Ballistics Controls' : '▾ Hide Controls'}
          </button>

          {!dockCollapsed && (
            <div className="grid w-full grid-cols-1 gap-2.5 border border-slate-700/80 bg-[#070c15]/95 p-3 text-slate-100 xl:grid-cols-12">
              {/* Column 1: Zeroing Turrets, HOB & Caliber/Ammo Controls */}
              <div className="flex flex-col gap-2 xl:col-span-4 xl:border-r xl:border-slate-800 xl:pr-3">
                <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                  <span className="font-semibold text-white">Zeroing &amp; Elevation Turret</span>
                  <span className="text-slate-400">
                    HOB {(heightOverBoreM * 1000).toFixed(0)}mm · Near{' '}
                    {trajectoryProfile.nearZeroM !== null
                      ? `${Math.round(trajectoryProfile.nearZeroM)}m`
                      : '—'}{' '}
                    · Far{' '}
                    {trajectoryProfile.farZeroM !== null
                      ? `${Math.round(trajectoryProfile.farZeroM)}m`
                      : `${effectiveZeroDistM}m`}
                  </span>
                </div>

                {/* Zero distance presets */}
                <div className="flex flex-wrap gap-1">
                  {zeroPresets.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => handleSetZeroDistance(d)}
                      className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] transition-colors ${
                        effectiveZeroDistM === d
                          ? 'border-sky-400 bg-sky-500/20 font-semibold text-sky-100'
                          : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {d}m
                    </button>
                  ))}
                </div>

                {/* Elevation MRAD click turret */}
                <div className="flex items-center gap-1.5 font-mono-tabular text-[11px]">
                  <span className="text-slate-400">Turret Dial:</span>
                  <button
                    type="button"
                    onClick={() => handleAdjustElevation(effectiveElevationMrad - 0.5)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-slate-500"
                  >
                    -0.5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustElevation(effectiveElevationMrad - 0.1)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-slate-500"
                  >
                    -0.1
                  </button>
                  <span className="min-w-[74px] text-center font-semibold text-sky-300">
                    {effectiveElevationMrad >= 0 ? '+' : ''}
                    {effectiveElevationMrad.toFixed(1)} MRAD
                  </span>
                  <button
                    type="button"
                    onClick={() => handleAdjustElevation(effectiveElevationMrad + 0.1)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-slate-500"
                  >
                    +0.1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustElevation(effectiveElevationMrad + 0.5)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-slate-500"
                  >
                    +0.5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustElevation(0)}
                    className="cursor-pointer border border-slate-800 px-2 py-0.5 text-[10px] text-slate-400 hover:border-slate-600 hover:text-white"
                  >
                    Reset
                  </button>
                </div>

                {/* Modular Caliber Conversions (when supported on firearm) */}
                {caliberConversions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 border-t border-slate-800/80 pt-1.5 font-mono-tabular text-[10px]">
                    <span className="text-slate-400">Caliber Kit:</span>
                    <button
                      type="button"
                      onClick={() => onSelectAttachment('magazine', null)}
                      className={`cursor-pointer border px-2 py-0.5 ${
                        !attachments.magazine
                          ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                          : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      Factory Base
                    </button>
                    {caliberConversions.map((conv) => (
                      <button
                        key={conv.id}
                        type="button"
                        onClick={() => onSelectAttachment('magazine', conv.id)}
                        className={`cursor-pointer border px-2 py-0.5 ${
                          attachments.magazine === conv.id
                            ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                            : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        {conv.shortName}
                      </button>
                    ))}
                  </div>
                )}

                {/* Ammo Variant Selector */}
                <div className="flex flex-wrap items-center gap-1 border-t border-slate-800/80 pt-1.5">
                  {ammoVariants.map((variant) => {
                    const selected = variant.id === activeAmmoVariantId;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => onSelectAmmoVariant(variant.id)}
                        className={`cursor-pointer border px-2 py-0.5 font-mono-tabular text-[10px] transition-colors ${
                          selected
                            ? 'border-sky-400 bg-sky-500/20 font-semibold text-sky-100'
                            : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        {variant.shortName} · {coreBadgeLabel(variant.coreType)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Column 2: Ballistic Material Penetration Tester */}
              <div className="flex flex-col gap-2 xl:col-span-4 xl:border-r xl:border-slate-800 xl:pr-3">
                <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                  <span className="font-semibold text-white">Terminal Material Penetration</span>
                  <span
                    className={`font-bold ${
                      penetrationResult.outcome === 'penetrate'
                        ? 'text-emerald-400'
                        : penetrationResult.outcome === 'ricochet'
                          ? 'text-amber-300'
                          : penetrationResult.outcome === 'fragment'
                            ? 'text-orange-400'
                            : 'text-red-400'
                    }`}
                  >
                    {penetrationResult.outcome === 'penetrate'
                      ? 'PENETRATE'
                      : penetrationResult.outcome === 'ricochet'
                        ? 'RICOCHET'
                        : penetrationResult.outcome === 'fragment'
                          ? 'FRAGMENT / SPALL'
                          : 'STOPPED'}
                  </span>
                </div>

                {/* Material Plate Selector */}
                <div className="flex flex-wrap gap-1">
                  {BALLISTICS_TEST_MATERIALS.map((mat, idx) => (
                    <button
                      key={mat.id}
                      type="button"
                      onClick={() => setSelectedMaterialIdx(idx)}
                      className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] transition-colors ${
                        idx === selectedMaterialIdx
                          ? 'border-white bg-white/14 font-semibold text-white'
                          : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {mat.label}
                    </button>
                  ))}
                </div>

                {/* Range & Obliquity Angle Sliders */}
                <div className="grid grid-cols-2 gap-3 font-mono-tabular text-[10px]">
                  <label className="flex flex-col gap-1">
                    <span className="flex justify-between text-slate-400">
                      <span>Target Distance</span>
                      <span className="text-white">{testRangeM} m</span>
                    </span>
                    <input
                      type="range"
                      min={25}
                      max={maxSimRangeM}
                      step={5}
                      value={testRangeM}
                      onChange={(e) => setTestRangeM(Number(e.target.value))}
                      className="accent-sky-400"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="flex justify-between text-slate-400">
                      <span>Impact Obliquity</span>
                      <span className="text-white">{obliquityDeg}°</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={75}
                      step={5}
                      value={obliquityDeg}
                      onChange={(e) => setObliquityDeg(Number(e.target.value))}
                      className="accent-sky-400"
                    />
                  </label>
                </div>

                {/* Penetration Telemetry Row */}
                <div className="grid grid-cols-4 gap-2 border-t border-slate-800/80 pt-1.5 font-mono-tabular text-[10px]">
                  <div>
                    <div className="text-slate-500">Impact Vel</div>
                    <div className="text-slate-100">
                      {Math.round(penetrationResult.impactSpeedMs)} m/s
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Exit Vel</div>
                    <div className="text-emerald-300">
                      {Math.round(penetrationResult.exitSpeedMs)} m/s
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Depth / Eff</div>
                    <div className="text-slate-100">
                      {penetrationResult.penetrationDepthCm.toFixed(1)} /{' '}
                      {penetrationResult.effectiveThicknessCm.toFixed(1)}cm
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Crit Skip</div>
                    <div className="text-amber-300">
                      {penetrationResult.criticalRicochetDeg.toFixed(0)}° graz.
                    </div>
                  </div>
                </div>
              </div>

              {/* Column 3: Range-Gate Ballistic Table + Green-to-Red Lethality Legend */}
              <div className="flex flex-col gap-1.5 xl:col-span-4">
                <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                  <span className="font-semibold text-white">Range-Gate Ballistics</span>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                    <span>Damage:</span>
                    <span className="text-emerald-400">100%</span>
                    <span
                      className="inline-block h-1.5 w-16"
                      style={{
                        background:
                          'linear-gradient(90deg, #22c55e 0%, #eab308 42%, #f97316 74%, #ef4444 100%)',
                      }}
                    />
                    <span className="text-red-400">Low</span>
                  </div>
                </div>

                <div className="max-h-28 overflow-y-auto border border-slate-800/80 bg-[#050911]">
                  <table className="w-full border-collapse font-mono-tabular text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-slate-400">
                        <th className="px-2 py-1 font-medium">Range</th>
                        <th className="px-2 py-1 font-medium">Drop</th>
                        <th className="px-2 py-1 font-medium">Hold</th>
                        <th className="px-2 py-1 font-medium">Vel</th>
                        <th className="px-2 py-1 font-medium">Energy</th>
                        <th className="px-2 py-1 font-medium">Dmg</th>
                        <th className="px-2 py-1 font-medium">ToF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trajectoryProfile.rangeGates.map((g) => (
                        <tr
                          key={g.distanceM}
                          className={`border-b border-slate-900/90 ${
                            g.distanceM === effectiveZeroDistM
                              ? 'bg-sky-500/12 text-white'
                              : 'text-slate-300'
                          }`}
                        >
                          <td className="px-2 py-0.5 font-semibold">{g.label}</td>
                          <td className="px-2 py-0.5">
                            {g.dropCm >= 0 ? '+' : ''}
                            {g.dropCm.toFixed(1)}cm
                          </td>
                          <td className="px-2 py-0.5 text-sky-300">
                            {g.dropMrad >= 0 ? '+' : ''}
                            {g.dropMrad.toFixed(1)}m
                          </td>
                          <td className="px-2 py-0.5">{Math.round(g.velocityMs)}</td>
                          <td className="px-2 py-0.5">{Math.round(g.energyJ)}J</td>
                          <td className={`px-2 py-0.5 font-semibold ${damageColorClass(g.damageRatio)}`}>
                            {Math.round(g.damageRatio * 100)}%
                          </td>
                          <td className="px-2 py-0.5 text-slate-400">{Math.round(g.tofMs)}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
