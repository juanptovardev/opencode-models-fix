import { describe, expect, test } from "bun:test";
import { classify } from "../src/classifier";
import type { ErrorClass, Advice } from "../src/classifier";

// Firmas reales extraidas de opencode.log 2026-09-16.
const CASES: Array<{ name: string; msg: string; cls: ErrorClass; advice: Advice }> = [
  {
    name: "kios no-balance (hy3)",
    msg: 'credit insufficient balance: balance=0 required=22690 (request id: 20260916141351)',
    cls: "no-balance",
    advice: "no",
  },
  {
    name: "opencode billing no-balance (gpt-5.4-nano titulo)",
    msg: "Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_01KNZ/billing",
    cls: "no-balance",
    advice: "no",
  },
  {
    name: "group-disabled 403",
    msg: '[403]: {"code":"GROUP_DISABLED","message":"API Key invalid"} (reset after 1m 52s)',
    cls: "group-disabled",
    advice: "no",
  },
  {
    name: "content-filter 400",
    msg: '[400]: {"error":{"message":"Input text data may contain inappropriate content.","type":"data_inspect"}} (reset after 2s)',
    cls: "content-filter",
    advice: "no",
  },
  {
    name: "ctx-overflow (atria)",
    msg: "estimated input tokens exceed the model's context limit (request_id: adf0382699dd)",
    cls: "ctx-overflow",
    advice: "no",
  },
  {
    name: "encrypted-reasoning (muse cambio de agente)",
    msg: "Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller",
    cls: "encrypted-reasoning",
    advice: "same-sanitized",
  },
  {
    name: "no-channel 503 (rafaga 15:09)",
    msg: "No available channel for model qwen3.8-flash under group Free (distributor) (request id: 20260916150939)",
    cls: "no-channel",
    advice: "fallback",
  },
  {
    name: "rate-429 chino 10/min (glm)",
    msg: "AI_APICallError: è¯·æ±‚é¢‘çŽ‡è¶…é™:1åˆ†é’Ÿå†…åªèƒ½å‘é€10æ¡è¯·æ±‚ (request id: 20260916041219)",
    cls: "rate-429",
    advice: "same",
  },
  {
    name: "rate-429 con reset explicito",
    msg: 'AI_APICallError: [openai-compatible-chat-x/qwen3.8-flash] [400]: {"error":"openai_error"} (reset after 26s)',
    cls: "bad-request",
    advice: "fallback",
  },
  {
    name: "rate-429 wandb (glm nvidia)",
    msg: 'concurrency limit reached for requests: model "zai-org/GLM-5.3-Flash", per-user - see https://wandb.me/inf-err-limits',
    cls: "rate-429",
    advice: "same",
  },
  {
    name: "conn-refused (proxy kios caido)",
    msg: "AI_APICallError: Cannot connect to API: Unable to connect. Is the computer able to access the url?",
    cls: "conn-refused",
    advice: "same",
  },
  {
    name: "conn-refused typo url",
    msg: "AI_APICallError: Cannot connect to API: Was there a typo in the url or port?",
    cls: "conn-refused",
    advice: "same",
  },
  {
    name: "conn-refused socket closed",
    msg: "AI_APICallError: Cannot connect to API: The socket connection was closed unexpectedly.",
    cls: "conn-refused",
    advice: "same",
  },
  {
    name: "gateway-timeout",
    msg: "AI_APICallError: Gateway Timeout",
    cls: "gateway-timeout",
    advice: "same",
  },
  {
    name: "gateway-timeout header 300s",
    msg: "ProviderHeaderTimeoutError: Provider response headers timed out after 300000ms",
    cls: "gateway-timeout",
    advice: "same",
  },
  {
    name: "gateway-timeout upstream overloaded",
    msg: "Streaming response failed: [502] Upstream error from Nvidia: Service temporarily overloaded",
    cls: "gateway-timeout",
    advice: "same",
  },
  {
    name: "bad-request openai_error",
    msg: 'AI_APICallError: [openai-compatible-chat-x/qwen3.8-flash] [400]: {"error":{"message":"openai_error","type":"invalid_request_error"}} (reset after 26s)',
    cls: "bad-request",
    advice: "fallback",
  },
  {
    name: "gateway-timeout <none> (log real)",
    msg: "AI_APICallError: <none>",
    cls: "gateway-timeout",
    advice: "same",
  },
  {
    name: "conn-refused invalid url (log real)",
    msg: "AI_APICallError: Invalid URL (GET /v1/chat/completions)",
    cls: "conn-refused",
    advice: "same",
  },
  {
    name: "unknown",
    msg: "AI_APICallError: something brand new nobody has seen",
    cls: "unknown",
    advice: "fallback",
  },
];

describe("classifier", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = classify(c.msg);
      expect(r.cls).toBe(c.cls);
      expect(r.advice).toBe(c.advice);
    });
  }

  test("no-balance no es reintentable", () => {
    expect(classify("insufficient balance balance=0").retryable).toBe(false);
  });

  test("gateway-timeout SI es reintentable", () => {
    expect(classify("Gateway Timeout").retryable).toBe(true);
  });

  test("respeta reset after explicito en rate-429", () => {
    const r = classify("rate_limit_exceeded (reset after 30s)");
    expect(r.cls).toBe("rate-429");
    expect(r.resetAfterMs).toBe(30000);
    expect(r.quarantineMs).toBe(30000);
  });

  test("reset en minutos se convierte", () => {
    const r = classify("rate_limit_exceeded (reset after 2m)");
    expect(r.resetAfterMs).toBe(120000);
  });

  test("reset excesivo se capa a 6h", () => {
    const r = classify("rate_limit_exceeded (reset after 9999999m)");
    expect(r.quarantineMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  test("entrada vacia/no-string no revienta", () => {
    const r = classify(undefined);
    expect(r.cls).toBe("unknown");
  });
});
