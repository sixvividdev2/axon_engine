/**
 * Web Crypto utilities shared by Cloudflare Workers and the local Node preview server.
 *
 * CRITICAL CLOUDFLARE GOTCHA:
 * Production Cloudflare Workers hard-caps PBKDF2 at 100,000 iterations
 * (higher values throw NotSupportedError in production even when wrangler dev passes).
 */
export const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const SESSION_COOKIE_NAME = 'cordon_session';

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function generateRandomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function generateId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return generateRandomHex(16);
}

export function timingSafeEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) {
    diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  }
  return diff === 0;
}

async function applyPepper(password: string, pepper: string): Promise<Uint8Array> {
  if (!pepper) {
    return encoder.encode(password);
  }
  const hmacKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
  return new Uint8Array(sig);
}

/**
 * Derives a 256-bit password hash using HMAC-SHA256 peppering + PBKDF2-SHA256
 * capped strictly at 100,000 iterations for Cloudflare Workers compatibility.
 */
export async function hashPassword(
  password: string,
  pepper: string,
  existingSaltHex?: string,
): Promise<{ hashHex: string; saltHex: string }> {
  const saltHex = existingSaltHex ?? generateRandomHex(16);
  const saltBytes = hexToBytes(saltHex);
  const keyMaterialBytes = await applyPepper(password, pepper);

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    keyMaterialBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  return {
    hashHex: bytesToHex(new Uint8Array(derivedBits)),
    saltHex,
  };
}

export async function verifyPassword(
  password: string,
  pepper: string,
  storedSaltHex: string,
  storedHashHex: string,
): Promise<boolean> {
  const { hashHex } = await hashPassword(password, pepper, storedSaltHex);
  return timingSafeEqual(hashHex, storedHashHex);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieHeader) return map;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      map[key] = decodeURIComponent(val);
    }
  }
  return map;
}

export function buildSessionCookie(token: string, isHttps: boolean): string {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  if (isHttps) {
    // SameSite=None; Secure; Partitioned supports both top-level custom domains and embedded previews
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSec}`;
  }
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function buildClearSessionCookie(isHttps: boolean): string {
  if (isHttps) {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`;
  }
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 160) return 'Enter a valid email address.';
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return ok ? null : 'Enter a valid email address.';
}

export function validateUsername(username: string): string | null {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20) {
    return 'Username must be between 3 and 20 characters.';
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return 'Username may only use letters, numbers, underscores, or hyphens.';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  return null;
}
