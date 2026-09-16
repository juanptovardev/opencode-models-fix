# Models Fix — Plan maestro

> Plugin único para OpenCode que absorbe `muse-fix` y gestiona **todos** los fallos
> de modelos de **todos** los providers (kiosapi + nvidia + opencode).
> Workspace del proyecto. El deploy vive en `%USERPROFILE%\.config\opencode\plugins\`.

## 0. Decisiones cerradas con el usuario (2026-09-16)

1. **Reintento:** ante timeout del modal (90s, configurable), **1 solo auto-reintento
   con el primer fallback**. Si ese también falla → **espera indefinida** a elección
   del usuario. Cero cadenas automáticas (evitan tormentas que queman rate-limit).
2. **Ledger profesional:** runtime state en `C:\opengo-bridge\opencode-sync\`
   (junto a `nvidia-brute-state.json`): lock con TTL+pid, escritura atómica,
   esquema versionado, coordinación con el validator. Detalle en §7.
3. **`small_model`:** `kiosapi/glm-5.3-flash` con effort **default** (sin `:low`).
4. **Reasoning sigue ON** en todos los agentes: la protección contra
   `encrypted_content` es quirúrgica (Guardia G2), nunca `reasoning=false`.
5. **Fusión:** `muse-fix.ts` se absorbe como Guardia G1; queda como shim deprecado
   una release y luego se borra.
6. **Fase 2 (diseñada, no implementada):** preconfiguración por tarea/complejidad
   (`profiles` en config + hook reservado). Ahora solo modal manual.

## 1. Evidencia revalidada — errores del 2026-09-16

Agregación corregida desde `opencode.log` (~120 `stream error` reales + ruido).
Corrige el análisis previo (68/6 tipos: el query truncaba líneas y el regex de los
`?` chinos reventaba en PowerShell).

| # | Firma | N | Dónde concentra | Clase | Política |
|---|-------|---|-----------------|-------|----------|
| 1 | `Gateway Timeout` / `Bad Gateway` / `ProviderHeaderTimeout` 300s / `temporarily overloaded` / `<none>` | ~45 | `kiosapi/glm-5.3-flash` 17, `kiosapi/kimi-k3` 8, `nvidia/z-ai/glm-5.3-flash` 8 | `gateway-timeout` | Ventana 5: ≤2 fails mismo modelo, ≥3 fallback |
| 2 | `request id: 2026…` (chino: 10 y 60 req/min incl. fallidos) + `rate_limit_exceeded` | ~36 | `glm` 16, `qwen3.8-flash` 10, `hy3` 6 | `rate-429` | Cuarentena backoff+jitter, respeta `reset after Ns`, pausa validator |
| 3 | `Unable to connect` / `typo in the url` / `socket closed` | ~22 | `qwen3.8-flash` 15, `nvidia/kimi-k3` 5 | `conn-refused` | Igual que gateway-timeout |
| 4 | `GROUP_DISABLED` / `API Key …` (403) | 7 | `qwen3.8-flash` | `group-disabled` | **0 retries**. Rotar key o cambiar modelo |
| 5 | `insufficient balance balance=0` (kios) + `Insufficient balance` billing (opencode) | ~9 | `hy3`, `qwen`, `gpt-5.4-nano` títulos 3× | `no-balance` | **0 retries**. Corte inmediato |
| 6 | `encrypted_content was not issued to this caller` | 4 | `opencode/muse-spark-1.3-contributor-free` | `encrypted-reasoning` | No reintentar idéntico. G2 sanea y reintenta |
| 7 | `input tokens exceed context limit` | 2 | `atria-dawn-preview` | `ctx-overflow` | No reintentar. Compactar / fork / modelo grande |
| 8 | `inappropriate content` / `data_inspect` | 2 | `qwen3.8-flash` | `content-filter` | **0 retries** idénticos. Reformular |
| 9 | `openai_error` (400) | 1 | `qwen3.8-flash` | `bad-request` | Cuarentena corta + fallback |
| 10 | `No available channel … under group Free` (503) | 5 | `qwen3.8-flash` | `no-channel` | Cuarentena 30 min + fallback inmediato |
| 11 | `history.ts must default export an object with server()` | decenas/boot | cada arranque | config | §8 colateral (el error más repetido del día) |

Causa raíz transversal: **los retries ciegos empeoran todo** (cada intento fallido
cuenta para el rate-limit chino; `isRetryable=false` se reintenta igual; el
validator `--auto` colisiona con la sesión y multiplica los 429).

## 2. Límite honesto del SDK (define la arquitectura)

Verificado en `node_modules/@opencode-ai/plugin/dist/index.d.ts`:

- **No existe hook `chat.error`** ni forma de cambiar el modelo sincrónicamente
  dentro del request fallido.
- Hooks reales: `experimental.chat.messages.transform` (pre-request),
  `chat.message` / `chat.params`, `event` (`session.error` con payload tipado en
  `@opencode-ai/sdk` → `properties: { sessionID?, error? }`), `tool.*`,
  `config`, `provider` + `client.session.prompt()` para relanzar.
- `PluginModule` exige `tui?: never` en server: **un fichero no puede ser
  server+tui**. Por eso: server `models-fix.ts` + TUI compañero
  `models-fix-tui.ts`, comunicados por buzón JSON efímero.

Consecuencia: el reintento es **reactivo** (sesión viva + modal), no transparente.

## 3. Arquitectura

```text
<workspace> Models Fix\
  PLAN.md                  ← este plan (fuente)
  README.md                ← qué es, instalación, uso
  CHANGELOG.md             ← releases por tag
  CONTRIBUTING.md          ← ramas, PRs, labels
  package.json / tsconfig.json / .gitignore
  src/
    classifier.ts          ← clasificador puro (10 firmas, §5) — testeable sin I/O
    ledger.ts              ← ventana, cuarentenas, lock, atomic write (§7)
    models-fix.ts          ← server: guardias + session.error + toast + buzón
    models-fix-tui.ts      ← TUI: modal DialogSelect + countdown + re-prompt
  config/
    models-fix.json        ← plantilla: umbrales, chains, caps, profiles (fase 2)
  scripts/
    deploy.mjs             ← copia a plugins/ con backup (local + OneDrive)
  tests/
    classifier.test.ts     ← las 10 firmas reales del 2026-09-16
    ledger.test.ts         ← ventana, cuarentena, lock, anti-masacre
  docs/
    ERRORS.md              ← catálogo firma → clase → política → test
    SETUP-GITHUB.md        ← comandos gh para labels/milestones/project
  .github/
    workflows/ci.yml       ← bun test + tsc (progresivo: luego lint/coverage)
    ISSUE_TEMPLATE/bug.yml ← plantilla con firma del log

