#!/usr/bin/env node
// deploy.mjs — copia el plugin a .config/opencode/plugins con backup previo.
// Uso: bun scripts/deploy.mjs   (o: node scripts/deploy.mjs)
//
// SOLO server: models-fix.ts + classifier.ts + ledger.ts.
// El TUI (models-fix-tui.ts) NO se despliega: un fichero solo-TUI en plugins/
// hace fallar el boot del server ("must default export server()", igual que
// history.ts). Se resuelve en el issue #7 antes de desplegarlo.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const PLUGINS = path.join(HOME, ".config", "opencode", "plugins");
const CONFIG_DIR = path.join(HOME, ".config", "opencode");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const CONFIG_TEMPLATE = path.join(ROOT, "config", "models-fix.json");

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const stamp = `modelsfix-${TS}`;

// Bundle: un solo fichero (cada .ts en plugins/ es cargado como plugin y
// debe default-exportar funcion; helpers sueltos rompen el boot — log real:
// "Plugin export is not a function" para ledger.ts). Ver scripts/bundle.mjs.
const files = ["models-fix.bundle.ts"];
const deployAs = { "models-fix.bundle.ts": "models-fix.ts" };
// models-fix-tui.ts: EXCLUIDO a proposito (ver cabecera).

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const dst = `${p}.bak-${stamp}`;
  fs.copyFileSync(p, dst);
  return dst;
}

for (const f of files) {
  const from = path.join(SRC, f);
  const to = path.join(PLUGINS, deployAs[f] ?? f);
  if (!fs.existsSync(from)) {
    console.error(`[deploy] falta fuente: ${from}`);
    process.exit(1);
  }
  const bk = backup(to);
  if (bk) console.log(`[deploy] backup: ${bk}`);
  fs.mkdirSync(PLUGINS, { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[deploy] instalado: ${to}`);
}

// Elimina helpers sueltos de un deploy anterior (rompen el boot).
for (const stale of ["classifier.ts", "ledger.ts"]) {
  const p = path.join(PLUGINS, stale);
  if (fs.existsSync(p)) {
    backup(p);
    fs.unlinkSync(p);
    console.log(`[deploy] eliminado helper suelto (rompia boot): ${p}`);
  }
}

// config plantilla (solo si no existe)
const cfgDst = path.join(CONFIG_DIR, "models-fix.json");
if (!fs.existsSync(cfgDst) && fs.existsSync(CONFIG_TEMPLATE)) {
  fs.copyFileSync(CONFIG_TEMPLATE, cfgDst);
  console.log(`[deploy] config plantilla: ${cfgDst}`);
}

console.log(`\n[deploy] OK. Reinicia OpenCode. Rollback: borrar ${files.join(", ")} de plugins/ y restaurar los .bak-${stamp}`);
