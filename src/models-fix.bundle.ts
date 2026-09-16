// AUTOGENERADO por scripts/bundle.mjs — NO editar a mano.
// Fuente modular: src/{classifier,ledger,models-fix}.ts (repo).
// Un solo fichero porque cada .ts en plugins/ es un plugin y debe
// default-exportar una funcion.

// classifier.ts — clasificador puro de errores de modelo.
// 100% sin I/O: recibe el mensaje de error del log y devuelve clase + política.
// Cobertura: tests/classifier.test.ts con las 10 firmas reales del 2026-09-16.

export type ErrorClass =
  | "no-balance"
  | "group-disabled"
  | "content-filter"
  | "ctx-overflow"
  | "encrypted-reasoning"
  | "no-channel"
  | "rate-429"
  | "bad-request"
  | "conn-refused"
  | "gateway-timeout"
  | "unknown";

/** Qué hacer con el modelo que acaba de fallar. */
export type Advice =
  | "no" // jamas reintentar este modelo ahora
  | "same" // reintentar el mismo modelo tras espera
  | "same-sanitized" // reintentar tras sanear el payload (G2)
  | "fallback"; // cambiar de modelo

export interface ClassifyResult {
  cls: ErrorClass;
  advice: Advice;
  retryable: boolean;
  /** ms de cuarentena, o null si no aplica */
  quarantineMs: number | null;
  /** reset que el upstream nos comunico (ej. "reset after 26s"), o null */
  resetAfterMs: number | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Rule {
  cls: ErrorClass;
  advice: Advice;
  quarantineMs: number | null;
  re: RegExp;
}

// Orden importa: primera regla que matchea gana.
// Las no-reintentables van primero (no tienen sentido reintentar).
const RULES: Rule[] = [
  {
    cls: "no-balance",
    advice: "no",
    quarantineMs: DAY,
    re: /insufficient balance|balance=0|insufficient_user_qu/i,
  },
  {
    cls: "group-disabled",
    advice: "no",
    quarantineMs: DAY,
    re: /GROUP_DISABLED|API Key .{0,40}(invalid|disabled|not authorized)/i,
  },
  {
    cls: "content-filter",
    advice: "no",
    quarantineMs: DAY,
    re: /inappropriate content|data_inspect/i,
  },
  {
    cls: "ctx-overflow",
    advice: "no",
    quarantineMs: null, //accion de sesion, no de modelo
    re: /context limit|input tokens exceed|maximum context length|too many tokens/i,
  },
  {
    cls: "encrypted-reasoning",
    advice: "same-sanitized",
    quarantineMs: null, //G2 sanea; no es culpa del modelo
    re: /encrypted_content/i,
  },
  {
    cls: "no-channel",
    advice: "fallback",
    quarantineMs: 30 * MIN,
    re: /No available channel/i,
  },
  {
    cls: "rate-429",
    advice: "same",
    quarantineMs: null, //se calcula con resetAfter o el ladder del ledger
    re: /request id: 20\d\d|rate_limit_exceeded|concurrency limit reached|\b429\b/i,
  },
  {
    cls: "bad-request",
    advice: "fallback",
    quarantineMs: 15 * MIN,
    re: /openai_error/i,
  },
  {
    cls: "conn-refused",
    advice: "same",
    quarantineMs: 30_000,
    re: /Unable to connect|typo in the url|socket connection was closed|Invalid URL \(/i,
  },
  {
    cls: "gateway-timeout",
    advice: "same",
    quarantineMs: 60_000,
    re: /Gateway Timeout|Bad Gateway|ProviderHeaderTimeout|temporarily overloaded|\s<none>\s*$|:\s*<none>/i,
  },
];

const RESET_RE = /reset after (\d+)\s*(s|sec|seconds|m|min|minutes)/i;

function parseResetAfter(msg: string): number | null {
  const m = msg.match(RESET_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith("m") ? MIN : 1000;
  return Math.min(n * mult, 6 * HOUR);
}

/**
 * Clasifica un error de modelo.
 * @param msg el error.message tal cual llega en el log / session.error
 */
export function classify(msg: string | undefined | null): ClassifyResult {
  const text = String(msg ?? "");
  const resetAfterMs = parseResetAfter(text);

  for (const r of RULES) {
    if (r.re.test(text)) {
      const retryable = r.advice !== "no";
      let quarantineMs = r.quarantineMs;
      // rate-429: si el upstream nos dijo el reset, se lo respeta;
      // si no, el ledger aplica su ladder.
      if (r.cls === "rate-429" && resetAfterMs) quarantineMs = resetAfterMs;
      return { cls: r.cls, advice: r.advice, retryable, quarantineMs, resetAfterMs };
    }
  }

  return {
    cls: "unknown",
    advice: "fallback",
    retryable: true,
    quarantineMs: 5 * MIN,
    resetAfterMs,
  };
}

/** Etiqueta corta para logs/toasts. */
export function shortLabel(c: ClassifyResult): string {
  return `${c.cls}→${c.advice}${c.quarantineMs ? `@${Math.round(c.quarantineMs / 1000)}s` : ""}`;
}


﻿// ledger.ts â€” estado de fallos por provider/model.
// Ventana deslizante + cuarentenas + lock con TTL + escritura atomica.
// Runtime: C:\opengo-bridge\opencode-sync\models-fix-state.json

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

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


﻿// models-fix.ts â€” server plugin.
// Guardias pre-request (G1/G2/G3) + handler de session.error + ranking de
// fallback + escritura del buzon para el TUI compaÃ±ero.
//
// Limitacion del SDK (verificada en @opencode-ai/plugin/dist/index.d.ts):
// no hay hook chat.error ni forma de cambiar el modelo sincronicamente. El
// reintento es reactivo: session.error -> clasificar -> cuarentena -> buzon
// -> el TUI pregunta al usuario (o auto-reintenta 1 vez el primer fallback).

import type { Plugin } from "@opencode-ai/plugin";
import fsSync from "node:fs";

const TAG = "[models-fix]";

interface Config {
  modalTimeoutMs: number;
  g1: boolean;
  g2: boolean;
  g3: boolean;
  g3Ratio: number;
  windowSize: number;
  fallbackAfterFails: number;
  contextCaps: Record<string, number>;
  fallbackChains: Record<string, string[]>;
}

const CONFIG_PATH = `${process.env.USERPROFILE ?? ""}\\.config\\opencode\\models-fix.json`;

function loadConfig(): Config {
  const defaults: Config = {
    modalTimeoutMs: 90_000,
    g1: true,
    g2: true,
    g3: true,
    g3Ratio: 0.9,
    windowSize: 5,
    fallbackAfterFails: 3,
    contextCaps: {
      "kiosapi/atria-dawn-preview": 131072,
      "kiosapi/hy3": 131072,
      "kiosapi/qwen3.8-flash": 262144,
      "kiosapi/glm-5.3-flash": 262144,
      "kiosapi/muse-spark-1.3-contributor": 262144,
      "opencode/muse-spark-1.3-contributor-free": 262144,
      "opencode/gpt-5.4-nano": 65536,
    },
    fallbackChains: {},
  };
  // La config en disco es opcional y solo lo que declara pisa defaults.
  const f = readJsonSafe(CONFIG_PATH);
  const clean = f ?? {};
  for (const key of Object.keys(clean)) {
    if (key.startsWith("$")) delete (clean as any)[key];
  }
  return {
    ...defaults,
    ...clean,
    modalTimeoutMs:
      typeof clean?.modal?.timeoutMs === "number" ? clean.modal.timeoutMs : defaults.modalTimeoutMs,
    g1: typeof clean?.guards?.g1CallIdDedupe === "boolean" ? clean.guards.g1CallIdDedupe : defaults.g1,
    g2: typeof clean?.guards?.g2StripStaleReasoning === "boolean" ? clean.guards.g2StripStaleReasoning : defaults.g2,
    g3: typeof clean?.guards?.g3ContextGuard === "boolean" ? clean.guards.g3ContextGuard : defaults.g3,
    g3Ratio:
      typeof clean?.guards?.g3ContextSafetyRatio === "number"
        ? clean.guards.g3ContextSafetyRatio
        : defaults.g3Ratio,
    windowSize: typeof clean?.window?.size === "number" ? clean.window.size : defaults.windowSize,
    fallbackAfterFails:
      typeof clean?.window?.fallbackAfterFails === "number"
        ? clean.window.fallbackAfterFails
        : defaults.fallbackAfterFails,
    contextCaps: { ...defaults.contextCaps, ...(clean?.contextCaps ?? {}) },
    fallbackChains: { ...defaults.fallbackChains, ...(clean?.fallbackChains ?? {}) },
  };
}

// ---- ranking de fallback: lee, no duplica ----

function readJsonSafe(p: string): any {
  try {
    let t = fsSync.readFileSync(p, "utf-8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * Candidatos a fallback, mejores primero. Prioriza chains manuales; si no hay,
 * usa kiosapi-efforts.json y nvidia-brute-state.json.
 */
function rankFallbacks(cfg: Config): Array<{ providerID: string; modelID: string; reason: string }> {
  const out: Array<{ providerID: string; modelID: string; reason: string }> = [];
  const seen = new Set<string>();

  const push = (providerID: string, modelID: string, reason: string) => {
    const k = `${providerID}/${modelID}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ providerID, modelID, reason });
  };

  // 1) chains manuales
  for (const [from, list] of Object.entries(cfg.fallbackChains)) {
    for (const target of list) {
      const [p, ...rest] = target.split("/");
      if (rest.length) push(p, rest.join("/"), `chain de ${from}`);
    }
  }
  if (out.length) return out.slice(0, 5);

  // 2) kiosapi-efforts.json: ok > ok_flaky > recovered_pending
  try {
    const eff = readJsonSafe(
      `${process.env.USERPROFILE}\\.config\\opencode\\kiosapi-efforts.json`,
    );
    const models = eff?.models ?? {};
    const order = { ok: 0, ok_flaky: 1, recovered_pending: 2 };
    const picks: Array<[string, number]> = [];
    for (const [id, m] of Object.entries<any>(models)) {
      const st = m?.state;
      if (!st || !(st in order)) continue;
      if (m?.notExposed || m?.paidRemoved) continue;
      picks.push([id, order[st as keyof typeof order]]);
    }
    picks.sort((a, b) => a[1] - b[1]);
    for (const [id] of picks.slice(0, 3)) {
      // los ids aca son "slug" (sin provider); kiosapi-efforts usa claves
      // como "glm-5.3-flash" o "nvidia/nemotron-...". Se normaliza.
      const [p, ...rest] = id.split("/");
      if (rest.length) push(p || "kiosapi", rest.join("/"), "kiosapi state ok");
      else push("kiosapi", id, "kiosapi state ok");
    }
  } catch {}

  // 3) nvidia-brute-state.json: ok > soft
  try {
    const nb = readJsonSafe("C:\\opengo-bridge\\opencode-sync\\nvidia-brute-state.json");
    const models = nb?.models ?? {};
    const picks: Array<[string, number]> = [];
    for (const [id, m] of Object.entries<any>(models)) {
      const st = m?.status;
      if (st !== "ok" && st !== "soft") continue;
      picks.push([id, st === "ok" ? 0 : 1]);
    }
    picks.sort((a, b) => a[1] - b[1]);
    for (const [id] of picks.slice(0, 2)) push("nvidia", id, "nvidia brute ok/soft");
  } catch {}

  return out.slice(0, 5);
}

// ---- guardias ----

function lastAgentFor(sessionID: string, map: Map<string, string>): string | undefined {
  return map.get(sessionID);
}

function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m?.parts ?? []) {
      const anyP = p as any;
      if (typeof anyP?.text === "string") chars += anyP.text.length;
      if (typeof anyP?.callID === "string") chars += anyP.callID.length;
      if (anyP?.state && typeof anyP.state === "object") {
        chars += JSON.stringify(anyP.state).length;
      }
    }
  }
  return Math.ceil(chars / 4); // heuristica clasica
}

export const ModelsFix: Plugin = async (ctx) => {
  const cfg = loadConfig();
  const client = (ctx as any)?.client;

  // agente actual por sesion (para G2)
  const agentBySession = new Map<string, string>();
  // ultimo prompt por sesion (snapshot para re-prompt)
  const lastPrompt = new Map<string, string>();
  // guard in-flight por sesion con expiracion (nunca mute permanente):
  // un error -> un modal; si vuelve a fallar pasados 3 min, puede re-abrir.
  const INFLIGHT_TTL_MS = 3 * 60_000;
  const inflightSince = new Map<string, number>();
  const inFlight = (sessionID: string): boolean => {
    const t = inflightSince.get(sessionID);
    if (t === undefined) return false;
    if (Date.now() - t > INFLIGHT_TTL_MS) {
      inflightSince.delete(sessionID);
      return false;
    }
    return true;
  };

  const toast = (title: string, message: string, variant: any = "warning") => {
    try {
      client?.tui?.showToast?.({ body: { title, message, variant } });
    } catch {}
  };

  console.log(`${TAG} activo (g1=${cfg.g1} g2=${cfg.g2} g3=${cfg.g3})`);

  return {
    // ---- capturar agente + prompt para G2 y re-prompt ----
    "chat.message": async (input, output) => {
      if (input.sessionID && input.agent) agentBySession.set(input.sessionID, input.agent);
      const text = (output.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text ?? "")
        .join("\n");
      if (text.length > 10 && input.sessionID) lastPrompt.set(input.sessionID, text);
    },

    // ---- guardias pre-request ----
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output?.messages;
      if (!Array.isArray(msgs) || msgs.length === 0) return;

      // G1: dedupe determinista de callIDs (absorbido de muse-fix)
      if (cfg.g1) {
        const counts = new Map<string, number>();
        for (const m of msgs) {
          for (const p of m.parts || []) {
            const anyP = p as any;
            if (anyP?.type === "tool" && anyP?.callID) {
              const id = String(anyP.callID);
              counts.set(id, (counts.get(id) || 0) + 1);
            }
          }
        }
        if (counts.size > 0) {
          let collisions = 0;
          for (const n of counts.values()) if (n > 1) collisions++;
          if (collisions > 0) {
            let runCounter = 0;
            const occurrence = new Map<string, number>();
            let rewritten = 0;
            runCounter++;
            for (const m of msgs) {
              for (const p of m.parts || []) {
                const anyP = p as any;
                if (anyP?.type !== "tool" || !anyP?.callID) continue;
                const id = String(anyP.callID);
                if ((counts.get(id) || 0) <= 1) continue;
                const n = (occurrence.get(id) || 0) + 1;
                occurrence.set(id, n);
                if (n === 1) continue;
                const newId = `${id}~r${runCounter}n${n}`;
                anyP.callID = newId;
                if (anyP.state && typeof anyP.state === "object") {
                  anyP.state.callID = newId;
                  if (anyP.state.metadata && typeof anyP.state.metadata === "object") {
                    anyP.state.metadata.callID = newId;
                  }
                }
                rewritten++;
              }
            }
            if (rewritten > 0) {
              console.log(`${TAG} G1 call_ids dedupe: ${rewritten} (${collisions} ids)`);
            }
          }
        }
      }

      // G2: strip reasoning stale si cambio el agente (reasoning sigue ON)
      // G3: context guard
      // NOTA: G2/G3 necesitan saber provider/model/contexto; este hook no los
      // recibe. Se implementan en v0.2 leyendo config + espiando chat.params.
      // (Esqueleto reservado; no opera hasta v0.2.)
    },

    // ---- error post-fallo ----
    event: async ({ event }) => {
      if (event.type !== "session.error") return;

      const props = (event.properties ?? {}) as {
        sessionID?: string;
        error?: any;
      };
      const sessionID = props.sessionID;
      const err = props.error;
      if (!sessionID || !err) return;
      if (inFlight(sessionID)) return; // un modal a la vez (con expiracion)

      const msg = typeof err === "string" ? err : err?.message ?? JSON.stringify(err);
      const providerID = err?.providerID ?? "unknown";
      const modelID = err?.modelID ?? "unknown";
      const k = ledgerKey(providerID, modelID);

      const c = classify(msg);
      const promptSnapshot = lastPrompt.get(sessionID) ?? "";
      const promptHash = hashPrompt(promptSnapshot);

      console.log(`${TAG} ${k} ${shortLabel(c)}`);

      await withLedger((state: LedgerState) => {
        if (c.advice === "no") {
          // no se reintenta: registrar y avisar
          recordFailure(state, k, c.cls, c.quarantineMs, promptHash);
          return;
        }
        recordFailure(state, k, c.cls, c.quarantineMs, promptHash);

        // success path futuro: cuando llega session.idle sin error, recordSuccess
        const entry = state.entries[k];
        const needsFallback =
          c.advice === "fallback" ||
          c.advice === "same-sanitized" ||
          (entry ? shouldFallback(entry) : false);
        if (!needsFallback) return;

        // anti-loop: 1 solo auto-reintento por prompt
        const autoEligible = !alreadyAutoRetried(entry, promptHash);

        const candidates = rankFallbacks(cfg);
        const req: RetryRequest = {
          sessionID,
          providerID,
          modelID,
          cls: c.cls,
          advice: c.advice,
          candidates,
          promptSnapshot,
          promptHash,
          chainDepth: 0,
          createdAt: 0,
        };

        void writeRetry(req).then(async () => {
          inflightSince.set(sessionID, Date.now());
          if (autoEligible && candidates.length > 0) {
            // el TUI hace la pregunta; si expira, auto-reintenta el #1.
            // El gasto del auto-retry lo marca el TUI al dispararlo.
            toast(
              "Models Fix",
              `${k} â†’ ${c.cls}. Elige modelo para reintentar (auto: ${candidates[0].providerID}/${candidates[0].modelID} en ${Math.round(cfg.modalTimeoutMs / 1000)}s).`,
            );
          } else {
            toast(
              "Models Fix",
              `${k} â†’ ${c.cls}. Auto-reintento agotado para este prompt: elige modelo manualmente.`,
              "error",
            );
          }
        });
      });
    },
  };
};

export default ModelsFix;
