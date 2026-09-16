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
    re: /Unable to connect|typo in the url|socket connection was closed/i,
  },
  {
    cls: "gateway-timeout",
    advice: "same",
    quarantineMs: 60_000,
    re: /Gateway Timeout|Bad Gateway|ProviderHeaderTimeout|temporarily overloaded|^<none>$/i,
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
