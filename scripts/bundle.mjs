#!/usr/bin/env node
// bundle.mjs — genera plugins/models-fix.ts autocontenido.
//
// En opencode, CADA fichero en plugins/ es cargado como plugin y debe
// default-exportar una funcion (log: "Plugin export is not a function" para
// helpers sueltos). Por eso el deploy NO copia classifier.ts/ledger.ts como
// ficheros separados: los xmlinline en un unico models-fix.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(SRC, "models-fix.bundle.ts");

const HEADER = `// AUTOGENERADO por scripts/bundle.mjs — NO editar a mano.
// Fuente modular: src/{classifier,ledger,models-fix}.ts (repo).
// Un solo fichero porque cada .ts en plugins/ es un plugin y debe
// default-exportar una funcion.

`;

function stripLine(src, marker) {
  return src
    .split("\n")
    .filter((l) => !l.includes(marker))
    .join("\n");
}

// 1) classifier.ts — sin imports locales (no tiene ninguno)
const classifier = fs.readFileSync(path.join(SRC, "classifier.ts"), "utf-8");

// 2) ledger.ts — quita el tipo del classifier (queda inline)
const ledger = stripLine(
  fs.readFileSync(path.join(SRC, "ledger.ts"), "utf-8"),
  'from "./classifier.js"',
);

// 3) models-fix.ts — quita los 2 imports locales (valores + tipos)
let main = fs.readFileSync(path.join(SRC, "models-fix.ts"), "utf-8");
main = main
  .replace(/import \{[^}]*\} from "\.\/classifier\.js";\n/g, "")
  .replace(/import \{[^}]*\} from "\.\/ledger\.js";\n/g, "");

fs.writeFileSync(OUT, HEADER + classifier + "\n\n" + ledger + "\n\n" + main, "utf-8");
console.log(`[bundle] generado: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
