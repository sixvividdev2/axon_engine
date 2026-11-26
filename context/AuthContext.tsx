import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  getAutoScopesForUnlockedRank,
  getStarterUnlockedAttachments,
  isWeaponUnlockedAtRank,
  MatchProgressionSummary,
  MatchResultInput,
  WeaponProgressRecord,
} from '../data/progression';
import { KeybindOverrides, keybindStore } from '../data/keybindStore';
import { BACKPACK_UNLOCK_RANK, backpackUnlockStore } from '../data/backpackUnlocks';
import type { BackpackTemplateId } from '../src/modes/openworld/inventory/TetrisInventoryTypes';
import {
  AccountProfile,
  commitMatchProgression,
  fetchCurrentAccount,
  loginAccount,
  logoutAccount,
  registerAccount,
  resetAccountProgress,
  updateAccountKeybinds,
  updateAccountUsername,
} from '../services/authApi';

interface AuthContextValue {
  user: AccountProfile | null;
  loading: boolean;
  authModalOpen: boolean;
  authModalReason: string | null;
  accountSettingsOpen: boolean;
  openAuthModal: (reason?: string | null) => void;
  closeAuthModal: () => void;
  openAccountSettings: () => void;
  closeAccountSettings: () => void;
  requireAuth: (reason: string, onAuthed: () => void) => void;
  login: (identifier: string, password: string) => Promise<AccountProfile>;
  register: (email: string, username: string, password: string) => Promise<AccountProfile>;
  logout: () => Promise<void>;
  changeUsername: (nextUsername: string) => Promise<AccountProfile>;
  resetProgress: () => Promise<AccountProfile>;
  commitMatch: (input: MatchResultInput) => Promise<MatchProgressionSummary | null>;
  refreshUser: () => Promise<void>;
  effectiveRank: number;
  unlockedAttachmentSet: ReadonlySet<string>;
  isWeaponUnlocked: (weaponId: string) => boolean;
  isAttachmentUnlocked: (attachmentId: string) => boolean;
  getWeaponProgress: (weaponId: string) => WeaponProgressRecord;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authModalReason, setAuthModalReason] = useState<string | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      const acct = await fetchCurrentAccount();
      setUser(acct);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const persistAccountKeybinds = useCallback(async (overrides: KeybindOverrides) => {
    const updatedUser = await updateAccountKeybinds(overrides);
    setUser((prev) =>
      prev && prev.id === updatedUser.id
        ? { ...prev, keybinds: updatedUser.keybinds ?? {} }
        : prev,
    );
  }, []);

  useEffect(() => {
    if (user) {
      keybindStore.setActiveUser(user.id, user.keybinds ?? {}, persistAccountKeybinds);
      backpackUnlockStore.setActiveUser(user.id);
    } else {
      keybindStore.setActiveUser(null, null, null);
      backpackUnlockStore.setActiveUser(null);
    }
  }, [user?.id, persistAccountKeybinds]);

  const openAuthModal = useCallback((reason?: string | null) => {
    setAuthModalReason(reason ?? null);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
    setAuthModalReason(null);
    setPendingAction(null);
  }, []);

  const openAccountSettings = useCallback(() => {
    if (!user) {
      openAuthModal('Sign in to manage your account settings, username, and career progress.');
      return;
    }
    setAccountSettingsOpen(true);
  }, [openAuthModal, user]);

  const closeAccountSettings = useCallback(() => {
    setAccountSettingsOpen(false);
  }, []);

  const requireAuth = useCallback(
    (reason: string, onAuthed: () => void) => {
      if (user) {
        onAuthed();
        return;
      }
      setPendingAction(() => onAuthed);
      setAuthModalReason(reason);
      setAuthModalOpen(true);
    },
    [user],
  );

  const runPendingAfterAuth = useCallback(() => {
    setAuthModalOpen(false);
    setAuthModalReason(null);
    setPendingAction((prev) => {
      if (prev) {
        setTimeout(() => prev(), 0);
      }
      return null;
    });
  }, []);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const acct = await loginAccount({ identifier, password });
      setUser(acct);
      runPendingAfterAuth();
      return acct;
    },
    [runPendingAfterAuth],
  );

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      const acct = await registerAccount({ email, username, password });
      setUser(acct);
      runPendingAfterAuth();
      return acct;
    },
    [runPendingAfterAuth],
  );

  const logout = useCallback(async () => {
    await logoutAccount();
    setUser(null);
    setAccountSettingsOpen(false);
  }, []);

  const changeUsername = useCallback(async (nextUsername: string) => {
    const acct = await updateAccountUsername(nextUsername);
    setUser(acct);
    return acct;
  }, []);

  const resetProgress = useCallback(async () => {
    const acct = await resetAccountProgress();
    setUser(acct);
    return acct;
  }, []);

  const commitMatch = useCallback(
    async (input: MatchResultInput): Promise<MatchProgressionSummary | null> => {
      if (!user) return null;
      try {
        const prevRank = user.rank ?? 1;
        const { user: updatedUser, summary } = await commitMatchProgression(input);
        setUser(updatedUser);
        const nextRank = updatedUser.rank ?? prevRank;
        if (nextRank > prevRank) {
          (Object.keys(BACKPACK_UNLOCK_RANK) as BackpackTemplateId[]).forEach((packId) => {
            const req = BACKPACK_UNLOCK_RANK[packId];
            if (prevRank < req && nextRank >= req && !backpackUnlockStore.isDiscoveredInWorld(packId)) {
              backpackUnlockStore.notifyRankUnlock(packId);
            }
          });
        }
        return summary;
      } catch {
        return null;
      }
    },
    [user],
  );

  const effectiveRank = user?.rank ?? 1;

  const unlockedAttachmentSet = useMemo(() => {
    const set = new Set<string>(getStarterUnlockedAttachments());
    for (const grant of getAutoScopesForUnlockedRank(effectiveRank)) {
      set.add(grant.attachmentId);
    }
    if (user?.unlockedAttachments) {
      for (const id of user.unlockedAttachments) {
        set.add(id);
      }
    }
    return set;
  }, [effectiveRank, user?.unlockedAttachments]);

  const isWeaponUnlocked = useCallback(
    (weaponId: string) => isWeaponUnlockedAtRank(weaponId, effectiveRank),
    [effectiveRank],
  );

  const isAttachmentUnlocked = useCallback(
    (attachmentId: string) => unlockedAttachmentSet.has(attachmentId),
    [unlockedAttachmentSet],
  );

  const getWeaponProgress = useCallback(
    (weaponId: string): WeaponProgressRecord => {
      const rec = user?.weaponProgress?.[weaponId];
      if (rec) return rec;
      return { weaponId, xp: 0, level: 1, kills: 0 };
    },
    [user?.weaponProgress],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      authModalOpen,
      authModalReason,
      accountSettingsOpen,
      openAuthModal,
      closeAuthModal,
      openAccountSettings,
      closeAccountSettings,
      requireAuth,
      login,
      register,
      logout,
      changeUsername,
      resetProgress,
      commitMatch,
      refreshUser,
      effectiveRank,
      unlockedAttachmentSet,
      isWeaponUnlocked,
      isAttachmentUnlocked,
      getWeaponProgress,
    }),
    [
      user,
      loading,
      authModalOpen,
      authModalReason,
      accountSettingsOpen,
      openAuthModal,
      closeAuthModal,
      openAccountSettings,
      closeAccountSettings,
      requireAuth,
      login,
      register,
      logout,
      changeUsername,
      resetProgress,
      commitMatch,
      refreshUser,
      effectiveRank,
      unlockedAttachmentSet,
      isWeaponUnlocked,
      isAttachmentUnlocked,
      getWeaponProgress,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