<install>  %USERPROFILE%\.config\opencode\plugins\models-fix.ts
<install>  %USERPROFILE%\.config\opencode\plugins\models-fix-tui.ts
<config>   %USERPROFILE%\.config\opencode\models-fix.json   (opcional; defaults en código)
<runtime>  C:\opengo-bridge\opencode-sync\models-fix-state.json
<runtime>  C:\opengo-bridge\opencode-sync\models-fix.lock
<runtime>  C:\opengo-bridge\opencode-sync\models-fix-retry.json  (buzón, TTL 10 min)
```

## 4. Guardias pre-request (`experimental.chat.messages.transform`)

Mismo punto que `muse-fix.ts:23`.

- **G1 dedupe callIDs** (código de `muse-fix.ts:28-73` migrado tal cual):
  evita `Duplicate function_call_output` en sesiones largas.
- **G2 strip reasoning stale (quirúrgico, reasoning ON):** rastrea agente por
  sesión vía `chat.message`; si el agente cambió desde el último turno, elimina
  **solo** los parts `reasoning` con `encrypted_content` del payload saliente.
  Storage intacto. Cubre los 4 `encrypted-reasoning` sin perder la utilidad.
- **G3 context guard:** estima tokens (≈ chars/4); si supera el cap del modelo
  (`kiosapi-efforts.json` → `contextAdvertised`/caps + tabla nvidia/opencode en
  config), **no envía el request condenado**: toast + modal
  (compactar / fork con resumen / modelo grande). Cubre los 2 `ctx-overflow`.

## 5. Clasificador post-fallo (`event session.error`)

Orden de reglas (primera que matchea gana). Implementado en `src/classifier.ts`,
100% puro y cubierto por `tests/classifier.test.ts` con las firmas reales.

| Clase | Match | Advice | Cuarentena |
|-------|-------|--------|------------|
| `no-balance` | `insufficient balance`, `balance=0`, `insufficient_user_qu` | `no` | 24h |
| `group-disabled` | `GROUP_DISABLED` | `no` | 24h |
| `content-filter` | `inappropriate content`, `data_inspect` | `no` | 24h (modal: reformular) |
| `ctx-overflow` | `context limit`, `input tokens exceed`, `maximum context length`, `too many tokens` | `no` | 0 (acción de sesión) |
| `encrypted-reasoning` | `encrypted_content` | `same-sanitized` | 0 (G2 ya saneó) |
| `no-channel` | `No available channel` | `fallback` | 30 min |
| `rate-429` | `request id: 2026`, `rate_limit_exceeded`, `\b429\b` | `same` tras espera | `reset after Ns` si viene; si no, ladder 2s→4s→8s→15s→30s (cap 6h) + jitter |
| `bad-request` | `openai_error` | `fallback` | 15 min |
| `conn-refused` | `Unable to connect`, `typo in the url`, `socket closed` | ventana (§6) | ladder corto |
| `gateway-timeout` | `Gateway Timeout`, `Bad Gateway`, `ProviderHeaderTimeout`, `temporarily overloaded` | ventana (§6) | ladder corto |
| `unknown` | — | `fallback` | 5 min |

## 6. Ventana deslizante + anti-masacre + modal

- Ventana de 5 fails por `provider/model` (15 min): ≤2 → mismo modelo tras
  espera; ≥3 → fallback. Patrón del `kiosapi-validator` (hysteresis) y
  `nvidia-brute` (anti-masacre >50% dead aborta ráfaga).
- **Fallback ranking (lee, no duplica):** `kiosapi-efforts.json`
  (`ok` > `ok_flaky` > `recovered_pending`; evita `degraded/off/paidRemoved/notExposed`)
  + `nvidia-brute-state.json` (`ok` > `soft`; evita `pending/off`) + chains de
  config. El modal muestra 3–5 candidatos con motivo.
- **Modal (regla del usuario):** timeout 90s → **auto-reintento solo del
  candidato #1** (`client.session.prompt` con el mismo prompt, guardado vía
  `chat.message`; `chainDepth` en el buzón). Si el auto falla → **fin de lo
  automático**: modal reabierto en espera indefinida. Guard in-flight por sesión.
- **Fase 2 (reservada):** sección `profiles` vacía
  (`quick|standard|heavy|code|research`) + hook en `chat.message` que la leerá.

## 7. Ledger profesional

- `models-fix-state.json` v1:
  `{version, updatedAt, entries: {"prov/model": {fails:[ts], quarantineUntil,
  consecutiveOk, lastClass, lastHash, autoRetriedFor:[promptHash]}}}`.
  Espejo en memoria + flush por evento (volumen bajo: solo error-path).
- Lock `models-fix.lock` TTL 900s con pid + recuperación de stale (misma
  semántica que `nvidia-brute.ts:144-162`); escritura atómica tmp+rename
  (Windows-safe, `nvidia-brute.ts:133-138`).
- Buzón `models-fix-retry.json` TTL 10 min, se borra al consumirse.
- **Coordinación validator:** `kiosapi-sync` lee cuarentenas activas y salta su
  `--auto` mientras haya una (cierra la colisión validator×sesión).
- Backups estilo validator (local + OneDrive Desktop) solo para `opencode.json`
  y `plugins/` antes de cambios; el state efímero no se backuppea.

## 8. Colaterales incluidos

- **`history.ts:518-521`** exporta `{id,tui}` pero el loader de `plugins/` lo
  carga como server (exige `server()`): o se mueve al path TUI o queda
  stub+TUI separado. Se resuelve al implementar el TUI compañero (mismo patrón).
- **`opencode.json`:** único cambio funcional `small_model` →
  `kiosapi/glm-5.3-flash` (effort default). Nada de `reasoning=false`.

## 9. Gestión en GitHub — escalable y progresiva

Objetivo del usuario: **ver dónde falla algo, por componente y por fase**,
creciendo sin reestructurar. Reglas:

- **Repo:** `opencode-models-fix` (público; sin secretos: las keys viven en
  `opencode.json`, nunca en este repo). `main` protegida, `dev` integración,
  `feat/*` por issue. Tags `v0.x` por milestone; `CHANGELOG.md` por release.
- **Issues = unidad de trabajo** (1 issue = 1 componente fallable):
  `#1 classifier`, `#2 ledger`, `#3 G1/G2/G3`, `#4 server handler+buzón`,
  `#5 TUI modal`, `#6 shim muse-fix`, `#7 fix history.ts`, `#8 small_model`,
  `#9 validator-pause`, `#10 profiles fase 2`. Plantilla bug con firma del log
  (`.github/ISSUE_TEMPLATE/bug.yml`) para que cada fallo futuro entre ya
  clasificado (firma → clase §5).
- **Labels:** `area:classifier|ledger|guards|server|tui|ci|docs`,
  `type:bug|feat|chore`, `phase:1|2|3`, `P0|P1|P2`. (Comandos en
  `docs/SETUP-GITHUB.md`; se crean una vez con `gh`.)
- **Milestones progresivos = releases verificables:**
  - `v0.1` — classifier + ledger + tests (CI en verde; nada toca tu setup).
  - `v0.2` — G1/G2/G3 (deploy en paralelo, solo observan + log).
  - `v0.3` — server handler + buzón + TUI modal (activa el reintento).
  - `v0.4` — shim `muse-fix` + fix `history.ts` + `small_model` + pausa validator.
  - `v1.0` — estable: 7 días sin `unknown` nuevos en tu uso real.
  - `v1.1` — `profiles` por tarea/complejidad (fase 2).
- **CI progresivo (`.github/workflows/ci.yml`):** hoy `bun test` + `tsc --noEmit`.
  Luego, sin reestructurar: lint → coverage mínimo → test de integración con
  firmas sintéticas → deploy dry-run. Cada fase añade un job, nunca reescribe.
- **Trazabilidad fallo→código:** `docs/ERRORS.md` mapea cada firma a clase,
  política y test. Un fallo nuevo = issue con label `area:*` + fila en ERRORS.md
  + caso en `tests/classifier.test.ts`. Así se ve **dónde** falla: CI rojo
  apunta al componente; ledger en runtime apunta al modelo/provider.
- **Project board** (Projects v2): `Backlog → Ready → In progress → Verify → Done`,
  con los issues #1–#10 precargados. Automatización: PR mergeado mueve a Verify;
  tag de release mueve a Done.

## 10. Rollout y verificación

1. Backup `opencode.json`+`plugins/` → PLAN.md aquí → implementar por milestones.
2. Tests: unit clasificador (10 firmas reales) + ledger (ventana, cuarentena,
   lock, anti-masacre); sim de `session.error`; e2e manual (provocar 429 y
   `encrypted_content` por cambio de agente) verificando modal → 1 auto →
   espera al segundo.
3. Rollback: borrar 2 ficheros de `plugins/` + restaurar backup. El shim
   garantiza que nada que importe `muse-fix` se rompe.

## 11. Estado

- [x] Plan maestro + decisiones (§0)
- [x] Repo GitHub (https://github.com/juanptovardev/opencode-models-fix) + issues #1–#10 + labels + milestones + CI en verde (2026-09-16)
- [x] `v0.1` classifier + ledger + tests (34/34, typecheck limpio) — commiteado
- [ ] `v0.2` guardias G1/G2/G3 (G1 activo; G2/G3 esqueleto → `chat.params`)
- [ ] `v0.3` server handler + buzón + TUI modal (código escrito, sin deploy)
- [ ] `v0.4` colaterales (shim, history.ts, small_model, validator-pause)
- [ ] `v1.0` estable
