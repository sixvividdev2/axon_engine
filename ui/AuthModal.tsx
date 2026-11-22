import React, { useState } from 'react';
import { Lock, LogIn, ShieldCheck, UserPlus, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/authApi';

export const AuthModal: React.FC = () => {
  const { authModalOpen, authModalReason, closeAuthModal, login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authModalOpen) return null;

  const resetFormState = (nextMode: 'login' | 'register') => {
    setMode(nextMode);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'register') {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      setSubmitting(true);
      try {
        await register(email.trim(), username.trim(), password);
        setPassword('');
        setConfirmPassword('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to create account.');
      } finally {
        setSubmitting(false);
      }
    } else {
      setSubmitting(true);
      try {
        await login(identifier.trim(), password);
        setPassword('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
      } finally {
        setSubmitting(false);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="font-mono-tabular text-[11px] uppercase tracking-[0.18em] text-amber-400">
              Account Access
            </div>
            <h2
              id="auth-modal-title"
              className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50"
            >
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </h2>
          </div>
          <button
            type="button"
            onClick={closeAuthModal}
            aria-label="Close sign in dialog"
            className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Context Banner */}
        {authModalReason && (
          <div className="flex items-start gap-2.5 border-b border-neutral-800 bg-neutral-900/70 px-6 py-3 text-xs text-neutral-300">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{authModalReason}</span>
          </div>
        )}

        {/* Mode Switcher */}
        <div className="grid grid-cols-2 border-b border-neutral-800">
          <button
            type="button"
            onClick={() => resetFormState('login')}
            className={`flex cursor-pointer items-center justify-center gap-2 py-3 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
              mode === 'login'
                ? 'border-b-2 border-amber-400 bg-neutral-900/80 text-neutral-50'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <LogIn className="h-3.5 w-3.5" />
            <span>Sign In</span>
          </button>
          <button
            type="button"
            onClick={() => resetFormState('register')}
            className={`flex cursor-pointer items-center justify-center gap-2 py-3 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
              mode === 'register'
                ? 'border-b-2 border-amber-400 bg-neutral-900/80 text-neutral-50'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span>Create Account</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
          {error && (
            <div className="border border-red-700/80 bg-red-950/60 px-3.5 py-2.5 text-xs text-red-200">
              {error}
            </div>
          )}

          {mode === 'login' ? (
            <div>
              <label
                htmlFor="auth-identifier"
                className="block font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400"
              >
                Username or Email
              </label>
              <input
                id="auth-identifier"
                type="text"
                autoComplete="username"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="callsign or you@example.com"
                className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
              />
            </div>
          ) : (
            <>
              <div>
                <label
                  htmlFor="auth-email"
                  className="block font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400"
                >
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@example.com"
                  className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="auth-username"
                  className="block font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400"
                >
                  Unique Username (3–20 chars)
                </label>
                <input
                  id="auth-username"
                  type="text"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={20}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Letters, numbers, _ or -"
                  className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label
              htmlFor="auth-password"
              className="block font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400"
            >
              Password {mode === 'register' ? '(8+ characters)' : ''}
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label
                htmlFor="auth-password-confirm"
                className="block font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400"
              >
                Confirm Password
              </label>
              <input
                id="auth-password-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-1 w-full cursor-pointer bg-amber-500 px-5 py-2.5 font-display text-base font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting
              ? 'Verifying...'
              : mode === 'login'
                ? 'Sign In'
                : 'Create Account'}
          </button>

          <div className="flex items-center justify-between border-t border-neutral-800 pt-3.5 text-xs text-neutral-400">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-neutral-500" />
              <span>Singleplayer needs no account</span>
            </div>
            <button
              type="button"
              onClick={closeAuthModal}
              className="cursor-pointer font-mono-tabular text-xs font-medium text-neutral-300 underline-offset-4 hover:text-amber-300 hover:underline"
            >
              Play Solo
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
