import { describe, expect, test } from "bun:test";
import {
  withLedger,
  recordFailure,
  recordSuccess,
  shouldFallback,
  isQuarantined,
  alreadyAutoRetried,
  spendAutoRetry,
  quarantineFor,
  ledgerKey,
  type LedgerState,
} from "../src/ledger";

// El ledger real vive en C:\opengo-bridge\opencode-sync. Para los tests se usa
// un estado en memoria pasando un constructor que no toca disco.
function freshState(): LedgerState {
  return { version: 1, updatedAt: null, entries: {} };
}

describe("ledger (logica pura sobre estado en memoria)", () => {
  test("registrar un fallo aísla el modelo", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "glm-5.3-flash");
    const r = recordFailure(s, k, "rate-429", 5000, "p1");
    expect(r.failsInWindow).toBe(1);
    expect(r.quarantined).toBe(true);
  });

  test("3 fallos en la ventana activan fallback", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "qwen3.8-flash");
    for (let i = 0; i < 3; i++) recordFailure(s, k, "conn-refused", 1000, `p${i}`);
    expect(shouldFallback(s.entries[k])).toBe(true);
  });

  test("2 fallos NO activan fallback", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "qwen3.8-flash");
    for (let i = 0; i < 2; i++) recordFailure(s, k, "conn-refused", 1000, `p${i}`);
    expect(shouldFallback(s.entries[k])).toBe(false);
  });

  test("success limpia fallos y cuarentena", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "glm-5.3-flash");
    recordFailure(s, k, "rate-429", 60000, "p1");
    expect(isQuarantined(s.entries[k])).toBe(true);
    recordSuccess(s, k);
    expect(isQuarantined(s.entries[k])).toBe(false);
    expect(shouldFallback(s.entries[k])).toBe(false);
  });

  test("cuarentena expirada se libera al consultar", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "glm-5.3-flash");
    recordFailure(s, k, "rate-429", -1000, "p1"); // cuarentena en el pasado
    expect(isQuarantined(s.entries[k])).toBe(false);
  });

  test("no-balance => override de cuarentena (24h)", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "hy3");
    const e = s.entries[k] ?? { fails: [], quarantineUntil: null, consecutiveOk: 0, lastClass: null, lastHash: null, autoRetriedFor: [] };
    s.entries[k] = e;
    expect(quarantineFor(e, "no-balance", 24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  test("rate-429 sin override usa el ladder", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "glm-5.3-flash");
    const e = s.entries[k] ?? { fails: [], quarantineUntil: null, consecutiveOk: 0, lastClass: null, lastHash: null, autoRetriedFor: [] };
    s.entries[k] = e;
    e.fails = [1, 2, 3];
    expect(quarantineFor(e, "rate-429", null)).toBe(8000);
  });

  test("auto-retry se gasta una sola vez por prompt", () => {
    const s = freshState();
    const k = ledgerKey("kiosapi", "glm-5.3-flash");
    expect(alreadyAutoRetried(s.entries[k], "p1")).toBe(false);
    spendAutoRetry(s, k, "p1");
    expect(alreadyAutoRetried(s.entries[k], "p1")).toBe(true);
    spendAutoRetry(s, k, "p1"); // idempotente
    expect(s.entries[k].autoRetriedFor.filter((x) => x === "p1").length).toBe(1);
  });

  test("key junta provider y modelo", () => {
    expect(ledgerKey("kiosapi", "glm-5.3-flash")).toBe("kiosapi/glm-5.3-flash");
  });
});

describe("ledger (disco, aislado a temp)", () => {
  test("withLedger persiste y reléè estado", async () => {
    // Aislar del runtime real (C:\opengo-bridge\opencode-sync).
    // path.join: portable Windows/Linux (el backslash hardcodeado rompia CI).
    const tmp = require("node:path").join(
      require("node:os").tmpdir(),
      `models-fix-test-${Date.now()}`,
    );
    require("node:fs").mkdirSync(tmp, { recursive: true });
    process.env.MODELS_FIX_SYNC_DIR = tmp;

    const k = ledgerKey("test", "probe-disk");
    const r1 = await withLedger((s) => recordFailure(s, k, "gateway-timeout", 1000, "pd"));
    expect(r1).not.toBeNull();
    const r2 = await withLedger((s) => s.entries[k]?.fails.length ?? 0);
    expect(r2).toBe(1);

    delete process.env.MODELS_FIX_SYNC_DIR;
  });
});
