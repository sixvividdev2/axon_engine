import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crosshair,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  RotateCcw,
  Shield,
  Sliders,
  X,
} from 'lucide-react';
import {
  BALLISTICS_TEST_MATERIALS,
  BallisticsCameraPreset,
  BallisticsSimViewport,
} from '../arena/BallisticsSimViewport';
import { CadGunsmithStage } from '../arena/CadGunsmithStage';
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
  computeDerivedWeaponStats,
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
  resolveBaseCaliberId,
} from '../data/calibers';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  useGraphicsQuality,
} from '../data/graphicsQuality';
import { loadoutStore, useLoadoutStore } from '../data/loadoutStore';
import {
  getAttachmentRequiredGunLevel,
  getWeaponUnlockRank,
  MAX_GUN_LEVEL,
  WeaponProgressRecord,
  xpRequiredForNextGunLevel,
} from '../data/progression';
import {
  TACTICAL_BELT_SLOTS,
  TACTICAL_EQUIPMENT_LIST,
} from '../data/tacticalEquipment';

type WorkbenchTab = 'workbench' | 'ballistics';
type ActiveGearFocus = 'primary' | 'secondary';

export interface GymBenchBridgeProps {
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
}

interface UnifiedLoadoutWorkbenchProps {
  /** If provided, runs as an overlay over the live Gym 3D Gunsmith Bench; otherwise mounts standalone CadGunsmithStage */
  gymBridge?: GymBenchBridgeProps | null;
  careerRank?: number;
  getWeaponProgress?: (weaponId: string) => WeaponProgressRecord | undefined;
  isWeaponUnlocked?: (weaponId: string) => boolean;
  isAttachmentUnlocked?: (attachmentId: string) => boolean;
  onClose?: () => void;
  closeLabel?: string;
}

function formatAttachmentBadges(def: AttachmentDef): string[] {
  const tags: string[] = [];
  if (def.caliberOverride) tags.push(`CAL → ${def.caliberOverride.toUpperCase()}`);
  if (def.grantsPicatinnyRail) tags.push('Picatinny Bridge');
  if (def.velocityMult && Math.abs(def.velocityMult - 1) > 0.005) {
    const pct = Math.round((def.velocityMult - 1) * 100);
    tags.push(`${pct > 0 ? '+' : ''}${pct}% Vel`);
  }
  if (def.massKg !== 0) tags.push(`${def.massKg > 0 ? '+' : ''}${def.massKg.toFixed(2)}kg`);
  if (def.ergonomicsDelta !== 0)
    tags.push(`${def.ergonomicsDelta > 0 ? '+' : ''}${def.ergonomicsDelta} Ergo`);
  if (def.recoilPitchMult < 0.99)
    tags.push(`-${Math.round((1 - def.recoilPitchMult) * 100)}% Recoil`);
  if (def.zoomLevels && def.zoomLevels.length > 1) {
    tags.push(`${def.zoomLevels[0]}–${def.zoomLevels[def.zoomLevels.length - 1]}x Var`);
  } else if (def.adsZoomFactor && def.adsZoomFactor >= 1.5) {
    tags.push(`${def.adsZoomFactor.toFixed(1)}x Zoom`);
  }
  if (def.isSuppressor) tags.push('Suppressed');
  if (def.enablesFlashlight) tags.push('Light');
  if (def.enablesLaser) tags.push('Laser');
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

function playSynthTurretClick(up: boolean): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(up ? 1680 : 1240, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(340, ctx.currentTime + 0.032);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.036);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.04);
    window.setTimeout(() => void ctx.close(), 120);
  } catch {
    // Ignore audio context block
  }
}

