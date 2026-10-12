// Guardado por proyecto: lo frecuente (report_progress) solo convierte a JSON el tablero de su proyecto,
// y aun así no se pierde nada: ni cambios en varios proyectos, ni tarjetas que cambian de proyecto, ni lo global.
// Arranca una Órbita aparte (ORBITA_PRUEBAS, puerto y carpetas temporales): no toca los datos reales.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-guardado-"));
const DATOS = path.join(TMP, "datos");
const DIR_A = path.join(TMP, "proyecto-a");
const DIR_B = path.join(TMP, "proyecto-b");
// Un puerto que el sistema da por libre (al azar podía caer en uno ocupado y fallar a veces)
const PUERTO = await new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const B = `http://127.0.0.1:${PUERTO}`;
const IA = "IA de prueba";

let servidor;
async function arrancar() {
  servidor = spawn(process.execPath, [path.join(RAIZ, "server.mjs"), "--data", DATOS, "--port", String(PUERTO)], { env: { ...process.env, ORBITA_PRUEBAS: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, mal) => {
    servidor.stdout.on("data", (d) => String(d).includes("está en") && ok());
    servidor.on("exit", (c) => mal(new Error(`Órbita terminó al arrancar (código ${c})`)));
  });
}
async function parar() {
  if (!servidor || servidor.exitCode !== null) return;
  const fin = new Promise((ok) => servidor.on("exit", ok));
  servidor.kill("SIGTERM"); // guarda lo pendiente al cerrar
  await fin;
}

async function api(ruta, body, method = body ? "POST" : "GET") {
  const r = await fetch(B + ruta, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const datos = await r.json();
  assert.ok(r.ok, `${method} ${ruta}: ${datos.error}`);
  return datos;
}
async function mcp(name, args) {
  const r = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const { result } = await r.json();
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return result.content[0].text;
}
// Guarda ya lo pendiente y devuelve qué archivos se convirtieron a JSON
const guardado = async () => (await api("/api/_guardado", {})).serializados;
const leer = (archivo) => JSON.parse(fs.readFileSync(archivo, "utf8"));
const tablero = (dir) => leer(path.join(dir, "orbita", "tablero.json"));
const titulos = (dir) => tablero(dir).tarjetas.map((c) => c.title).sort();

let A, Bp, a1, a2, b1;
before(async () => {
  fs.mkdirSync(DIR_A);
  fs.mkdirSync(DIR_B);
  await arrancar();
  A = await api("/api/projects", { name: "Proyecto A", dir: DIR_A });
  Bp = await api("/api/projects", { name: "Proyecto B", dir: DIR_B });
  a1 = await api("/api/cards", { title: "A1", projectId: A.id });
  a2 = await api("/api/cards", { title: "A2", projectId: A.id });
  b1 = await api("/api/cards", { title: "B1", projectId: Bp.id });
  await api(`/api/cards/${a1.id}/move`, { column: "doing" });
  const trabajo = JSON.parse(await mcp("wait_for_work", { worker: IA, timeout_seconds: 5 }));
  assert.equal(trabajo.work?.id, a1.id);
  await guardado();
});
after(async () => {
  await parar();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("report_progress solo convierte a JSON el tablero.json del proyecto de su tarjeta", async () => {
  await mcp("report_progress", { id: a1.id, step: "Paso 1", percent: 10, worker: IA });
  assert.deepEqual(await guardado(), [path.join(DIR_A, "orbita", "tablero.json")]);
  assert.equal(tablero(DIR_A).tarjetas.find((c) => c.id === a1.id).step, "Paso 1");
});

test("cambios en tarjetas de dos proyectos: los dos tableros quedan al día en disco", async () => {
  await mcp("report_progress", { id: a1.id, step: "Paso 2", detalle: "Avance de A1", worker: IA });
  await mcp("update_card", { id: b1.id, title: "B1 renombrada", description: "Cambiada en B", worker: IA });
  await guardado();
  const enA = tablero(DIR_A).tarjetas.find((c) => c.id === a1.id);
  const enB = tablero(DIR_B).tarjetas.find((c) => c.id === b1.id);
  assert.equal(enA.step, "Paso 2");
  assert.equal(enA.live, "Avance de A1");
  assert.equal(enB.title, "B1 renombrada");
  assert.equal(enB.description, "Cambiada en B");
});

test("una tarjeta que cambia de proyecto sale del tablero.json del anterior", async () => {
  await mcp("update_card", { id: a2.id, project: Bp.id, worker: IA });
  await guardado();
  assert.deepEqual(titulos(DIR_A), ["A1"]);
  assert.deepEqual(titulos(DIR_B), ["A2", "B1 renombrada"]);
});

test("lo global (plantillas, papelera) se sigue guardando en orbita.json", async () => {
  await api("/api/plantillas", { desde: b1.id, nombre: "Plantilla de prueba" });
  await mcp("delete_card", { ids: [a2.id], reason: "prueba de papelera", worker: IA });
  await guardado();
  const global = leer(path.join(DATOS, "orbita.json"));
  assert.ok(global.plantillas.some((p) => p.nombre === "Plantilla de prueba"));
  assert.ok(global.papelera.some((x) => x.card.id === a2.id && x.motivo === "prueba de papelera"));
  assert.deepEqual(titulos(DIR_B), ["B1 renombrada"]); // y la borrada ya no está en su tablero
});

test("el resultado no se guarda dos veces: la última versión lo marca en vez de repetirlo", async () => {
  await api(`/api/cards/${b1.id}/edit`, { result: "Primera versión" });
  await api(`/api/cards/${b1.id}/edit`, { result: "Segunda versión" });
  await guardado();
  const enDisco = tablero(DIR_B).tarjetas.find((c) => c.id === b1.id);
  assert.equal(enDisco.result, "Segunda versión");
  assert.equal(enDisco.versions.at(-1).result, undefined);
  assert.equal(enDisco.versions.at(-1).comoElResultado, true);
  assert.equal(enDisco.versions.at(-2).result, "Primera versión");
  assert.equal(JSON.stringify(enDisco).split("Segunda versión").length - 1, 1, "el texto aparece una sola vez");
  // Para la interfaz no cambia nada
  const enMemoria = (await api("/api/board")).cards.find((c) => c.id === b1.id);
  assert.deepEqual(enMemoria.versions.map((v) => v.result), ["Primera versión", "Segunda versión"]);
});

test("al reiniciar Órbita está todo, sin tarjetas duplicadas ni perdidas", async () => {
  await mcp("report_progress", { id: a1.id, step: "Último paso antes de cerrar", worker: IA }); // sin esperar al guardado
  await parar();
  await arrancar();
  const { cards, plantillas, papelera } = await api("/api/board");
  assert.deepEqual(cards.map((c) => c.title).sort(), ["A1", "B1 renombrada"]);
  assert.equal(cards.find((c) => c.id === a1.id).step, "Último paso antes de cerrar");
  assert.ok(plantillas.some((p) => p.nombre === "Plantilla de prueba"));
  assert.ok(papelera.some((x) => x.id === a2.id));
  // La última versión se rehace al leer, y los tableros antiguos (con el texto repetido) se siguen leyendo igual
  assert.deepEqual(cards.find((c) => c.id === b1.id).versions.map((v) => v.result), ["Primera versión", "Segunda versión"]);
});
