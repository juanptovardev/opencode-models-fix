#!/usr/bin/env node
// deploy.mjs — copia el plugin a .config/opencode/plugins con backup previo.
// Uso: bun scripts/deploy.mjs   (o: node scripts/deploy.mjs)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const PLUGINS = path.join(HOME, ".config", "opencode", "plugins");
const CONFIG_DIR = path.join(HOME, ".config", "opencode");
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const SRC = path.join(ROOT, "src");
const CONFIG_TEMPLATE = path.join(ROOT, "config", "models-fix.json");

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const stamp = `modelsfix-${TS}`;

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const dst = `${p}.bak-${stamp}`;
  fs.copyFileSync(p, dst);
  return dst;
}

const files = ["models-fix.ts", "models-fix-tui.ts"];
const deploy = [];

for (const f of files) {
  const from = path.join(SRC, f);
  const to = path.join(PLUGINS, f);
  if (!fs.existsSync(from)) {
    console.error(`[deploy] falta fuente: ${from}`);
    process.exit(1);
  }
  const bk = backup(to);
  if (bk) console.log(`[deploy] backup: ${bk}`);
  fs.mkdirSync(PLUGINS, { recursive: true });
  fs.copyFileSync(from, to);
  deploy.push(to);
  console.log(`[deploy] instalado: ${to}`);
}

// config plantilla (solo si no existe)
const cfgDst = path.join(CONFIG_DIR, "models-fix.json");
if (!fs.existsSync(cfgDst) && fs.existsSync(CONFIG_TEMPLATE)) {
  fs.copyFileSync(CONFIG_TEMPLATE, cfgDst);
  console.log(`[deploy] config plantilla: ${cfgDst}`);
}

console.log(`\n[deploy] OK. Reinicia OpenCode. Rollback: borrar ${files.join(", ")} de plugins/ y restaurar los .bak-${stamp}`);