export const UnifiedLoadoutWorkbench: React.FC<UnifiedLoadoutWorkbenchProps> = ({
  gymBridge,
  careerRank = 1,
  getWeaponProgress,
  isWeaponUnlocked,
  isAttachmentUnlocked,
  onClose,
  closeLabel = 'Close Workbench',
}) => {
  const loadoutState = useLoadoutStore();
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const activeSlot = loadoutState.slots[loadoutState.activeIndex] ?? loadoutState.slots[0];

  const [activeTab, setActiveTab] = useState<WorkbenchTab>('workbench');
  const [gearFocus, setGearFocus] = useState<ActiveGearFocus>('primary');
  const [selectedSlot, setSelectedSlot] = useState<AttachmentSlot>('optic');
  const [armoryOpen, setArmoryOpen] = useState<boolean>(false);
  const [zenInspect, setZenInspect] = useState<boolean>(false);
  const [editingSlotIdx, setEditingSlotIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');

  // Standalone 3D CAD Gunsmith Stage refs & projected pins
  const cadContainerRef = useRef<HTMLDivElement | null>(null);
  const cadStageRef = useRef<CadGunsmithStage | null>(null);
  const [standalonePins, setStandalonePins] = useState<GunsmithPinProjection[]>([]);
  const [standaloneHobM, setStandaloneHobM] = useState<number>(0.056);

  // Orbit pointer drag
  const draggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Ballistics Sim Viewport refs & state
  const ballisticsMountRef = useRef<HTMLDivElement | null>(null);
  const ballisticsSimRef = useRef<BallisticsSimViewport | null>(null);
  const [simMaterialIdx, setSimMaterialIdx] = useState<number>(2);
  const [simRangeM, setSimRangeM] = useState<number>(150);
  const [simObliquityDeg, setSimObliquityDeg] = useState<number>(0);
  const [simCamPreset, setSimCamPreset] = useState<BallisticsCameraPreset>('cutaway');
  const [simDockCollapsed, setSimDockCollapsed] = useState<boolean>(false);

  // Resolve active firearm state (Gym Bridge vs. Standalone LoadoutStore)
  const focusedWeaponId = gymBridge
    ? gymBridge.weaponId
    : gearFocus === 'primary'
      ? activeSlot.primaryWeaponId
      : activeSlot.secondaryWeaponId;

  const activeProfile = useMemo(() => resolveWeaponProfile(focusedWeaponId), [focusedWeaponId]);
  const storedBuild = useMemo(
    () => loadoutStore.getWeaponBuild(loadoutState.activeIndex, focusedWeaponId),
    [loadoutState, focusedWeaponId],
  );

  const activeAttachments: WeaponAttachments = gymBridge
    ? gymBridge.attachments
    : storedBuild.attachments;

  const activeStats: DerivedWeaponStats = useMemo(() => {
    if (gymBridge) return gymBridge.stats;
    return computeDerivedWeaponStats(
      activeProfile.massKg,
      activeProfile.barrelLengthM,
      activeProfile.magCapacity,
      activeAttachments,
    );
  }, [gymBridge, activeProfile, activeAttachments]);

  const activeCaliberId: BaseCaliberId = useMemo(() => {
    if (gymBridge) return gymBridge.activeCaliberId;
    if (activeStats.caliberOverride) return activeStats.caliberOverride;
    return resolveBaseCaliberId(activeProfile.defaultCaliberId);
  }, [gymBridge, activeStats.caliberOverride, activeProfile.defaultCaliberId]);

  const activeAmmoVariantId: AmmoVariantId = gymBridge
    ? gymBridge.activeAmmoVariantId
    : storedBuild.ammoVariantId;

  const zeroDistanceM = gymBridge
    ? (gymBridge.zeroDistanceM ?? getDefaultZeroDistanceM(activeProfile.category))
    : storedBuild.zeroDistanceM;

  const zeroElevationMrad = gymBridge
    ? (gymBridge.zeroElevationMrad ?? 0)
    : storedBuild.zeroElevationMrad;

  const heightOverBoreM = gymBridge ? (gymBridge.heightOverBoreM ?? 0.056) : standaloneHobM;

  const activePins = gymBridge ? gymBridge.pins : standalonePins;

  // Armory category filter
  const [activeCategory, setActiveCategory] = useState<WeaponCategory>(
    () => activeProfile.category ?? 'carbines',
  );
  useEffect(() => {
    if (activeProfile.category) {
      setActiveCategory(activeProfile.category);
    }
  }, [activeProfile.category]);

  const categoryWeapons = useMemo(() => getWeaponsByCategory(activeCategory), [activeCategory]);
  const ammoVariants = useMemo(
    () => getAmmoVariantsForCaliber(activeCaliberId),
    [activeCaliberId],
  );
  const activeAmmoDef = AMMO_VARIANTS[activeAmmoVariantId] ?? ammoVariants[0];

  const effectiveVelMps = useMemo(() => {
    const baseVel = activeAmmoDef?.baseVelocityMs ?? activeProfile.muzzleVelocityMps;
    return baseVel * (activeProfile.barrelVelocityMult ?? 1.0) * activeStats.velocityMult;
  }, [activeAmmoDef, activeProfile, activeStats.velocityMult]);

  const effectiveEnergyJ = useMemo(() => {
    const kg = (activeAmmoDef?.bulletMassGrams ?? activeProfile.bulletMassGrams) / 1000;
    return 0.5 * kg * effectiveVelMps * effectiveVelMps;
  }, [activeAmmoDef, activeProfile, effectiveVelMps]);

  const compatibleForSlot = useMemo(
    () => getCompatibleAttachments(focusedWeaponId, selectedSlot),
    [focusedWeaponId, selectedSlot],
  );

  const hasAnyAttachment = useMemo(
    () =>
      Boolean(
        activeAttachments.railAdapter ||
          activeAttachments.optic ||
          activeAttachments.canted ||
          activeAttachments.muzzle ||
          activeAttachments.tactical ||
          activeAttachments.foregrip ||
          activeAttachments.magazine,
      ),
    [activeAttachments],
  );

  // Mount / tear down Standalone CAD 3D Gunsmith Stage when not in Gym Bridge and on Workbench tab
  useEffect(() => {
    if (gymBridge || activeTab !== 'workbench') {
      if (cadStageRef.current) {
        cadStageRef.current.dispose();
        cadStageRef.current = null;
      }
      return;
    }
    const el = cadContainerRef.current;
    if (!el) return;

    const stage = new CadGunsmithStage({
      container: el,
      initialWeaponId: focusedWeaponId,
      initialAttachments: activeAttachments,
      onPinsUpdate: (pins) => setStandalonePins(pins),
    });
    cadStageRef.current = stage;
    setStandaloneHobM(stage.getHeightOverBoreM());

    return () => {
      stage.dispose();
      cadStageRef.current = null;
    };
  }, [gymBridge, activeTab]);

  // Keep standalone CAD bench weapon synced live
  useEffect(() => {
    const stage = cadStageRef.current;
    if (!stage) return;
    stage.setShowcaseWeapon(activeProfile, activeAttachments);
    stage.setShowcaseTurretElevation(zeroElevationMrad);
    setStandaloneHobM(stage.getHeightOverBoreM());
  }, [activeProfile, activeAttachments, zeroElevationMrad]);

  // Ballistics Trajectory & Material Penetration computation
  const maxSimRangeM = useMemo(
    () => getBallisticSimMaxRangeM(activeProfile.category),
    [activeProfile.category],
  );
  useEffect(() => {
    setSimRangeM((prev) => Math.min(maxSimRangeM, Math.max(25, prev)));
  }, [maxSimRangeM]);

  const zeroPresets = useMemo(
    () => getZeroDistancePresets(activeProfile.category),
    [activeProfile.category],
  );

  const trajectoryProfile = useMemo(() => {
    if (!activeAmmoDef) return null;
    return simulateTrajectoryProfile({
      ammo: activeAmmoDef,
      barrelVelocityMult: activeProfile.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: activeStats.velocityMult,
      heightOverBoreM,
      zeroDistanceM,
      extraElevationMrad: zeroElevationMrad,
      maxRangeM: maxSimRangeM,
      sampleStepM: Math.max(2, Math.round(maxSimRangeM / 110)),
    });
  }, [
    activeAmmoDef,
    activeProfile.barrelVelocityMult,
    activeStats.velocityMult,
    heightOverBoreM,
    zeroDistanceM,
    zeroElevationMrad,
    maxSimRangeM,
  ]);

  const simMaterial = BALLISTICS_TEST_MATERIALS[simMaterialIdx] ?? BALLISTICS_TEST_MATERIALS[2];

  const penetrationResult = useMemo(() => {
    if (!activeAmmoDef || !trajectoryProfile || trajectoryProfile.points.length === 0) return null;
    const sample =
      trajectoryProfile.points.reduce((best, cur) =>
        Math.abs(cur.distanceM - simRangeM) < Math.abs(best.distanceM - simRangeM) ? cur : best,
      ) ?? trajectoryProfile.points[0];
    return simulateMaterialPenetration({
      ammo: activeAmmoDef,
      impactSpeedMs: sample.velocityMs,
      material: simMaterial.materialId,
      thicknessM: simMaterial.thicknessM,
      obliquityDeg: simObliquityDeg,
      barrelVelocityMult: activeProfile.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: activeStats.velocityMult,
    });
  }, [
    activeAmmoDef,
    trajectoryProfile,
    simRangeM,
    simMaterial,
    simObliquityDeg,
    activeProfile.barrelVelocityMult,
    activeStats.velocityMult,
  ]);

  // Mount / update Military Wireframe 3D Ballistics Viewport on Zero & Ballistics tab
  useEffect(() => {
    if (activeTab !== 'ballistics') {
      if (ballisticsSimRef.current) {
        ballisticsSimRef.current.dispose();
        ballisticsSimRef.current = null;
      }
      return;
    }
    const el = ballisticsMountRef.current;
    if (!el) return;
    const sim = new BallisticsSimViewport(el);
    ballisticsSimRef.current = sim;
    return () => {
      sim.dispose();
      ballisticsSimRef.current = null;
    };
  }, [activeTab]);

  useEffect(() => {
    const sim = ballisticsSimRef.current;
    if (!sim || !trajectoryProfile || !penetrationResult) return;
    sim.updateConfig({
      profile: activeProfile,
      attachments: activeAttachments,
      trajectory: trajectoryProfile,
      penetration: penetrationResult,
      testMaterial: simMaterial,
      testRangeM: simRangeM,
      obliquityDeg: simObliquityDeg,
      zeroElevationMrad,
      isSuppressed: activeStats.isSuppressed,
    });
  }, [
    activeTab,
    activeProfile,
    activeAttachments,
    trajectoryProfile,
    penetrationResult,
    simMaterial,
    simRangeM,
    simObliquityDeg,
    zeroElevationMrad,
    activeStats.isSuppressed,
  ]);

  useEffect(() => {
    ballisticsSimRef.current?.setCameraPreset(simCamPreset);
  }, [simCamPreset]);

  // Handlers bridging Gym vs LoadoutStore
  const handleSelectWeapon = (wid: string) => {
    if (isWeaponUnlocked && !isWeaponUnlocked(wid)) return;
    const prof = resolveWeaponProfile(wid);
    const isSidearm = prof.category === 'pistols' || prof.category === 'revolvers';
    if (gymBridge) {
      gymBridge.onSelectWeapon(wid);
    } else {
      if (gearFocus === 'secondary' || isSidearm) {
        loadoutStore.setSlotSecondaryWeapon(loadoutState.activeIndex, wid);
        setGearFocus('secondary');
      } else {
        loadoutStore.setSlotPrimaryWeapon(loadoutState.activeIndex, wid);
        setGearFocus('primary');
      }
    }
  };

  const handleSelectAttachment = (slot: AttachmentSlot, attachmentId: string | null) => {
    if (attachmentId && isAttachmentUnlocked && !isAttachmentUnlocked(attachmentId)) return;
    if (gymBridge) {
      gymBridge.onSelectAttachment(slot, attachmentId);
    }
    loadoutStore.setWeaponAttachment(loadoutState.activeIndex, focusedWeaponId, slot, attachmentId);
  };

  const handleSelectReticleColor = (slot: 'optic' | 'canted', colorId: ReticleColorId) => {
    if (gymBridge) {
      gymBridge.onSelectReticleColor(slot, colorId);
    }
    loadoutStore.setWeaponReticleColor(loadoutState.activeIndex, focusedWeaponId, slot, colorId);
  };

  const handleSelectAmmo = (variantId: AmmoVariantId) => {
    if (gymBridge) {
      gymBridge.onSelectAmmoVariant(variantId);
    }
    loadoutStore.updateWeaponBuild(loadoutState.activeIndex, focusedWeaponId, (prev) => ({
      ...prev,
      ammoVariantId: variantId,
    }));
  };

  const handleSetZeroDist = (distM: number) => {
    if (gymBridge?.onSelectZeroDistance) {
      gymBridge.onSelectZeroDistance(distM);
    }
    loadoutStore.updateWeaponBuild(loadoutState.activeIndex, focusedWeaponId, (prev) => ({
      ...prev,
      zeroDistanceM: distM,
      zeroElevationMrad: 0,
    }));
    if (gymBridge?.onTurretClickSound) gymBridge.onTurretClickSound(true);
    else playSynthTurretClick(true);
  };

  const handleStepElevation = (deltaMrad: number) => {
    const next = Math.max(-12, Math.min(20, Number((zeroElevationMrad + deltaMrad).toFixed(1))));
    if (gymBridge?.onAdjustElevationMrad) {
      gymBridge.onAdjustElevationMrad(next);
    }
    loadoutStore.updateWeaponBuild(loadoutState.activeIndex, focusedWeaponId, (prev) => ({
      ...prev,
      zeroElevationMrad: next,
    }));
    if (gymBridge?.onTurretClickSound) gymBridge.onTurretClickSound(deltaMrad >= 0);
    else playSynthTurretClick(deltaMrad >= 0);
  };

  const handleStripAll = () => {
    if (gymBridge) gymBridge.onStripAll();
    loadoutStore.stripWeaponAttachments(loadoutState.activeIndex, focusedWeaponId);
  };

  const handleOrbit = (dx: number, dy: number) => {
    if (gymBridge) gymBridge.onOrbit(dx, dy);
    else cadStageRef.current?.orbit(dx, dy);
  };

  const handleZoom = (deltaY: number) => {
    if (gymBridge) gymBridge.onZoom(deltaY);
    else cadStageRef.current?.zoom(deltaY);
  };

  const handlePointerDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  };
  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    handleOrbit(dx, dy);
  };
  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const primaryProfile = resolveWeaponProfile(activeSlot.primaryWeaponId);
  const secondaryProfile = resolveWeaponProfile(activeSlot.secondaryWeaponId);
  const weaponProg = getWeaponProgress ? getWeaponProgress(focusedWeaponId) : undefined;
  const activeWeaponUnlocked = isWeaponUnlocked ? isWeaponUnlocked(focusedWeaponId) : true;

  return (
    <div
      className={`fixed inset-0 z-40 flex flex-col select-none text-slate-100 ${
        gymBridge ? 'bg-transparent' : 'bg-[#070c14]'
      }`}
    >
      {/* ==================== CENTER 3D VIEWPORT LAYER ==================== */}
      {activeTab === 'workbench' ? (
        <div
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onWheel={(e) => handleZoom(e.deltaY)}
          className="fixed inset-0 z-0 cursor-grab active:cursor-grabbing"
        >
          {/* Standalone Military CAD Wireframe Studio + True-PBR Gunsmith Bench */}
          {!gymBridge && <div ref={cadContainerRef} className="h-full w-full" />}

          {/* Subtle CAD Hairline Crosshair Brackets (unobtrusive frame) */}
          <div className="pointer-events-none fixed inset-x-0 top-14 bottom-0">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 font-mono-tabular text-[10px] tracking-[0.22em] text-sky-300/60">
              CAD WORKBENCH · TRUE-PBR HARDWARE · DRAG TO ORBIT · SCROLL TO ZOOM
            </div>
          </div>

          {/* 3D Projected Attachment Callout Pins */}
          {!zenInspect &&
            activePins.map((pin) => {
              if (!pin.visible) return null;
              const isSelected = selectedSlot === pin.slot;
              const mountedId = activeAttachments[pin.slot];
              return (
                <button
                  key={pin.slot}
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setSelectedSlot(pin.slot)}
                  style={{
                    transform: `translate3d(${Math.round(pin.x)}px, ${Math.round(pin.y)}px, 0) translate(-50%, -50%)`,
                  }}
                  className={`fixed top-0 left-0 z-10 flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 font-mono-tabular text-[10px] font-semibold tracking-wider transition-colors ${
                    isSelected
                      ? 'border-sky-400 bg-[#071322]/95 text-sky-200'
                      : mountedId
                        ? 'border-amber-400/75 bg-[#0b111a]/90 text-amber-200 hover:border-sky-300'
                        : 'border-slate-500/70 bg-[#080d16]/85 text-slate-300 hover:border-white hover:text-white'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 ${
                      isSelected
                        ? 'bg-sky-400'
                        : mountedId
                          ? 'bg-amber-400'
                          : 'bg-slate-400'
                    }`}
                  />
                  <span>{pin.pinLabel}</span>
                </button>
              );
            })}
        </div>
      ) : (
        /* Military Wireframe 3D Ballistics & X-Ray Internals Viewport */
        <div ref={ballisticsMountRef} className="fixed inset-0 z-0 bg-[#060a12]" />
      )}

      {/* ==================== TOP LOADOUT STRIP (LOADOUTS 1–5 + MODE TABS) ==================== */}
      <header
        onMouseDown={(e) => e.stopPropagation()}
        className="relative z-20 flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/70 bg-[#070c15]/94 px-4 py-2.5"
      >
        {/* Left: 5 Custom Loadout Slot Tabs */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-display text-sm font-bold uppercase tracking-widest text-sky-300">
            LOADOUTS
          </span>
          {loadoutState.slots.map((slot, idx) => {
            const active = idx === loadoutState.activeIndex;
            const isEditing = editingSlotIdx === idx;
            return (
              <div
                key={slot.id}
                className={`flex items-center border transition-colors ${
                  active
                    ? 'border-sky-400 bg-sky-500/18 text-white'
                    : 'border-slate-800 bg-[#0c131f]/90 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                }`}
              >
                {isEditing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      loadoutStore.renameSlot(idx, renameDraft);
                      setEditingSlotIdx(null);
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5"
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      maxLength={22}
                      className="w-24 bg-slate-950 px-1 py-0.5 font-mono-tabular text-[11px] text-white outline-none"
                    />
                    <button
                      type="submit"
                      className="cursor-pointer p-0.5 text-emerald-400 hover:text-emerald-300"
                      title="Save name"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        loadoutStore.setActiveIndex(idx);
                        if (gymBridge) {
                          const targetW =
                            gearFocus === 'secondary'
                              ? slot.secondaryWeaponId
                              : slot.primaryWeaponId;
                          gymBridge.onSelectWeapon(targetW);
                        }
                      }}
                      className="cursor-pointer whitespace-nowrap px-2.5 py-1 font-mono-tabular text-[11px] font-semibold"
                    >
                      <span className="mr-1.5 text-[10px] text-slate-500">0{idx + 1}</span>
                      <span>{slot.name}</span>
                    </button>
                    {active && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSlotIdx(idx);
                          setRenameDraft(slot.name);
                        }}
                        className="cursor-pointer pr-2 text-slate-400 hover:text-sky-300"
                        title="Rename Loadout"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Center/Right: Workbench vs Zero+Ballistics Mode Switch + Controls */}
        <div className="flex items-center gap-2">
          <div className="flex border border-slate-700/80 bg-[#0b111c] p-0.5 font-mono-tabular text-[11px]">
            <button
              type="button"
              onClick={() => setActiveTab('workbench')}
              className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-3 py-1 font-semibold transition-colors ${
                activeTab === 'workbench'
                  ? 'bg-sky-500/22 text-sky-200'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Sliders className="h-3.5 w-3.5" />
              <span>Gunsmith Bench</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ballistics')}
              className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-3 py-1 font-semibold transition-colors ${
                activeTab === 'ballistics'
                  ? 'bg-amber-500/22 text-amber-200'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Crosshair className="h-3.5 w-3.5" />
              <span>Zero &amp; Ballistics</span>
            </button>
          </div>

          {activeTab === 'workbench' && (
            <button
              type="button"
              onClick={() => setZenInspect((z) => !z)}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-slate-700/80 bg-[#0b111c] px-2.5 py-1.5 font-mono-tabular text-[10px] text-slate-300 hover:border-sky-400 hover:text-white"
              title="Toggle unobstructed 3D inspection"
            >
              {zenInspect ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              <span>{zenInspect ? 'Show Panels' : 'Inspect 3D'}</span>
            </button>
          )}

          {/* Compact 4-Tier Graphics Preset Switcher */}
          <div className="hidden items-center gap-0.5 border border-slate-800 bg-[#0b111c] p-0.5 xl:flex">
            {GRAPHICS_QUALITY_ORDER.map((gid) => (
              <button
                key={gid}
                type="button"
                onClick={() => setGraphicsQuality(gid)}
                className={`cursor-pointer px-2 py-1 font-mono-tabular text-[9px] font-semibold uppercase ${
                  graphicsQuality === gid
                    ? 'bg-amber-500/25 text-amber-300'
                    : 'text-slate-500 hover:text-slate-200'
                }`}
                title={GRAPHICS_QUALITY_PROFILES[gid].description}
              >
                {GRAPHICS_QUALITY_PROFILES[gid].shortLabel}
              </button>
            ))}
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-slate-600 bg-slate-900 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold text-slate-200 hover:border-amber-400 hover:text-amber-300"
            >
              <X className="h-3.5 w-3.5" />
              <span>{closeLabel}</span>
            </button>
          )}
        </div>
      </header>

      {/* ==================== WORKBENCH TAB: SIDE RAILS AROUND CENTER 3D BENCH ==================== */}
      {activeTab === 'workbench' && !zenInspect && (
        <div className="pointer-events-none relative z-10 flex flex-1 items-stretch justify-between overflow-hidden p-4">
          {/* LEFT SIDE RAIL: Loadout Weapons, Equipment, Ammo & Armory Picker */}
          <aside
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="pointer-events-auto flex w-[290px] shrink-0 flex-col gap-3 overflow-y-auto border border-slate-700/70 bg-[#070d17]/92 p-3.5"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div>
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-sky-400">
                  Loadout 0{loadoutState.activeIndex + 1} Gear
                </div>
                <div className="font-display text-lg font-bold uppercase tracking-wide text-white">
                  {activeSlot.name}
                </div>
              </div>
              <button
                type="button"
                onClick={() => loadoutStore.resetSlotToDefault(loadoutState.activeIndex)}
                className="cursor-pointer border border-slate-800 bg-slate-900/90 p-1.5 text-slate-400 hover:border-amber-400 hover:text-amber-300"
                title="Reset loadout slot to default"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Primary Weapon Slot */}
            <div
              className={`border p-2.5 transition-colors ${
                gearFocus === 'primary'
                  ? 'border-sky-400 bg-sky-500/12'
                  : 'border-slate-800 bg-[#0b121e]/90'
              }`}
            >
              <div className="flex items-center justify-between font-mono-tabular text-[10px] text-slate-400">
                <span>Primary Weapon</span>
                <button
                  type="button"
                  onClick={() => {
                    setGearFocus('primary');
                    setArmoryOpen(true);
                    if (gymBridge) gymBridge.onSelectWeapon(activeSlot.primaryWeaponId);
                  }}
                  className="cursor-pointer text-sky-300 hover:text-sky-200"
                >
                  Change
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setGearFocus('primary');
                  if (gymBridge) gymBridge.onSelectWeapon(activeSlot.primaryWeaponId);
                }}
                className="mt-1 w-full cursor-pointer text-left"
              >
                <div className="font-display text-base font-bold uppercase text-white">
                  {primaryProfile.name}
                </div>
                <div className="font-mono-tabular text-[10px] text-slate-400">
                  {primaryProfile.caliberLabel} · {primaryProfile.magCapacity} rds
                </div>
              </button>
            </div>

            {/* Sidearm Slot */}
            <div
              className={`border p-2.5 transition-colors ${
                gearFocus === 'secondary'
                  ? 'border-sky-400 bg-sky-500/12'
                  : 'border-slate-800 bg-[#0b121e]/90'
              }`}
            >
              <div className="flex items-center justify-between font-mono-tabular text-[10px] text-slate-400">
                <span>Sidearm</span>
                <button
                  type="button"
                  onClick={() => {
                    setGearFocus('secondary');
                    setActiveCategory('pistols');
                    setArmoryOpen(true);
                    if (gymBridge) gymBridge.onSelectWeapon(activeSlot.secondaryWeaponId);
                  }}
                  className="cursor-pointer text-sky-300 hover:text-sky-200"
                >
                  Change
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setGearFocus('secondary');
                  if (gymBridge) gymBridge.onSelectWeapon(activeSlot.secondaryWeaponId);
                }}
                className="mt-1 w-full cursor-pointer text-left"
              >
                <div className="font-display text-base font-bold uppercase text-white">
                  {secondaryProfile.name}
                </div>
                <div className="font-mono-tabular text-[10px] text-slate-400">
                  {secondaryProfile.caliberLabel} · {secondaryProfile.magCapacity} rds
                </div>
              </button>
            </div>

            {/* Expandable 7-Category Weapon Armory Selector */}
            <div className="border border-slate-800 bg-[#0a101b]/95 p-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono-tabular text-[10px] uppercase tracking-wider text-slate-400">
                  Armory Catalog
                </span>
                <button
                  type="button"
                  onClick={() => setArmoryOpen((o) => !o)}
                  className="cursor-pointer font-mono-tabular text-[10px] text-amber-300 hover:text-amber-200"
                >
                  {armoryOpen ? 'Hide' : 'Browse All'}
                </button>
              </div>

              {armoryOpen && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1">
                    {WEAPON_CATEGORY_META.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setActiveCategory(cat.id)}
                        className={`cursor-pointer border px-1.5 py-0.5 font-mono-tabular text-[9px] font-semibold ${
                          activeCategory === cat.id
                            ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                            : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-white'
                        }`}
                      >
                        {cat.shortLabel}
                      </button>
                    ))}
                  </div>
                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto pr-1">
                    {categoryWeapons.map((w) => {
                      const active = w.id === focusedWeaponId;
                      const unlocked = isWeaponUnlocked ? isWeaponUnlocked(w.id) : true;
                      const reqRank = getWeaponUnlockRank(w.id);
                      return (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => handleSelectWeapon(w.id)}
                          className={`flex cursor-pointer items-center justify-between border px-2 py-1 text-left font-mono-tabular text-[11px] ${
                            active
                              ? 'border-amber-400 bg-amber-500/20 font-semibold text-amber-200'
                              : unlocked
                                ? 'border-slate-800 bg-slate-950/90 text-slate-200 hover:border-slate-600'
                                : 'border-slate-900 bg-slate-950/60 text-slate-500'
                          }`}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {!unlocked && <Lock className="h-3 w-3 shrink-0" />}
                            <span className="truncate">{w.name}</span>
                          </span>
                          <span className="text-[9px] text-slate-400">
                            {unlocked ? w.caliberLabel.split(' ')[0] : `R${reqRank}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Ammunition Variant Selector */}
            {ammoVariants.length > 0 && (
              <div className="border-t border-slate-800 pt-2.5">
                <div className="mb-1.5 font-mono-tabular text-[10px] uppercase tracking-wider text-slate-400">
                  Cartridge · {activeProfile.caliberLabel}
                </div>
                <div className="flex flex-col gap-1">
                  {ammoVariants.map((variant) => {
                    const selected = variant.id === activeAmmoVariantId;
                    const vel = Math.round(
                      variant.baseVelocityMs *
                        (activeProfile.barrelVelocityMult ?? 1.0) *
                        activeStats.velocityMult,
                    );
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => handleSelectAmmo(variant.id)}
                        className={`flex cursor-pointer items-center justify-between border px-2 py-1.5 font-mono-tabular text-[10px] transition-colors ${
                          selected
                            ? 'border-sky-400 bg-sky-500/18 text-sky-100'
                            : 'border-slate-800 bg-[#0b111c] text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        <span className="font-semibold">{variant.shortName}</span>
                        <span className="text-slate-400">
                          {vel}m/s · {coreBadgeLabel(variant.coreType)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tactical Equipment & Belt Mount */}
            <div className="border-t border-slate-800 pt-2.5">
              <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-slate-400">
                <span className="flex items-center gap-1">
                  <Shield className="h-3 w-3 text-amber-400" />
                  Tactical Equipment
                </span>
                <button
                  type="button"
                  onClick={() =>
                    loadoutStore.setSlotTacticalEquipment(
                      loadoutState.activeIndex,
                      activeSlot.tacticalEquipmentId,
                      activeSlot.tacticalBeltSlot,
                      !activeSlot.mountOnBelt,
                    )
                  }
                  className={`cursor-pointer border px-1.5 py-0.5 text-[9px] ${
                    activeSlot.mountOnBelt
                      ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                      : 'border-slate-700 bg-slate-900 text-slate-400'
                  }`}
                >
                  Belt: {activeSlot.mountOnBelt ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {TACTICAL_EQUIPMENT_LIST.map((item) => {
                  const active = activeSlot.tacticalEquipmentId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        loadoutStore.setSlotTacticalEquipment(loadoutState.activeIndex, item.id)
                      }
                      className={`cursor-pointer border px-2 py-1.5 text-left font-mono-tabular text-[10px] transition-colors ${
                        active
                          ? 'border-amber-400 bg-amber-500/20 font-semibold text-amber-200'
                          : 'border-slate-800 bg-[#0b111c] text-slate-400 hover:border-slate-600 hover:text-white'
                      }`}
                    >
                      {item.shortName}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1">
                {TACTICAL_BELT_SLOTS.map((bs) => (
                  <button
                    key={bs.id}
                    type="button"
                    onClick={() =>
                      loadoutStore.setSlotTacticalEquipment(
                        loadoutState.activeIndex,
                        activeSlot.tacticalEquipmentId,
                        bs.id,
                      )
                    }
                    className={`cursor-pointer border py-1 font-mono-tabular text-[9px] uppercase ${
                      activeSlot.tacticalBeltSlot === bs.id
                        ? 'border-sky-400 bg-sky-500/18 text-sky-200'
                        : 'border-slate-800 bg-slate-950 text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {bs.shortLabel}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* RIGHT SIDE RAIL: Weapon Attachments, Reticle Color & Live Telemetry */}
          <aside
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="pointer-events-auto flex w-[310px] shrink-0 flex-col gap-3 overflow-y-auto border border-slate-700/70 bg-[#070d17]/92 p-3.5"
          >
            {/* Active Firearm Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-2">
              <div>
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-amber-400">
                  {activeProfile.country ?? 'Tactical'} · {activeProfile.caliberLabel}
                </div>
                <div className="font-display text-xl font-bold uppercase tracking-wide text-white">
                  {activeProfile.name}
                </div>
                {weaponProg && (
                  <div className="mt-0.5 font-mono-tabular text-[10px] text-slate-400">
                    Gun Lv.{weaponProg.level} / {MAX_GUN_LEVEL} · {weaponProg.xp}/
                    {xpRequiredForNextGunLevel(weaponProg.level)} XP
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={!hasAnyAttachment}
                onClick={handleStripAll}
                className={`border px-2 py-1 font-mono-tabular text-[10px] ${
                  hasAnyAttachment
                    ? 'cursor-pointer border-slate-700 bg-slate-900 text-slate-200 hover:border-red-500 hover:text-red-300'
                    : 'cursor-not-allowed border-slate-900 bg-slate-950 text-slate-600'
                }`}
              >
                Strip
              </button>
            </div>

            {!activeWeaponUnlocked && (
              <div className="flex items-center gap-2 border border-red-900/70 bg-red-950/40 px-2.5 py-1.5 font-mono-tabular text-[10px] text-red-200">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Unlocks at Career Rank {getWeaponUnlockRank(focusedWeaponId)} (Current: Rank{' '}
                  {careerRank})
                </span>
              </div>
            )}

            {/* Attachment Slot Selector Strip */}
            <div className="grid grid-cols-4 gap-1">
              {ATTACHMENT_SLOTS.map((slotMeta) => {
                const active = selectedSlot === slotMeta.slot;
                const mounted = Boolean(activeAttachments[slotMeta.slot]);
                return (
                  <button
                    key={slotMeta.slot}
                    type="button"
                    onClick={() => setSelectedSlot(slotMeta.slot)}
                    className={`cursor-pointer border px-1.5 py-1.5 font-mono-tabular text-[9px] font-semibold uppercase transition-colors ${
                      active
                        ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                        : mounted
                          ? 'border-amber-500/60 bg-amber-500/10 text-amber-200 hover:border-sky-400'
                          : 'border-slate-800 bg-[#0b111c] text-slate-400 hover:text-white'
                    }`}
                  >
                    {slotMeta.pinLabel}
                  </button>
                );
              })}
            </div>

            {/* Reticle Color Picker when Optic or Canted Selected */}
            {(selectedSlot === 'optic' || selectedSlot === 'canted') &&
              activeAttachments[selectedSlot] && (
                <div className="flex items-center justify-between border border-slate-800 bg-[#0b111c] px-2.5 py-1.5">
                  <span className="font-mono-tabular text-[10px] text-slate-400">
                    Reticle Color
                  </span>
                  <div className="flex items-center gap-1.5">
                    {RETICLE_COLOR_OPTIONS.map((opt) => {
                      const current =
                        selectedSlot === 'optic'
                          ? (activeAttachments.reticleColor ?? 'red')
                          : (activeAttachments.cantedReticleColor ?? 'green');
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => handleSelectReticleColor(selectedSlot, opt.id)}
                          title={opt.label}
                          className={`h-4 w-4 cursor-pointer border ${
                            current === opt.id ? 'border-white scale-110' : 'border-slate-700'
                          }`}
                          style={{ backgroundColor: opt.swatch }}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

            {/* Compatible Attachments List */}
            <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
              <button
                type="button"
                onClick={() => handleSelectAttachment(selectedSlot, null)}
                className={`flex cursor-pointer items-center justify-between border px-2.5 py-1.5 font-mono-tabular text-[11px] ${
                  !activeAttachments[selectedSlot]
                    ? 'border-sky-400 bg-sky-500/16 font-semibold text-sky-100'
                    : 'border-slate-800 bg-[#0b111c] text-slate-400 hover:text-white'
                }`}
              >
                <span>None / Factory Default</span>
                {!activeAttachments[selectedSlot] && (
                  <span className="text-[10px] text-sky-300">Equipped</span>
                )}
              </button>

              {compatibleForSlot.length === 0 ? (
                <div className="border border-slate-800/80 bg-slate-950/60 p-3 text-center font-mono-tabular text-[10px] text-slate-500">
                  No aftermarket hardware compatible for this slot.
                </div>
              ) : (
                compatibleForSlot.map((def) => {
                  const isMounted = activeAttachments[selectedSlot] === def.id;
                  const attUnlocked = isAttachmentUnlocked ? isAttachmentUnlocked(def.id) : true;
                  const reqGunLv = getAttachmentRequiredGunLevel(def.id);
                  const reqAdapterId = getRequiredRailAdapterId(
                    def,
                    focusedWeaponId,
                    activeAttachments,
                  );
                  const reqAdapterDef = reqAdapterId ? ATTACHMENTS[reqAdapterId] : null;
                  const badges = formatAttachmentBadges(def);
                  const canEquip = activeWeaponUnlocked && attUnlocked && !reqAdapterDef;

                  return (
                    <div
                      key={def.id}
                      className={`border p-2 transition-colors ${
                        isMounted
                          ? 'border-amber-400 bg-amber-500/12'
                          : 'border-slate-800 bg-[#0a101b]/90'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={!canEquip}
                        onClick={() => handleSelectAttachment(selectedSlot, def.id)}
                        className={`w-full text-left ${canEquip ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono-tabular text-[11px] font-semibold text-white">
                            {def.name}
                          </span>
                          {isMounted ? (
                            <span className="font-mono-tabular text-[9px] font-semibold text-amber-300">
                              Mounted
                            </span>
                          ) : reqAdapterDef ? (
                            <span className="font-mono-tabular text-[9px] text-amber-400">
                              Needs {reqAdapterDef.shortName}
                            </span>
                          ) : !attUnlocked ? (
                            <span className="font-mono-tabular text-[9px] text-red-400">
                              Lv.{reqGunLv}
                            </span>
                          ) : (
                            <span className="font-mono-tabular text-[9px] text-emerald-400">
                              Ready
                            </span>
                          )}
                        </div>
                        {badges.length > 0 && (
                          <div className="mt-1 font-mono-tabular text-[9px] text-slate-400">
                            {badges.join(' · ')}
                          </div>
                        )}
                      </button>
                      {reqAdapterDef && activeWeaponUnlocked && (
                        <button
                          type="button"
                          onClick={() => handleSelectAttachment('railAdapter', reqAdapterDef.id)}
                          className="mt-1.5 w-full cursor-pointer border border-amber-400/70 bg-amber-500/15 py-1 font-mono-tabular text-[9px] font-semibold text-amber-200 hover:bg-amber-500/25"
                        >
                          Mount {reqAdapterDef.shortName} First
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Live Derived Telemetry Matrix */}
            <div className="grid grid-cols-3 gap-2 border-t border-slate-800 pt-2.5 font-mono-tabular text-[10px]">
              <div>
                <div className="text-[9px] text-slate-500">Mass</div>
                <div className="text-slate-100">{activeStats.totalMassKg.toFixed(2)} kg</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">Ergo</div>
                <div className="text-amber-300">{activeStats.ergonomics}/100</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">Velocity</div>
                <div className="text-sky-300">{Math.round(effectiveVelMps)} m/s</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">Energy</div>
                <div className="text-slate-100">{Math.round(effectiveEnergyJ)} J</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">Recoil</div>
                <div className="text-slate-100">
                  {Math.round(activeStats.recoilPitchMult * 100)}%
                </div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">Zero</div>
                <div className="text-sky-200">
                  {zeroDistanceM}m ({zeroElevationMrad >= 0 ? '+' : ''}
                  {zeroElevationMrad.toFixed(1)})
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* ==================== ZERO & BALLISTICS WIREFRAME SIM TAB ==================== */}
      {activeTab === 'ballistics' && trajectoryProfile && penetrationResult && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          className="fixed right-5 bottom-3 left-5 z-20 flex flex-col items-center"
        >
          <button
            type="button"
            onClick={() => setSimDockCollapsed((c) => !c)}
            className="mb-1 cursor-pointer border border-slate-700/80 bg-[#080d16]/94 px-3 py-0.5 font-mono-tabular text-[10px] text-slate-300 hover:border-slate-500 hover:text-white"
          >
            {simDockCollapsed ? '▴ Show Zero & Ballistics Controls' : '▾ Hide Controls'}
          </button>

          {!simDockCollapsed && (
            <div className="grid w-full grid-cols-1 gap-3 border border-slate-700/80 bg-[#070c15]/95 p-3 text-slate-100 xl:grid-cols-12">
              {/* Zeroing & Turret Controls */}
              <div className="flex flex-col gap-2 xl:col-span-4 xl:border-r xl:border-slate-800 xl:pr-3">
                <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                  <span className="font-semibold text-white">Optic Zero &amp; Turret</span>
                  <span className="text-slate-400">
                    HOB {(heightOverBoreM * 1000).toFixed(0)}mm · Zero {zeroDistanceM}m
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {zeroPresets.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => handleSetZeroDist(d)}
                      className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] ${
                        zeroDistanceM === d
                          ? 'border-sky-400 bg-sky-500/20 font-semibold text-sky-100'
                          : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {d}m
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 font-mono-tabular text-[11px]">
                  <span className="text-slate-400">Elevation:</span>
                  <button
                    type="button"
                    onClick={() => handleStepElevation(-0.5)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-sky-400"
                  >
                    -0.5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStepElevation(-0.1)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-sky-400"
                  >
                    -0.1
                  </button>
                  <span className="min-w-[68px] text-center font-semibold text-sky-300">
                    {zeroElevationMrad >= 0 ? '+' : ''}
                    {zeroElevationMrad.toFixed(1)} MRAD
                  </span>
                  <button
                    type="button"
                    onClick={() => handleStepElevation(0.1)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-sky-400"
                  >
                    +0.1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStepElevation(0.5)}
                    className="cursor-pointer border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:border-sky-400"
                  >
                    +0.5
                  </button>
                </div>
              </div>

              {/* Barrier Material Penetration & Distance Controls */}
              <div className="flex flex-col gap-2 xl:col-span-5 xl:border-r xl:border-slate-800 xl:pr-3">
                <div className="flex flex-wrap gap-1">
                  {BALLISTICS_TEST_MATERIALS.map((m, idx) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSimMaterialIdx(idx)}
                      className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] ${
                        simMaterialIdx === idx
                          ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                          : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3 font-mono-tabular text-[10px]">
                  <label className="flex flex-col gap-1">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Impact Range</span>
                      <span className="text-sky-300">{simRangeM} m</span>
                    </div>
                    <input
                      type="range"
                      min={25}
                      max={maxSimRangeM}
                      step={5}
                      value={simRangeM}
                      onChange={(e) => setSimRangeM(Number(e.target.value))}
                      className="accent-sky-400"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Plate Obliquity</span>
                      <span className="text-amber-300">{simObliquityDeg}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={60}
                      step={5}
                      value={simObliquityDeg}
                      onChange={(e) => setSimObliquityDeg(Number(e.target.value))}
                      className="accent-amber-400"
                    />
                  </label>
                </div>

                <div className="flex items-center justify-between font-mono-tabular text-[10px] text-slate-300">
                  <span>
                    Outcome:{' '}
                    <strong
                      className={
                        penetrationResult.outcome === 'penetrate'
                          ? 'text-emerald-400'
                          : penetrationResult.outcome === 'ricochet'
                            ? 'text-amber-300'
                            : 'text-red-400'
                      }
                    >
                      {penetrationResult.outcome.toUpperCase()}
                    </strong>
                  </span>
                  <span>
                    Retained Vel: {Math.round(penetrationResult.exitSpeedMs)} m/s ·{' '}
                    {Math.round(
                      (penetrationResult.impactEnergyJ > 0
                        ? penetrationResult.exitEnergyJ / penetrationResult.impactEnergyJ
                        : 0) * 100,
                    )}
                    % Energy
                  </span>
                </div>
              </div>

              {/* Camera Presets & Test Fire Playback */}
              <div className="flex flex-col justify-between gap-2 xl:col-span-3">
                <div className="grid grid-cols-3 gap-1">
                  {(
                    [
                      { id: 'cutaway', label: 'X-Ray' },
                      { id: 'full_range', label: 'Arc' },
                      { id: 'impact_plate', label: 'Impact' },
                    ] as Array<{ id: BallisticsCameraPreset; label: string }>
                  ).map((cam) => (
                    <button
                      key={cam.id}
                      type="button"
                      onClick={() => setSimCamPreset(cam.id)}
                      className={`cursor-pointer border py-1 font-mono-tabular text-[10px] ${
                        simCamPreset === cam.id
                          ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                          : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-white'
                      }`}
                    >
                      {cam.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    ballisticsSimRef.current?.triggerTestFire(false);
                    gymBridge?.onTestFireSound?.();
                  }}
                  className="w-full cursor-pointer bg-amber-500 py-2 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
                >
                  Test Fire Simulation
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
