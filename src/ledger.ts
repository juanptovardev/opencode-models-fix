// ledger.ts â€” estado de fallos por provider/model.
// Ventana deslizante + cuarentenas + lock con TTL + escritura atomica.
// Runtime: C:\opengo-bridge\opencode-sync\models-fix-state.json

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ErrorClass } from "./classifier.js";

const LOCK_TTL_MS = 90_000; // 90s: el error-path es corto, no 15 min
const RETRY_TTL_MS = 10 * 60_000;
const WINDOW_SIZE = 5;
const WINDOW_MS = 15 * 60_000;
const QUARANTINE_CAP_MS = 6 * 60 * 60_000; // 6h
const RATE_LADDER_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
const MAX_AUTO_RETRY = 1; // regla del usuario: 1 solo auto-reintento

// Directorio de runtime. En tests se aÃ­sla con MODELS_FIX_SYNC_DIR (se lee
// perezosamente para que el env pueda setearse despues del import).
const DEFAULT_SYNC_DIR = "C:\\opengo-bridge\\opencode-sync";
function syncDir(): string {
  return process.env.MODELS_FIX_SYNC_DIR ?? DEFAULT_SYNC_DIR;
}
function statePath(): string {
  return path.join(syncDir(), "models-fix-state.json");
}
function lockPath(): string {
  return path.join(syncDir(), "models-fix.lock");
}
function retryPath(): string {
  return path.join(syncDir(), "models-fix-retry.json");
}

export interface LedgerEntry {
  fails: number[]; // timestamps dentro de la ventana
  quarantineUntil: number | null;
  consecutiveOk: number;
  lastClass: ErrorClass | null;
  lastHash: string | null;
  /** promptHashes que ya recibieron auto-reintento (anti-loop) */
  autoRetriedFor: string[];
}

export interface LedgerState {
  version: number;
  updatedAt: string | null;
  entries: Record<string, LedgerEntry>;
}

export function ledgerKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

function emptyEntry(): LedgerEntry {
  return {
    fails: [],
    quarantineUntil: null,
    consecutiveOk: 0,
    lastClass: null,
    lastHash: null,
    autoRetriedFor: [],
  };
}

