# Catálogo de errores — firma → clase → política → test

Evidencia: `opencode.log` 2026-09-16 (~120 `stream error` reales).
Implementación: `src/classifier.ts`. Tests: `tests/classifier.test.ts`.

| Clase | Firmas (regex) | Política | Cuarentena | Test |
|-------|----------------|----------|------------|------|
| `no-balance` | `insufficient balance`, `balance=0`, `insufficient_user_qu` | `no` — corte inmediato, 0 retries | 24h | kios `hy3 balance=0`; opencode billing |
| `group-disabled` | `GROUP_DISABLED` | `no` — rotar key o cambiar modelo | 24h | `qwen3.8-flash` 403 |
| `content-filter` | `inappropriate content`, `data_inspect` | `no` — reformular | 24h | `qwen3.8-flash` 400 filter |
| `ctx-overflow` | `context limit`, `input tokens exceed`, `maximum context length`, `too many tokens` | `no` — compactar/fork/modelo grande | — | `atria-dawn-preview` |
| `encrypted-reasoning` | `encrypted_content` | `same-sanitized` — G2 sanea y reintenta | — | `muse-spark-1.3-contributor-free` cambio de agente |
| `no-channel` | `No available channel` | `fallback` inmediato | 30 min | `qwen3.8-flash` 503 ráfaga 15:09 |
| `rate-429` | `request id: 2026`, `rate_limit_exceeded`, `\b429\b` | `same` tras espera; respeta `reset after Ns` | ladder 2s→4s→8s→15s→30s, cap 6h + jitter | `glm-5.3-flash` 10/min; `qwen` 60/min |
| `bad-request` | `openai_error` | `fallback` | 15 min | `qwen3.8-flash` 400 |
| `conn-refused` | `Unable to connect`, `typo in the url`, `socket closed` | ventana §6 PLAN | ladder corto | proxy kios caído TCP |
| `gateway-timeout` | `Gateway Timeout`, `Bad Gateway`, `ProviderHeaderTimeout`, `temporarily overloaded` | ventana §6 PLAN | ladder corto | `glm`/`kimi-k3`/nvidia |
| `unknown` | (ninguna matchea) | `fallback` | 5 min | — |

## Cómo añadir una firma nueva

1. Abrir issue con la plantilla bug (pega la línea del log).
2. Añadir fila aquí + caso en `tests/classifier.test.ts` + label `area:*`.
3. Si CI en rojo apunta al componente: ya sabes **dónde** falla.
