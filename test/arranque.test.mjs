// Arrancar Órbita cuando ya hay una abierta: si es la misma versión, se deja; si es de una versión anterior
// (la abriste antes de actualizar y solo cerraste su ventana), la nueva la sustituye sin perder nada.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-arranque-"));
const DATOS = path.join(TMP, "datos");
const PUERTO = await new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const B = `http://127.0.0.1:${PUERTO}`;
const procesos = [];

// Una copia del código con un cambio mínimo: es «la versión anterior»
const VIEJA = path.join(TMP, "vieja");
fs.mkdirSync(VIEJA);
for (const f of fs.readdirSync(RAIZ)) if (f.endsWith(".mjs") || f === "package.json") fs.copyFileSync(path.join(RAIZ, f), path.join(VIEJA, f));
fs.cpSync(path.join(RAIZ, "public"), path.join(VIEJA, "public"), { recursive: true });
fs.symlinkSync(path.join(RAIZ, "node_modules"), path.join(VIEJA, "node_modules"));
fs.appendFileSync(path.join(VIEJA, "estado.mjs"), "\n// versión anterior\n");

function arrancar(dir) {
  const p = spawn(process.execPath, [path.join(dir, "server.mjs"), "--data", DATOS, "--port", String(PUERTO), "--no-open"], { env: { ...process.env, ORBITA_PRUEBAS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  p.salida = "";
  p.stdout.on("data", (d) => (p.salida += d));
  p.fin = new Promise((ok) => p.on("exit", (c) => ok(c)));
  procesos.push(p);
  return p;
}
const esperarTexto = async (p, texto) => {
  for (let i = 0; i < 100 && !p.salida.includes(texto); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(p.salida.includes(texto), `no apareció «${texto}»:\n${p.salida}`);
};
const version = async () => (await (await fetch(`${B}/api/board`)).json()).version;

after(async () => {
  for (const p of procesos) if (p.exitCode === null) p.kill("SIGTERM");
  await Promise.all(procesos.map((p) => Promise.race([p.fin, new Promise((r) => setTimeout(r, 3000))])));
  fs.rmSync(TMP, { recursive: true, force: true });
});

let vieja;
test("con la misma versión ya abierta, el arranque nuevo solo abre la ventana y termina", async () => {
  vieja = arrancar(VIEJA);
  await esperarTexto(vieja, "está en");
  const v = await version();
  const otra = arrancar(VIEJA);
  assert.equal(await otra.fin, 0);
  assert.match(otra.salida, /ya está abierta/);
  assert.equal(vieja.exitCode, null, "la que estaba sigue abierta");
  assert.equal(await version(), v);
});

test("con una versión anterior abierta, la nueva la cierra (guardando) y ocupa su sitio", async () => {
  const antes = await version();
  const r = await fetch(`${B}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sigue aquí", dir: fs.mkdirSync(path.join(TMP, "proyecto"), { recursive: true }) || path.join(TMP, "proyecto") }) });
  assert.ok(r.ok);
  const nueva = arrancar(RAIZ);
  await esperarTexto(nueva, "versión anterior abierta");
  await esperarTexto(nueva, "está en");
  assert.equal(await vieja.fin, 0, "la vieja se cerró");
  const ahora = await version();
  assert.notEqual(ahora, antes);
  assert.ok((await (await fetch(`${B}/api/board`)).json()).projects.some((p) => p.name === "Sigue aquí"), "no se pierde nada");
});
