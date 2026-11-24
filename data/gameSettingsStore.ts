import { useSyncExternalStore } from 'react';

export type GameSettingsTabId = 'general' | 'controls';

interface GameSettingsModalState {
  open: boolean;
  tab: GameSettingsTabId;
}

let state: GameSettingsModalState = {
  open: false,
  tab: 'general',
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function openGameSettings(tab: GameSettingsTabId = 'general'): void {
  state = { open: true, tab };
  notify();
}

export function setGameSettingsTab(tab: GameSettingsTabId): void {
  if (state.tab === tab) return;
  state = { ...state, tab };
  notify();
}

export function closeGameSettings(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): GameSettingsModalState {
  return state;
}

export function useGameSettingsModal(): GameSettingsModalState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
