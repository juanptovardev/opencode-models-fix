# opencode-models-fix

Plugin único para OpenCode que absorbe `muse-fix` y gestiona **todos** los fallos
de modelos de **todos** los providers (kiosapi + nvidia + opencode).

- **Guardias pre-request:** dedupe de `callID` (G1), strip quirúrgico de reasoning
  stale con reasoning siempre ON (G2), context guard anti-request-condenado (G3).
- **Clasificador post-fallo:** 10 firmas reales → clase → política (0 retries,
  backoff+jitter, ventana deslizante, fallback). Ver `docs/ERRORS.md`.
- **Modal TUI de reintento:** ante fallo, la sesión sigue viva; eliges modelo.
  Timeout 90s → 1 solo auto-reintento del primer fallback; si falla, espera
  indefinida. Cero cadenas automáticas.
- **Ledger profesional:** ventana, cuarentenas, lock TTL+pid, escritura atómica,
  coordinación con el kiosapi-validator (pausa su `--auto` bajo cuarentena).

Estado y plan completo: [`PLAN.md`](PLAN.md).

> **Notas del deploy (v0.1.1):**
> - Solo server: `models-fix.ts` + `classifier.ts` + `ledger.ts` (+ plantilla de config).
> - El TUI (`models-fix-tui.ts`) queda en el repo **sin desplegar**: un fichero
>   solo-TUI en `plugins/` rompe el boot (issue #7).
> - Config opcional en `~/.config/opencode/models-fix.json`: lo que declara pisa
>   defaults; lo demás vive en el código.
> - Runtime state en `C:\opengo-bridge\opencode-sync\models-fix-state.json`.

## Instalación (cuando un milestone lo indique)

```powershell
# 1. Backup (el deploy lo hace solo, pero por si acaso)
Copy-Item "$env:USERPROFILE\.config\opencode\opencode.json" "$env:USERPROFILE\.config\opencode\opencode.json.bak-modelsfix"

# 2. Deploy desde este repo
bun scripts/deploy.mjs

# 3. Reinicia OpenCode y verifica el toast "[models-fix] activo"
```

## Desarrollo

```powershell
bun install
bun test          # unit: classifier + ledger
bun run typecheck # tsc --noEmit
```

## Estructura

```text
src/       classifier.ts · ledger.ts · models-fix.ts · models-fix-tui.ts
config/    models-fix.json (plantilla)
tests/     classifier.test.ts · ledger.test.ts
docs/      ERRORS.md · SETUP-GITHUB.md
scripts/   deploy.mjs
```

## Reglas de contribución

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md). Resumen: 1 issue = 1 componente,
rama `feat/<n>-<slug>`, PR contra `dev`, CI verde obligatorio, CHANGELOG por release.
