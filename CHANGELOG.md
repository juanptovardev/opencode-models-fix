# Changelog

Formato: `## [vX.Y] - fecha` + lista por issue.

## [v0.1.1] - 2026-09-16 (pulido)

- Fix: guard in-flight con expiración (3 min) — antes silenciaba la sesión para siempre.
- Fix: `loadConfig` ahora lee `~/.config/opencode/models-fix.json` (antes era decorativa).
- Fix: toast usa `client.tui.showToast` (el API correcto del SDK, patrón nvidia-brute).
- Fix: rankFallbacks — path `.config` correcto y campo `state` verificado contra el ledger real.
- Fix: deploy portable (`fileURLToPath` + dirname doble, dobles correcciones) y solo-server.
- Docs: README con notas de deploy; plantilla config cubre overrides.

## [Unreleased]

- Plan maestro (`PLAN.md`), scaffolding del repo, CI base, catálogo de errores.

## [v0.1] - pendiente

- Classifier (10 firmas) + ledger + tests. CI en verde; nada toca el setup real.

## [v0.2] - pendiente

- Guardias G1 (dedupe callIDs, absorbido de muse-fix), G2 (strip reasoning
  stale, reasoning siempre ON), G3 (context guard). Deploy en paralelo,
  solo observan + log.

## [v0.3] - pendiente

- Server handler `session.error` + buzón + TUI modal. Activa el reintento:
  timeout 90s → 1 auto del primer fallback; si falla, espera indefinida.

## [v0.4] - pendiente

- Shim `muse-fix` (deprecado) + fix `history.ts` (server vs TUI) +
  `small_model` → `kiosapi/glm-5.3-flash` + pausa del validator bajo cuarentena.

## [v1.0] - pendiente

- Estable: 7 días de uso real sin clases `unknown` nuevas.

## [v1.1] - pendiente

- `profiles` por tarea/complejidad (fase 2: preconfiguración con preguntas).
