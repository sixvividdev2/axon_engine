import React, { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { GunsmithPinProjection } from '../arena/GunsmithBench';
import {
  getWeaponsByCategory,
  resolveWeaponProfile,
  WEAPON_CATEGORY_META,
  WeaponCategory,
} from '../bodycam-sdk';
import {
  ATTACHMENT_SLOTS,
  ATTACHMENTS,
  AttachmentDef,
  AttachmentSlot,
  DerivedWeaponStats,
  getCompatibleAttachments,
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
  onSelectWeapon: (weaponId: string) => void;
  onSelectAmmoVariant: (variantId: AmmoVariantId) => void;
  onToggleFireMode: () => void;
  onSelectAttachment: (slot: AttachmentSlot, attachmentId: string | null) => void;
  onSelectReticleColor: (slot: 'optic' | 'canted', colorId: ReticleColorId) => void;
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
  if (def.adsZoomFactor && def.adsZoomFactor >= 1.5) {
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
  onSelectWeapon,
  onSelectAmmoVariant,
  onToggleFireMode,
  onSelectAttachment,
  onSelectReticleColor,
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
  const gunLevel = weaponProgress?.level ?? 1;
  const gunXp = weaponProgress?.xp ?? 0;
  const gunNextXp = xpRequiredForNextGunLevel(gunLevel);
  const gunXpPct = Math.min(100, (gunXp / Math.max(1, gunNextXp)) * 100);
  const activeWeaponUnlocked = isWeaponUnlocked ? isWeaponUnlocked(weaponId) : true;
  const activeWeaponReqRank = getWeaponUnlockRank(weaponId);
  const [selectedSlot, setSelectedSlot] = useState<AttachmentSlot | null>('optic');
  const [activeCategory, setActiveCategory] = useState<WeaponCategory>(
    activeProfile.category ?? 'carbines',
  );
  const draggingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (activeProfile.category) {
      setActiveCategory(activeProfile.category);
    }
  }, [activeProfile.category]);

  const handlePointerDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    draggingRef.current = true;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastPosRef.current.x;
    const dy = e.clientY - lastPosRef.current.y;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    onOrbit(dx, dy);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    onZoom(e.deltaY);
  };

  const activeSlotMeta = selectedSlot
    ? ATTACHMENT_SLOTS.find((s) => s.slot === selectedSlot) ?? null
    : null;
  const compatibleForSlot = selectedSlot ? getCompatibleAttachments(weaponId, selectedSlot) : [];
  const installedId = selectedSlot ? attachments[selectedSlot] ?? null : null;
  const installedDef = installedId ? ATTACHMENTS[installedId] ?? null : null;
  const showReticleColorPicker =
    (selectedSlot === 'optic' || selectedSlot === 'canted') &&
    Boolean(installedDef?.hasIlluminatedReticle);
  const activeReticleColor: ReticleColorId =
    (selectedSlot === 'canted' ? attachments.cantedReticleColor : attachments.reticleColor) ??
    'red';

  const hasAnyAttachment = Boolean(
    attachments.optic ||
      attachments.canted ||
      attachments.muzzle ||
      attachments.tactical ||
      attachments.foregrip ||
      attachments.magazine,
  );

  const categoryWeapons = getWeaponsByCategory(activeCategory);
  const ammoVariants = getAmmoVariantsForCaliber(activeCaliberId);
  const activeAmmo = AMMO_VARIANTS[activeAmmoVariantId] ?? ammoVariants[0];
  const effectiveVelMps = activeAmmo
    ? activeAmmo.baseVelocityMs * (activeProfile.barrelVelocityMult ?? 1.0) * stats.velocityMult
    : activeProfile.muzzleVelocityMps;
  const effectiveEnergyJ = activeAmmo
    ? 0.5 * (activeAmmo.bulletMassGrams * 0.001) * effectiveVelMps * effectiveVelMps
    : 0;

  return (
    <div
      className="fixed inset-0 z-30 select-none overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Fullscreen interactive 360-degree drag & zoom surface */}
      <div
        className="fixed inset-0 cursor-grab active:cursor-grabbing"
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onWheel={handleWheel}
      />

      {/* Top Bar: Workbench Title & Exit Action */}
      <div className="pointer-events-none fixed top-4 left-5 right-5 flex items-start justify-between gap-4">
        <div className="pointer-events-auto border-l-2 border-amber-400 bg-neutral-950/90 px-4 py-2.5 text-neutral-100">
          <div className="flex items-center gap-2 font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-amber-400">
            <span>Armorers Gunsmithing Bench</span>
            {activeProfile.country && (
              <>
                <span className="text-neutral-600">·</span>
                <span className="text-neutral-300">{activeProfile.country}</span>
              </>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-3">
            <h2 className="font-display text-xl font-bold uppercase tracking-wide text-neutral-50">
              {weaponName}
            </h2>
            <span className="font-mono-tabular text-xs text-neutral-300">{caliberLabel}</span>
            {toggleablePumpSemi && (
              <button
                type="button"
                onClick={onToggleFireMode}
                className="cursor-pointer border border-amber-500/70 bg-amber-500/12 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-amber-300 hover:bg-amber-500/25"
              >
                Mode: {spas12Mode === 'semi' ? 'SEMI-AUTO' : 'PUMP ACTION'} [Z]
              </button>
            )}
          </div>
          <div className="mt-1 font-mono-tabular text-[11px] text-neutral-400">
            Drag to orbit 360° · Scroll to zoom · Click a socket pin to mount parts
          </div>
          <div className="mt-2 flex items-center gap-3 border-t border-neutral-800/80 pt-1.5 font-mono-tabular text-[10px]">
            {activeWeaponUnlocked ? (
              <>
                <span className="text-amber-300">
                  Gun Lv. {gunLevel} / {MAX_GUN_LEVEL}
                </span>
                <div className="h-1.5 w-24 overflow-hidden bg-neutral-900">
                  <div className="h-full bg-amber-400" style={{ width: `${gunXpPct.toFixed(1)}%` }} />
                </div>
                <span className="text-neutral-400">
                  {gunXp}/{gunNextXp} XP · Attachment progression only
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-red-400">
                <Lock className="h-3 w-3" />
                Locked — Unlocks at Career Rank {activeWeaponReqRank} (Current Rank {careerRank})
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto cursor-pointer border border-neutral-700 bg-neutral-950/92 px-4 py-2 font-mono-tabular text-xs font-medium uppercase tracking-wider text-neutral-100 transition-colors hover:border-amber-400 hover:text-amber-300"
        >
          Esc / E · Exit Bench
        </button>
      </div>

      {/* 3D-Projected Socket Pins anchored over the firearm */}
      {pins.map((pin) => {
        if (!pin.visible) return null;
        const compat = getCompatibleAttachments(weaponId, pin.slot);
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
              <div className="font-mono-tabular text-[10px] uppercase tracking-widest text-amber-400">
                Socket · {activeSlotMeta.pinLabel}
              </div>
              <div className="font-display text-sm font-semibold uppercase tracking-wide text-neutral-50">
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
                <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
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
                        className={`flex cursor-pointer items-center justify-center gap-1.5 border px-1.5 py-1 font-mono-tabular text-[10px] uppercase transition-colors ${
                          activeColor
                            ? 'border-amber-400 bg-neutral-950 text-neutral-50'
                            : 'border-neutral-800 bg-neutral-950/70 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{
                            backgroundColor: opt.swatch,
                            boxShadow: activeColor ? `0 0 6px ${opt.swatch}` : 'none',
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
                {!installedId && <span className="text-[10px] text-amber-300">MOUNTED</span>}
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
                const canMount = activeWeaponUnlocked && (attUnlocked || isMounted);
                return (
                  <button
                    key={def.id}
                    type="button"
                    disabled={!canMount}
                    onClick={() => {
                      if (!canMount) return;
                      onSelectAttachment(selectedSlot, isMounted ? null : def.id);
                    }}
                    className={`border px-3 py-2 text-left transition-colors ${
                      !canMount
                        ? 'cursor-not-allowed border-neutral-800/70 bg-neutral-950/70 text-neutral-500 opacity-70'
                        : isMounted
                          ? 'cursor-pointer border-amber-400 bg-amber-500/14 text-neutral-50'
                          : 'cursor-pointer border-neutral-800 bg-neutral-900/75 text-neutral-200 hover:border-neutral-500'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono-tabular text-xs font-semibold text-neutral-50">
                        {def.name}
                      </span>
                      {isMounted ? (
                        <span className="shrink-0 font-mono-tabular text-[10px] font-semibold uppercase text-amber-300">
                          Mounted
                        </span>
                      ) : !attUnlocked ? (
                        <span className="flex shrink-0 items-center gap-1 font-mono-tabular text-[10px] uppercase text-red-400">
                          <Lock className="h-3 w-3" />
                          Gun Lv.{reqGunLv}
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono-tabular text-[10px] uppercase text-emerald-400/90">
                          Global Unlock
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-neutral-400">
                      {def.description}
                    </p>
                    {badges.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {badges.map((tag) => (
                          <span
                            key={tag}
                            className="border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] text-neutral-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
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
                  className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider transition-colors ${
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
              className={`border px-2.5 py-1 font-mono-tabular text-[10px] uppercase tracking-wider transition-colors ${
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
                    <span className={active ? 'text-[9px] text-neutral-900' : 'text-[9px] text-neutral-500'}>
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
              <span className="mr-1 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
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
                      {variant.bulletMassGrams}g · {velMps}m/s · BC {variant.ballisticCoefficient.toFixed(2)}
                    </span>
                    <span className="border border-neutral-700 bg-neutral-950 px-1 text-[9px] text-amber-300">
                      {coreBadgeLabel(variant.coreType)}
                    </span>
                    {variant.isSubsonic && (
                      <span className="border border-emerald-700/80 bg-emerald-950/60 px-1 text-[9px] text-emerald-300">
                        SUB
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Live Telemetry Readout */}
        <div className="grid grid-cols-4 gap-x-4 gap-y-1.5 border border-neutral-800 bg-neutral-950/92 px-3.5 py-2.5 font-mono-tabular text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Mass</div>
            <div className="text-neutral-100">{stats.totalMassKg.toFixed(2)} kg</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Ergo</div>
            <div className="text-amber-300">{stats.ergonomics} / 100</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Muzzle Vel</div>
            <div className="text-sky-300">{Math.round(effectiveVelMps)} m/s</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Energy</div>
            <div className="text-neutral-100">{Math.round(effectiveEnergyJ)} J</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Capacity</div>
            <div className="text-neutral-100">{stats.magCapacity} rds</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Recoil</div>
            <div className="text-neutral-100">{Math.round(stats.recoilPitchMult * 100)}%</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Optic</div>
            <div className="text-neutral-100">
              {stats.adsZoomFactor >= 1.5 ? `${stats.adsZoomFactor.toFixed(1)}x` : '1.0x'}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-neutral-500">Systems</div>
            <div className="text-[10px] text-neutral-200">
              {[
                stats.hasFlashlight ? 'LIGHT[F]' : null,
                stats.hasLaser ? 'LASER[L]' : null,
                stats.isSuppressed ? 'SUPP' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'IRON'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
