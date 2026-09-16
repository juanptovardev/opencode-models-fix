// models-fix-tui.ts — compañero TUI del server.
// Lee el buzon (models-fix-retry.json) y muestra un modal para elegir modelo
// de reintento. Timeout: 1 auto-reintento del primer candidato; si falla,
// espera indefinida (regla del usuario).
//
// Un fichero no puede ser server+tui a la vez (PluginModule exige tui?:never),
// por eso vive separado y comparte src/ledger.ts con el server.

import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import {
  readRetry,
  consumeRetry,
  spendAutoRetry,
  ledgerKey,
  hashPrompt,
  MAX_AUTO_RETRIES,
} from "../src/ledger.js";

const TAG = "[models-fix-tui]";

const tui: TuiPlugin = async (api: any) => {
  const a = api;
  let polling = false;

  const toast = (title: string, message: string, variant: any = "info") => {
    try {
      a.ui.toast({ title, message, variant });
    } catch {}
  };

  const doReprompt = async (req: any, providerID: string, modelID: string, auto: boolean) => {
    try {
      await a.client.session.prompt({
        path: { id: req.sessionID },
        body: {
          parts: [{ type: "text", text: req.promptSnapshot || "[reintento models-fix]" }],
          model: { providerID, modelID },
        },
      });
      if (auto) {
        // gastar el auto-retry de este prompt en el modelo que fallo
        void spendAutoRetryLedger(req);
      }
      toast("Models Fix", `Reintento lanzado: ${providerID}/${modelID}${auto ? " (auto)" : ""}`, "success");
    } catch (e: any) {
      toast("Models Fix", `Reintento falló: ${e?.message ?? e}`, "error");
    }
  };

  const spendAutoRetryLedger = async (req: any) => {
    // El gasto real ocurre en el server via withLedger; el TUI no puede
    // escribir bajo lock sin serializar. Se invoca al modulo compartido.
    try {
      const { withLedger } = await import("../src/ledger.js");
      await withLedger((state: any) => {
        spendAutoRetry(state, ledgerKey(req.providerID, req.modelID), req.promptHash);
      });
    } catch {}
  };

  const openModal = async () => {
    const req = await readRetry();
    if (!req) return;
    if (polling) return;
    polling = true;

    const options = req.candidates.map((c: any, i: number) => ({
      title: `${c.providerID}/${c.modelID}`,
      value: String(i),
      footer: c.reason ?? "",
    }));
    if (options.length === 0) {
      toast("Models Fix", `Sin candidatos de fallback para ${req.providerID}/${req.modelID} (${req.cls})`, "error");
      await consumeRetry();
      polling = false;
      return;
    }

    try {
      a.ui.dialog.replace(
        () =>
          a.ui.DialogSelect({
            title: `Models Fix — ${req.providerID}/${req.modelID} falló (${req.cls})`,
            placeholder: "Elige modelo de reintento",
            options,
            onSelect: async (opt: any) => {
              if (!opt) return;
              const c = req.candidates[Number(opt.value)];
              await consumeRetry();
              polling = false;
              await doReprompt(req, c.providerID, c.modelID, false);
            },
          }),
        () => {
          polling = false;
        },
      );
    } catch (e) {
      polling = false;
    }

    // Timeout: auto-reintento del primer candidato (1 sola vez por prompt).
    // Si ya se gasto, no se auto-lanza: el modal queda abierto esperando.
    setTimeout(async () => {
      const stillThere = await readRetry();
      if (!stillThere || stillThere.promptHash !== req.promptHash) return;
      const first = req.candidates[0];
      await consumeRetry();
      polling = false;
      await doReprompt(req, first.providerID, first.modelID, true);
    }, 90_000);
  };

  // El TUI se entera via buzon en disco. Se sondea al arrancar y ante eventos
  // de sesion (en v0.3 se afina a un interval corto dedicado).
  try {
    a.event.on("message.updated", () => { void openModal(); });
    a.event.on("session.error", () => { void openModal(); });
  } catch {}

  void openModal();
};

export default {
  id: "models-fix-tui",
  tui,
};
