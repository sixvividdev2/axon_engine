/**
 * Minimal self-contained Cloudflare Workers runtime interfaces so Worker code compiles cleanly
 * alongside the Vite/Node TypeScript workspace without conflicting DOM/Node type definitions.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface CloudflareWebSocket extends WebSocket {
  accept?: () => void;
  serializeAttachment?: (value: unknown) => void;
  deserializeAttachment?: () => unknown;
}

export interface DurableObjectState {
  id: DurableObjectId;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CloudflareWebSocket[];
}

export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkerEnv {
  ASSETS?: Fetcher;
  DB: D1Database;
  SOCIAL_HUB: DurableObjectNamespace;
  LOBBY_ROOM: DurableObjectNamespace;
  PASSWORD_PEPPER?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
}

export type PresenceStatus = 'offline' | 'online' | 'in_lobby' | 'in_match';

export interface UserPresenceState {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  status: PresenceStatus;
  lobbyCode?: string | null;
  lobbyVisibility?: 'public' | 'friends_only' | 'private' | null;
  lobbyMode?: string | null;
  eventName?: string | null;
  joinable?: boolean;
  updatedAt: number;
}
