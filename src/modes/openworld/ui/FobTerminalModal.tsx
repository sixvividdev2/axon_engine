import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Check,
  ClipboardList,
  Clock,
  Lock,
  PackageCheck,
  ShoppingCart,
  X,
} from 'lucide-react';
import {
  formatRestockTimer,
  type FobTerminalStateSnapshot,
  type FobTraderOffer,
  type SupplyTierStatus,
} from '../world/OpenWorldLogisticsEconomy';
import {
  FOB_UPGRADE_SPECS,
  FobTier,
  PMC_FACTIONS,
  RotatingContractRecord,
  SUB_FACTION_MAP,
} from '../types';

interface FobTerminalModalProps {
  terminal: FobTerminalStateSnapshot;
  cashUsd: number;
  callsign: string;
  contractBoard: RotatingContractRecord[];
  blackMarketContext?: { subFactionName: string; traderName: string } | null;
  onFundUpgrade: () => void;
  onBuyOffer: (offerId: string) => void;
  onAcceptContract: (slotIndex: number) => void;
  onCompleteContract: (slotIndex: number) => void;
  onClose: () => void;
}

type TerminalTab = 'upgrades' | 'trader' | 'contracts';
type TraderCategoryFilter = 'all' | FobTraderOffer['category'];

function tierColorClass(tier: SupplyTierStatus['tier']): string {
  if (tier === 'high') return 'border-emerald-400/50 bg-emerald-950/40 text-emerald-200';
  if (tier === 'strained') return 'border-amber-400/50 bg-amber-950/40 text-amber-200';
  return 'border-red-500/60 bg-red-950/50 text-red-200';
}

function tierBarClass(tier: SupplyTierStatus['tier']): string {
  if (tier === 'high') return 'bg-emerald-400';
  if (tier === 'strained') return 'bg-amber-400';
  return 'bg-red-500';
}

