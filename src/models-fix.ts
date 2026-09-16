// models-fix.ts — server plugin.
// Guardias pre-request (G1/G2/G3) + handler de session.error + ranking de
// fallback + escritura del buzon para el TUI compañero.
//
// Limitacion del SDK (verificada en @opencode-ai/plugin/dist/index.d.ts):
// no hay hook chat.error ni forma de cambiar el modelo sincronicamente. El
// reintento es reactivo: session.error -> clasificar -> cuarentena -> buzon
// -> el TUI pregunta al usuario (o auto-reintenta 1 vez el primer fallback).

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import { classify, shortLabel } from "./classifier.js";
import {
  withLedger,
  recordFailure,
  recordSuccess,
  isQuarantined,
  shouldFallback,
  alreadyAutoRetried,
  spendAutoRetry,
  writeRetry,
  hashPrompt,
  ledgerKey,
  type LedgerState,
  type RetryRequest,
} from "./ledger.js";

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

function loadConfig(): Config {
  // Defaults en codigo; .config/opencode/models-fix.json es opcional.
  return {
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
}

// ---- ranking de fallback: lee, no duplica ----

function readJsonSafe(p: string): any {
  try {
    let t = fs.readFileSync(p, "utf-8");
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
  // guard in-flight: una sesion no genera multiples modales
  const inFlight = new Set<string>();

  const toast = (title: string, message: string, variant: any = "warning") => {
    try {
      client?.app?.toast?.({ body: { title, message, variant } });
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
      if (inFlight.has(sessionID)) return; // un modal a la vez

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
          inFlight.add(sessionID);
          if (autoEligible && candidates.length > 0) {
            // el TUI hace la pregunta; si expira, auto-reintenta el #1.
            // El gasto del auto-retry lo marca el TUI al dispararlo.
            toast(
              "Models Fix",
              `${k} → ${c.cls}. Elige modelo para reintentar (auto: ${candidates[0].providerID}/${candidates[0].modelID} en ${Math.round(cfg.modalTimeoutMs / 1000)}s).`,
            );
          } else {
            toast(
              "Models Fix",
              `${k} → ${c.cls}. Auto-reintento agotado para este prompt: elige modelo manualmente.`,
              "error",
            );
          }
        });
      });
    },
  };
};

export default ModelsFix;
