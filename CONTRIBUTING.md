# Contributing — opencode-models-fix

## Unidad de trabajo: el issue

1 issue = 1 componente fallable. Todo cambio empieza en un issue
(excepto typos/docs menores, que van directo a `dev`).

## Ramas

- `main` — protegida, solo merges desde `dev` vía release.
- `dev` — integración. Los PRs apuntan aquí.
- `feat/<n>-<slug>` — ej. `feat/1-classifier`. `<n>` = número de issue.
- `fix/<n>-<slug>` — para bugs.

## Labels

- `area:classifier|ledger|guards|server|tui|ci|docs`
- `type:bug|feat|chore`
- `phase:1|2|3`
- `P0|P1|P2`

## PRs

- Título: `[#<n>] <qué cambia>` — ej. `[#1] classifier: 10 firmas + tests`.
- CI verde obligatorio (`bun test` + `tsc --noEmit`).
- Todo fallo nuevo de modelos entra con su firma: fila en `docs/ERRORS.md` +
  caso en `tests/classifier.test.ts` + label `area:*` correspondiente.
- Nunca commitear secretos: las API keys viven en `opencode.json`, jamás en
  este repo (ver `.gitignore`).

## Releases

- Milestones = releases: `v0.1` → `v0.2` → `v0.3` → `v0.4` → `v1.0` → `v1.1`.
- Al cerrar un milestone: tag `vX.Y`, entrada en `CHANGELOG.md`, PR `dev` → `main`.
