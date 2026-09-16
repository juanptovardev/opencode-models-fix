# Setup GitHub — comandos `gh` (una sola vez)

> Requiere `gh auth login` previo. `GH` = ruta a `gh.exe`
> (`C:\Program Files\GitHub CLI\gh.exe` si no está en el PATH).

## Labels

```powershell
$GH = "C:\Program Files\GitHub CLI\gh.exe"
$R = "<owner>/opencode-models-fix"
foreach ($l in @(
  "area:classifier|Bug en clasificador|#0E8A16","area:ledger|Estado y cuarentenas|#0E8A16",
  "area:guards|Guardias G1/G2/G3|#0E8A16","area:server|Handler y buzón|#0E8A16",
  "area:tui|Modal de reintento|#0E8A16","area:ci|CI y tooling|#CCCCCC","area:docs|Docs|#CCCCCC",
  "type:bug|Algo falla|#D73A4A","type:feat|Nuevo|#A2EEEF","type:chore|Mantenimiento|#FEF2C0",
  "phase:1|Fase 1|#BFD4F2","phase:2|Fase 2|#BFD4F2","phase:3|Fase 3|#BFD4F2",
  "P0|Crítico|#B60205","P1|Normal|#FBCA04","P2|Baja|#0E8A16"
)) { $n,$d,$c = $l -split '\|'; & $GH label create --repo $R $n -d $d -c $c --force }
```

## Milestones (= releases)

```powershell
foreach ($m in @("v0.1|Classifier + ledger + tests",
  "v0.2|Guardias G1/G2/G3","v0.3|Server + buzón + modal",
  "v0.4|Colaterales","v1.0|Estable","v1.1|Profiles fase 2")) {
  $t,$d = $m -split '\|'; & $GH milestone create --repo $R -t $t -d $d }
```

## Issues #1–#10 (ver PLAN.md §9 para títulos y cuerpos)

Crear con `gh issue create --repo $R -t "[#N] ..." -b "..." -l "area:...,phase:1" -m "v0.1"`.
Plantilla de bug ya incluida en `.github/ISSUE_TEMPLATE/bug.yml`.

## Project board (Projects v2, manual en web)

Columnas: `Backlog → Ready → In progress → Verify → Done`.
Automatización sugerida: PR mergeado → Verify; tag de release → Done.
