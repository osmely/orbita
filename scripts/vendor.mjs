// Copia a public/vendor/ lo que la interfaz antes cargaba de internet (fuentes, Markdown y saneado de HTML).
// Así Órbita funciona sin conexión y no avisa a terceros cada vez que el usuario la abre.
// Uso: npm run vendor (después de cambiar la versión de alguna de estas dependencias)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(RAIZ, "node_modules");
const DESTINO = path.join(RAIZ, "public", "vendor");

fs.rmSync(DESTINO, { recursive: true, force: true });
fs.mkdirSync(path.join(DESTINO, "fonts"), { recursive: true });

const copiar = (de, a) => fs.copyFileSync(path.join(NM, de), path.join(DESTINO, a));
// Los scripts, sin la referencia a su .map (no se reparte: solo daría un 404 en las herramientas del navegador)
const copiarScript = (de, a) => fs.writeFileSync(path.join(DESTINO, a), fs.readFileSync(path.join(NM, de), "utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"));
copiarScript("marked/lib/marked.umd.js", "marked.js"); // desde la v13 marked ya no trae versión minificada
copiarScript("dompurify/dist/purify.min.js", "purify.min.js");

// Fuentes: solo los pesos que usa styles.css, en latin (incluye ñ y tildes) y latin-ext
const FUENTES = [
  ["@fontsource/inter", "inter", "Inter", [400, 500, 600, 700]],
  ["@fontsource/jetbrains-mono", "jetbrains-mono", "JetBrains Mono", [400, 500]],
];
const RANGOS = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
};
let css = "/* Generado por scripts/vendor.mjs: no editar a mano. Fuentes con licencia SIL OFL 1.1. */\n";
for (const [paquete, archivo, familia, pesos] of FUENTES) {
  for (const peso of pesos) {
    for (const [subset, rango] of Object.entries(RANGOS)) {
      const nombre = `${archivo}-${subset}-${peso}-normal.woff2`;
      copiar(`${paquete}/files/${nombre}`, `fonts/${nombre}`);
      css += `@font-face { font-family: "${familia}"; font-style: normal; font-display: swap; font-weight: ${peso}; src: url("fonts/${nombre}") format("woff2"); unicode-range: ${rango}; }\n`;
    }
  }
}
fs.writeFileSync(path.join(DESTINO, "fonts.css"), css);

// Licencias de lo que se reparte con la app
const licencias = [
  ["marked", fs.existsSync(path.join(NM, "marked/LICENSE.md")) ? "marked/LICENSE.md" : "marked/LICENSE"],
  ["DOMPurify", "dompurify/LICENSE"],
  ["Inter", "@fontsource/inter/LICENSE"],
  ["JetBrains Mono", "@fontsource/jetbrains-mono/LICENSE"],
];
fs.writeFileSync(
  path.join(DESTINO, "LICENSES.txt"),
  licencias.map(([nombre, ruta]) => `===== ${nombre} =====\n\n${fs.readFileSync(path.join(NM, ruta), "utf8")}`).join("\n\n"),
);
console.log(`public/vendor listo (${fs.readdirSync(path.join(DESTINO, "fonts")).length} fuentes)`);
