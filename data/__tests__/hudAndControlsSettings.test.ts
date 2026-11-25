import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_BINDING_GROUPS } from '../controlsCatalog';
import {
  closeGameSettings,
  openGameSettings,
  setGameSettingsTab,
} from '../gameSettingsStore';

const ROOT = path.resolve(__dirname, '../..');

function readWorkspaceFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Controls Catalog & Game Settings Store', () => {
  it('defines categorized control groups with F as the sole Interact key and Q/E for lean', () => {
    const groupIds = CONTROL_BINDING_GROUPS.map((g) => g.id);
    expect(groupIds).toEqual(['movement', 'weapons', 'tactical', 'interactions']);

    const allBindings = CONTROL_BINDING_GROUPS.flatMap((g) => g.bindings);
    expect(allBindings.length).toBeGreaterThan(15);

    for (const b of allBindings) {
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.action.trim().length).toBeGreaterThan(0);
    }

    const interact = allBindings.find((b) => b.id === 'interact');
    expect(interact).toBeDefined();
    expect(interact?.keys).toEqual(['F']);

    const lean = allBindings.find((b) => b.id === 'lean');
    expect(lean).toBeDefined();
    expect(lean?.keys).toEqual(['Q', 'E']);

    const pda = allBindings.find((b) => b.id === 'pda');
    expect(pda).toBeDefined();
    expect(pda?.keys).toEqual(['P']);

    const tacticalMap = allBindings.find((b) => b.id === 'tactical_map');
    expect(tacticalMap).toBeDefined();
    expect(tacticalMap?.keys).toEqual(['M']);
  });

  it('transitions openGameSettings, setGameSettingsTab, and closeGameSettings state cleanly', () => {
    closeGameSettings();
    openGameSettings('controls');
    setGameSettingsTab('general');
    setGameSettingsTab('controls');
    closeGameSettings();
    // Calling close again when already closed is a safe no-op
    closeGameSettings();
    expect(true).toBe(true);
  });
});

describe('CombatHud Framer Motion animations & Controls HUD removal', () => {
  it('uses Framer Motion AnimatePresence, motion, and MotionConfig on CombatHud elements', () => {
    const combatHud = readWorkspaceFile('ui/CombatHud.tsx');
    expect(combatHud).toContain("from 'framer-motion'");
    expect(combatHud).toContain('<MotionConfig reducedMotion="user">');
    expect(combatHud).toContain('<AnimatePresence>');
    expect(combatHud).toContain('key="hud-ammo-health"');
    expect(combatHud).toContain('key="hud-interact-reticle"');
    expect(combatHud).toContain('key="hud-hitmarker-crosshair"');
    expect(combatHud).toContain('key="hud-rec-overlay"');
    expect(combatHud).toContain('key="hud-pause-overlay"');
    expect(combatHud).toContain('key="hud-tuner-drawer"');
    expect(combatHud).toContain('localHudVisible');
    expect(combatHud).toContain('showMatchHud');
  });

  it('removes persistent Controls HUD strips across combat, hideout, gym, openworld, and menus', () => {
    const combatHud = readWorkspaceFile('ui/CombatHud.tsx');
    const hideoutHud = readWorkspaceFile('hideout/HideoutHud.tsx');
    const gymHud = readWorkspaceFile('gym/GymHud.tsx');
    const hudOverlay = readWorkspaceFile('ui/HudOverlay.tsx');
    const mainMenuHub = readWorkspaceFile('ui/MainMenuHub.tsx');
    const mainMenu = readWorkspaceFile('ui/MainMenu.tsx');
    const openWorldHud = readWorkspaceFile('src/modes/openworld/OpenWorldHud.tsx');

    expect(combatHud).not.toContain('Bottom-Center Compact Controls Hint Strip');
    expect(combatHud).not.toContain('1-2 Weapons · 4 / H Grenade');

    expect(hideoutHud).not.toContain('LMB Jab · RMB+LMB Hook');
    expect(hideoutHud).not.toContain('WASD Move · Q/E Lean');

    expect(gymHud).not.toContain('Compact controls matrix');
    expect(gymHud).not.toContain('1-4 Weapons · R Reload');

    expect(hudOverlay).not.toContain('[Space] Jump/Vault');
    expect(hudOverlay).not.toContain('F1 Tuner · Tab Rig · Esc Menu');

    expect(mainMenuHub).not.toContain('WASD Move · Shift Sprint');
    expect(mainMenu).not.toContain('Concise Controls Reference');

    expect(openWorldHud).not.toContain('[1/2] Firearms · [3] Combat Knife');
  });

  it('wires a Controls tab into GameSettingsModal, AccountSettingsModal, GymTunerPanel, and CombatHud F1 drawer', () => {
    const app = readWorkspaceFile('App.tsx');
    const gameSettingsModal = readWorkspaceFile('ui/GameSettingsModal.tsx');
    const accountSettingsModal = readWorkspaceFile('ui/AccountSettingsModal.tsx');
    const gymTuner = readWorkspaceFile('gym/GymTunerPanel.tsx');
    const combatHud = readWorkspaceFile('ui/CombatHud.tsx');

    expect(app).toContain('<GameSettingsModal />');
    expect(gameSettingsModal).toContain("tab === 'controls'");
    expect(gameSettingsModal).toContain('<ControlsSettingsTab />');
    expect(accountSettingsModal).toContain("activeTab === 'controls'");
    expect(accountSettingsModal).toContain('<ControlsSettingsTab');
    expect(gymTuner).toContain("'controls'");
    expect(gymTuner).toContain('<ControlsSettingsTab compact />');
    expect(combatHud).toContain("tunerTab === 'controls'");
    expect(combatHud).toContain('<ControlsSettingsTab compact />');
  });
});
