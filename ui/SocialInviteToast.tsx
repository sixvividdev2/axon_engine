import React from 'react';
import { Bell, Check, Send, X } from 'lucide-react';
import { useSocial } from '../context/SocialContext';

export const SocialInviteToast: React.FC = () => {
  const {
    pendingInvites,
    notices,
    dismissInvite,
    dismissNotice,
    openDrawer,
    acceptInviteHandlerRef,
  } = useSocial();

  if (pendingInvites.length === 0 && notices.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-sm flex-col gap-2.5">
      {/* Live Lobby Invites */}
      {pendingInvites.map((inv) => (
        <div
          key={inv.id}
          className="pointer-events-auto border border-amber-500/70 bg-neutral-950/96 p-4 text-neutral-100 shadow-2xl"
          role="alert"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400">
              <Send className="h-3 w-3" />
              <span>Lobby Invite</span>
            </div>
            <button
              type="button"
              onClick={() => dismissInvite(inv.id)}
              aria-label="Dismiss lobby invite"
              className="cursor-pointer text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-1.5 text-sm font-semibold text-neutral-50">
            {inv.fromUsername}{' '}
            <span className="font-normal text-neutral-300">invited you to join</span>
          </div>
          <div className="mt-0.5 font-mono-tabular text-xs text-neutral-400">
            {inv.eventName ? `Event: ${inv.eventName}` : inv.mode} · {inv.mapName} · Code{' '}
            {inv.lobbyCode}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (acceptInviteHandlerRef.current) {
                  acceptInviteHandlerRef.current(inv);
                }
                dismissInvite(inv.id);
              }}
              className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 bg-amber-500 px-3 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Accept</span>
            </button>
            <button
              type="button"
              onClick={() => dismissInvite(inv.id)}
              className="cursor-pointer border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-300 transition-colors hover:border-neutral-500"
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      {/* Social Notices (Friend Requests / Accepted) */}
      {notices.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto border border-neutral-700 bg-neutral-950/95 px-4 py-3 text-neutral-100 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-400">
              <Bell className="h-3 w-3" />
              <span>{n.title}</span>
            </div>
            <button
              type="button"
              onClick={() => dismissNotice(n.id)}
              aria-label="Dismiss notification"
              className="cursor-pointer text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 text-xs text-neutral-200">
            <span>{n.body}</span>
            {n.actionLabel && (
              <button
                type="button"
                onClick={() => {
                  dismissNotice(n.id);
                  openDrawer('requests');
                }}
                className="cursor-pointer shrink-0 font-mono-tabular text-[11px] font-semibold uppercase text-amber-400 hover:text-amber-300"
              >
                {n.actionLabel}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