function nowMs(): number {
  return Date.now();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- lectura/escritura atomica ----

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    let text = await fs.readFile(p, "utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function atomicWrite(p: string, data: unknown): Promise<void> {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.unlink(p).catch(() => {}); // Windows: rename exige destino ausente
  await fs.rename(tmp, p);
}

// ---- lock con recuperacion de stale ----

async function acquireLock(): Promise<boolean> {
  try {
    await fs.mkdir(syncDir(), { recursive: true });
  } catch {}
  if (existsSync(lockPath())) {
    try {
      const st = await fs.stat(lockPath());
      const age = Date.now() - st.mtimeMs;
      if (age < LOCK_TTL_MS) return false; // alguien mas lo tiene
    } catch {}
  }
  await fs.writeFile(lockPath(), String(process.pid), "utf-8");
  return true;
}

async function releaseLock(): Promise<void> {
  await fs.unlink(lockPath()).catch(() => {});
}

/**
 * Ejecuta `fn` bajo lock, con el estado cargado, y lo persiste al volver.
 * Si el lock no se obtiene, `fn` no corre (error-path: mejor perder un evento
 * que corruptear estado).
 */
export async function withLedger<T>(
  fn: (state: LedgerState) => T | Promise<T>,
): Promise<T | null> {
  if (!(await acquireLock())) return null;
  try {
    const raw = await readJson<LedgerState | null>(statePath(), null);
    const state: LedgerState =
      raw && raw.version === 1 && raw.entries
        ? raw
        : { version: 1, updatedAt: null, entries: {} };
    const result = await fn(state);
    state.updatedAt = nowIso();
    await atomicWrite(statePath(), state);
    return result;
  } catch {
    return null;
  } finally {
    await releaseLock();
  }
}

// ---- logica de ventana ----

function pruneFails(entry: LedgerEntry, now: number): number[] {
  const cutoff = now - WINDOW_MS;
  const kept = entry.fails.filter((t) => t >= cutoff);
  entry.fails = kept;
  return kept;
}

/** Â¿Cuanta cuarentena le toca a este modelo segun su historial? */
export function quarantineFor(
  entry: LedgerEntry,
  cls: ErrorClass,
  overrideMs: number | null,
): number {
  // Overrides explicitos (no-balance 24h; reset que el upstream nos comunico,
  // ya capeado a 6h en el classifier) se respetan tal cual.
  if (overrideMs) return overrideMs;
  if (cls === "rate-429") {
    const idx = Math.min(entry.fails.length, RATE_LADDER_MS.length) - 1;
    return RATE_LADDER_MS[Math.max(0, idx)];
  }
  return 0;
}

export interface RecordResult {
  /** fallos dentro de la ventana tras registrar este */
  failsInWindow: number;
  /** true si el modelo esta en cuarentena ahora */
  quarantined: boolean;
}

/** Registra un fallo. Debe llamarse dentro de withLedger. */
export function recordFailure(
  state: LedgerState,
  k: string,
  cls: ErrorClass,
  quarantineMs: number | null,
  promptHash: string | null,
): RecordResult {
  const now = nowMs();
  const entry = state.entries[k] ?? emptyEntry();
  state.entries[k] = entry;

  pruneFails(entry, now);
  entry.fails.push(now);
  entry.lastClass = cls;
  entry.lastHash = promptHash;
  entry.consecutiveOk = 0;

  const q = quarantineFor(entry, cls, quarantineMs);
  if (q > 0) entry.quarantineUntil = now + q;

  return { failsInWindow: entry.fails.length, quarantined: q > 0 };
}

/** Marca un ok (saca de cuarentena y reinicia la ventana). */
export function recordSuccess(state: LedgerState, k: string): void {
  const entry = state.entries[k] ?? emptyEntry();
  state.entries[k] = entry;
  entry.fails = [];
  entry.quarantineUntil = null;
  entry.consecutiveOk += 1;
  entry.lastClass = null;
}

/** Â¿Supera el umbral de fallos como para hacer fallback? */
export function shouldFallback(entry: LedgerEntry): boolean {
  const now = nowMs();
  const fails = pruneFails(entry, now);
  return fails.length >= 3; // >=3 en ventana de 15 min -> fallback
}

export function isQuarantined(entry: LedgerEntry | undefined): boolean {
  if (!entry) return false;
  if (!entry.quarantineUntil) return false;
  if (Date.now() >= entry.quarantineUntil) {
    entry.quarantineUntil = null;
    return false;
  }
  return true;
}

/** Â¿Ya consumio este prompt su unico auto-reintento? */
export function alreadyAutoRetried(entry: LedgerEntry | undefined, promptHash: string): boolean {
  if (!entry) return false;
  return entry.autoRetriedFor.includes(promptHash);
}

/** Gasta el auto-reintento de un prompt. */
export function spendAutoRetry(
  state: LedgerState,
  k: string,
  promptHash: string,
): void {
  const entry = state.entries[k] ?? emptyEntry();
  state.entries[k] = entry;
  if (!entry.autoRetriedFor.includes(promptHash)) {
    entry.autoRetriedFor.push(promptHash);
    if (entry.autoRetriedFor.length > 64) entry.autoRetriedFor.shift();
  }
}

export const MAX_AUTO_RETRIES = MAX_AUTO_RETRY;

// ---- buzon server -> tui (efimero) ----

export interface RetryRequest {
  sessionID: string;
  messageID?: string;
  providerID: string;
  modelID: string;
  cls: string;
  advice: string;
  candidates: Array<{ providerID: string; modelID: string; reason: string }>;
  promptSnapshot: string;
  promptHash: string;
  chainDepth: number;
  createdAt: number;
}

export async function writeRetry(req: RetryRequest): Promise<void> {
  req.createdAt = Date.now();
  await atomicWrite(retryPath(), req);
}

export async function readRetry(): Promise<RetryRequest | null> {
  const req = await readJson<RetryRequest | null>(retryPath(), null);
  if (!req) return null;
  if (Date.now() - req.createdAt > RETRY_TTL_MS) {
    await fs.unlink(retryPath()).catch(() => {});
    return null;
  }
  return req;
}

export async function consumeRetry(): Promise<void> {
  await fs.unlink(retryPath()).catch(() => {});
}

// ---- util ----

export function hashPrompt(text: string): string {
  let h = 0;
  const s = text.slice(0, 4096);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `p${(h >>> 0).toString(36)}`;
}

export { statePath, retryPath, WINDOW_SIZE, WINDOW_MS, QUARANTINE_CAP_MS };