export const FobTerminalModal: React.FC<FobTerminalModalProps> = ({
  terminal,
  cashUsd,
  callsign,
  contractBoard,
  blackMarketContext,
  onFundUpgrade,
  onBuyOffer,
  onAcceptContract,
  onCompleteContract,
  onClose,
}) => {
  const [tab, setTab] = useState<TerminalTab>('trader');
  const [category, setCategory] = useState<TraderCategoryFilter>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const factionSpec = PMC_FACTIONS[terminal.faction];
  const supplyList = Object.values(terminal.supplyTiers);
  const filteredOffers =
    category === 'all'
      ? terminal.offers
      : terminal.offers.filter((o) => o.category === category);

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-[1180px] flex-col border border-white/18 bg-[#0b0e13] text-neutral-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/12 bg-[#10141c] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 font-mono-tabular">
            <Building2 className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-50">
              {blackMarketContext
                ? `${blackMarketContext.subFactionName} · Black-Market (${blackMarketContext.traderName})`
                : `${factionSpec.name} · In-World FOB Logistics Terminal`}
            </span>
            <span className="border border-amber-400/55 bg-amber-950/50 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
              {blackMarketContext ? 'TRUSTED -15%' : `TIER ${terminal.fobTier}`}
            </span>
            <span className="text-xs text-neutral-300">
              {callsign} · <strong className="text-emerald-300">${cashUsd.toLocaleString()}</strong>
            </span>
          </div>

          <div className="flex items-center gap-3 font-mono-tabular text-[11px]">
            <span className="flex items-center gap-1 text-neutral-300">
              <Clock className="h-3.5 w-3.5 text-neutral-400" />
              <span>Restock {formatRestockTimer(terminal.restockRemainingSec)}</span>
            </span>
            {terminal.sabotageDelaySec > 0 && (
              <span className="flex items-center gap-1 border border-red-500/60 bg-red-950/50 px-2 py-0.5 text-red-200">
                <AlertTriangle className="h-3 w-3" />
                <span>SABOTAGE STALL +{formatRestockTimer(terminal.sabotageDelaySec)}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-1 border border-white/15 bg-[#151a24] px-2.5 py-1 text-xs text-neutral-200 hover:border-amber-400/60"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close [Esc]</span>
            </button>
          </div>
        </div>

        {/* Live Supply-Coupled Pool Strip */}
        <div className="grid grid-cols-2 gap-2 border-b border-white/10 bg-[#0d1118] px-4 py-2.5 sm:grid-cols-4">
          {supplyList.map((st) => (
            <div key={st.resource} className="border border-white/10 bg-[#12161e] p-2 font-mono-tabular">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-neutral-300">{st.label}</span>
                <span className={`border px-1.5 py-0.2 text-[9px] font-semibold ${tierColorClass(st.tier)}`}>
                  {st.tierLabel} · {st.pct}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full bg-white/10">
                <div className={`h-full ${tierBarClass(st.tier)}`} style={{ width: `${st.pct}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-neutral-400">
                Price {Math.round(st.priceMultiplier * 100)}% · Stock {Math.round(st.stockScale * 100)}%
              </div>
            </div>
          ))}
        </div>

        {/* Tab Bar */}
        <div className="flex items-center gap-1 border-b border-white/10 bg-[#0e1219] px-4 py-2">
          {(
            [
              { id: 'trader', label: 'Supply-Coupled Quartermaster', icon: ShoppingCart },
              { id: 'upgrades', label: 'FOB Tier 1–3 Upgrades', icon: Building2 },
              { id: 'contracts', label: '3-Slot Sub-Faction Contracts', icon: ClipboardList },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? 'border-amber-400/65 bg-amber-500/18 text-amber-200'
                    : 'border-transparent text-neutral-400 hover:text-neutral-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'trader' && (
            <div className="space-y-3">
              {/* Category Filters */}
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { id: 'all', label: 'All Stock' },
                    { id: 'ammo', label: 'Loose Ammo (Mixable)' },
                    { id: 'magazine', label: 'Magazines' },
                    { id: 'rig', label: 'Chest Rigs' },
                    { id: 'backpack', label: 'Backpacks' },
                    { id: 'medical', label: 'Medical' },
                    { id: 'ordnance', label: 'Ordnance' },
                    { id: 'armor', label: 'Armor Plates' },
                    { id: 'utility', label: 'PDA Power' },
                  ] as const
                ).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCategory(c.id)}
                    className={`cursor-pointer border px-2.5 py-1 font-mono-tabular text-[11px] ${
                      category === c.id
                        ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                        : 'border-white/12 bg-[#131822] text-neutral-300 hover:border-white/30'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
                {filteredOffers.map((offer) => {
                  const locked = offer.lockedReason !== null;
                  return (
                    <div
                      key={offer.offerId}
                      className={`flex flex-col justify-between border p-3 ${
                        locked
                          ? 'border-white/10 bg-[#0e1117] opacity-75'
                          : 'border-white/14 bg-[#12161e]'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2 font-mono-tabular">
                          <span className="text-xs font-semibold text-neutral-100">
                            {offer.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-400">
                            T{offer.requiredFobTier}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-neutral-400">{offer.description}</p>
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-2 font-mono-tabular text-[11px]">
                        <div>
                          <div className="font-semibold text-amber-200">
                            ${offer.priceUsd.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-neutral-400">
                            Stock {offer.remainingStock}/{offer.maxStock}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => onBuyOffer(offer.offerId)}
                          className={`flex cursor-pointer items-center gap-1 border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                            locked
                              ? 'cursor-not-allowed border-white/10 bg-black/40 text-neutral-500'
                              : 'border-amber-400/65 bg-amber-950/55 text-amber-100 hover:border-amber-300 hover:bg-amber-900/60'
                          }`}
                        >
                          {locked ? <Lock className="h-3 w-3" /> : <PackageCheck className="h-3 w-3" />}
                          <span>{offer.lockedReason ?? 'Issue to Pack'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'upgrades' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {([1, 2, 3] as FobTier[]).map((t) => {
                  const spec = FOB_UPGRADE_SPECS[t];
                  const built = terminal.fobTier >= t;
                  const isNext = terminal.nextUpgrade?.targetTier === t;
                  return (
                    <div
                      key={t}
                      className={`flex flex-col justify-between border p-3.5 ${
                        built
                          ? 'border-emerald-500/45 bg-emerald-950/20'
                          : isNext
                            ? 'border-amber-400/60 bg-[#15130f]'
                            : 'border-white/12 bg-[#11151d]'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between font-mono-tabular text-xs">
                          <span className="font-semibold text-neutral-100">{spec.name}</span>
                          <span
                            className={`border px-1.5 py-0.5 text-[10px] font-semibold ${
                              built
                                ? 'border-emerald-400/50 bg-emerald-950/60 text-emerald-300'
                                : 'border-white/15 bg-black/40 text-neutral-400'
                            }`}
                          >
                            {built ? 'OPERATIONAL' : `TIER ${t}`}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-neutral-300">{spec.unlocksSummary}</p>

                        <div className="mt-3 space-y-1 border-t border-white/10 pt-2 font-mono-tabular text-[11px] text-neutral-400">
                          {spec.physicalUpgrades.map((p) => (
                            <div key={p} className="flex items-center gap-1.5">
                              <Check
                                className={`h-3 w-3 shrink-0 ${
                                  built ? 'text-emerald-400' : 'text-neutral-600'
                                }`}
                              />
                              <span>{p}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {!built && (
                        <div className="mt-4 border-t border-white/10 pt-2.5 font-mono-tabular text-[11px]">
                          <div className="flex items-center justify-between text-neutral-300">
                            <span>Funding: ${spec.cashCostUsd.toLocaleString()}</span>
                            <span>Min Supply: {spec.minAvgSupplyPct}%</span>
                          </div>
                          {isNext && terminal.nextUpgrade && (
                            <button
                              type="button"
                              disabled={!terminal.nextUpgrade.canFund}
                              onClick={onFundUpgrade}
                              className={`mt-2 w-full cursor-pointer border py-1.5 text-xs font-semibold ${
                                terminal.nextUpgrade.canFund
                                  ? 'border-amber-400 bg-amber-950/65 text-amber-100 hover:bg-amber-900/70'
                                  : 'cursor-not-allowed border-white/12 bg-black/40 text-neutral-500'
                              }`}
                            >
                              {terminal.nextUpgrade.canFund
                                ? `Construct Tier ${t} Outpost (-$${spec.cashCostUsd.toLocaleString()})`
                                : terminal.nextUpgrade.blockedReason}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'contracts' && (
            <div className="space-y-3">
              <div className="font-mono-tabular text-[11px] text-neutral-400">
                3-Slot Rotating Sub-Faction Contract Board · Completing a contract awards standing with the issuer, lowers rival standing, pays cash, and rotates in a fresh task.
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {contractBoard.map((c) => {
                  const issuer = SUB_FACTION_MAP[c.subFactionId];
                  const rival = SUB_FACTION_MAP[issuer.rivalId];
                  const readyToTurnIn = c.accepted && c.progress >= c.targetCount;
                  const statusLabel = c.completed ? 'COMPLETED' : c.accepted ? 'ACTIVE' : 'AVAILABLE';
                  return (
                    <div
                      key={c.instanceId}
                      className="flex flex-col justify-between border border-white/14 bg-[#12161e] p-3.5 font-mono-tabular"
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="border border-sky-400/45 bg-sky-950/45 px-1.5 py-0.5 font-semibold uppercase text-sky-200">
                            SLOT {c.slotIndex + 1} · {c.archetype}
                          </span>
                          <span className="text-amber-300">${c.cashRewardUsd.toLocaleString()}</span>
                        </div>
                        <div className="mt-2 text-xs font-semibold text-neutral-50">{c.title}</div>
                        <p className="mt-1 font-sans text-xs text-neutral-400">{c.summary}</p>
                        <div className="mt-2.5 text-[11px] text-neutral-300">
                          Issuer: <span className="text-emerald-300">{issuer.shortName} (+{c.standingGain})</span>
                          {' · '}
                          Rival: <span className="text-red-300">{rival.shortName} ({c.rivalPenalty})</span>
                        </div>
                        <div className="mt-2 h-1.5 w-full bg-white/10">
                          <div
                            className="h-full bg-amber-400"
                            style={{
                              width: `${Math.min(100, Math.round((c.progress / Math.max(1, c.targetCount)) * 100))}%`,
                            }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-neutral-400">
                          Progress: {c.progress} / {c.targetCount} · Status: {statusLabel}
                        </div>
                      </div>

                      <div className="mt-3 pt-2">
                        {!c.accepted ? (
                          <button
                            type="button"
                            onClick={() => onAcceptContract(c.slotIndex)}
                            className="w-full cursor-pointer border border-amber-400/65 bg-amber-950/55 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-900/65"
                          >
                            Accept Contract
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onCompleteContract(c.slotIndex)}
                            className={`w-full cursor-pointer border py-1.5 text-xs font-semibold ${
                              readyToTurnIn
                                ? 'border-emerald-400 bg-emerald-950/65 text-emerald-100 hover:bg-emerald-900/70'
                                : 'border-white/15 bg-black/40 text-neutral-300 hover:border-amber-400/50'
                            }`}
                          >
                            {readyToTurnIn
                              ? `Turn In & Rotate (+$${c.cashRewardUsd.toLocaleString()})`
                              : 'Claim Field Verification'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
