// Ciclo completo por MCP: todas las herramientas que ve la IA siguen funcionando y su peso no se dispara.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-mcp-"));
const DATOS = path.join(TMP, "datos");
const DIR = path.join(TMP, "proyecto");
// Un puerto que el sistema da por libre (al azar podía caer en uno ocupado y fallar a veces)
const PUERTO = await new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const B = `http://127.0.0.1:${PUERTO}`;
const IA = "IA de prueba";

let servidor;
before(async () => {
  fs.mkdirSync(DIR);
  servidor = spawn(process.execPath, [path.join(RAIZ, "server.mjs"), "--data", DATOS, "--port", String(PUERTO), "--no-open"], { env: { ...process.env, ORBITA_PRUEBAS: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, mal) => {
    servidor.stdout.on("data", (d) => String(d).includes("está en") && ok());
    servidor.on("exit", (c) => mal(new Error(`Órbita terminó al arrancar (código ${c})`)));
  });
});
after(async () => {
  if (servidor?.exitCode === null) {
    const fin = new Promise((ok) => servidor.on("exit", ok));
    servidor.kill("SIGTERM");
    await fin;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function api(ruta, body, method = body ? "POST" : "GET") {
  const r = await fetch(B + ruta, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const datos = await r.json();
  assert.ok(r.ok, `${method} ${ruta}: ${datos.error}`);
  return datos;
}
async function rpc(method, params = {}) {
  const r = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  const texto = result.content[0].text;
  try { return JSON.parse(texto); } catch { return texto; }
}
const tarjeta = async (id) => (await api("/api/board")).cards.find((c) => c.id === id);

test("instrucciones + herramientas caben en 3.500 tokens", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prueba", version: "1" } });
  const { tools } = await rpc("tools/list");
  const caracteres = (init.instructions || "").length + JSON.stringify(tools).length;
  assert.ok(caracteres / 4 <= 3500, `≈${Math.round(caracteres / 4)} tokens`);
});

test("ciclo completo: proyecto, trabajo, pregunta a la persona, plan, archivos, memoria, entidades, secretos, papelera y entrega", async () => {
  // Proyecto y tarjeta en curso
  const p = await mcp("open_project", { directory: DIR, name: "Prueba MCP", worker: IA });
  const pid = p.project?.id || p.id;
  assert.ok(pid, "open_project devuelve el proyecto");
  await api(`/api/projects/${pid}/secretos`, { nombre: "CLAVE_PRUEBA", valor: "valor-secreto-123" });
  const c = await api("/api/cards", { title: "Tarea", projectId: pid });
  await api(`/api/cards/${c.id}/edit`, { criterios: ["Funciona"] });
  await api(`/api/cards/${c.id}/move`, { column: "doing" });
  let w = await mcp("wait_for_work", { worker: IA, project: pid, timeout_seconds: 5 });
  assert.equal(w.work?.id, c.id);

  // Progreso, nota y pregunta a la persona (y su respuesta por wait_for_work)
  await mcp("report_progress", { id: c.id, step: "Paso 1", percent: 20, detalle: "**Hecho** algo", worker: IA });
  assert.equal((await tarjeta(c.id)).step, "Paso 1");
  await mcp("add_comment", { id: c.id, text: "Una nota", worker: IA });
  await mcp("ask_human", { id: c.id, question: "¿Azul o verde?", worker: IA });
  await api(`/api/cards/${c.id}/feedback`, { text: "Verde" });
  w = await mcp("wait_for_work", { worker: IA, project: pid, timeout_seconds: 5 });
  assert.equal(w.work?.id, c.id);
  assert.ok(JSON.stringify(w.work.inbox).includes("Verde"), "la respuesta llega en el inbox");

  // Secretos, memoria y entidades
  assert.match(JSON.stringify(await mcp("get_secret", { card_id: c.id, name: "CLAVE_PRUEBA", worker: IA })), /valor-secreto-123/);
  await mcp("update_memory", { card_id: c.id, memory: "Prefiere verde", worker: IA });
  const e = await mcp("entities", { action: "save", card_id: c.id, category: "Personajes", name: "Ana", summary: "La protagonista", worker: IA });
  const eid = (e.created || e.updated)?.id;
  assert.ok(eid, "entities save devuelve la ficha");
  assert.match(JSON.stringify(await mcp("entities", { action: "list", card_id: c.id, query: "Ana" })), /protagonista/);
  await mcp("entities", { action: "delete", card_id: c.id, id: eid, worker: IA });
  assert.doesNotMatch(JSON.stringify(await mcp("entities", { action: "list", card_id: c.id })), /protagonista/);

  // Archivos: escribir, listar y leer
  const f = await mcp("write_file", { card_id: c.id, path: "notas/hola.md", content: "# Hola", worker: IA });
  const ruta = JSON.stringify(f).match(/[\w./-]*notas\/hola\.md/)[0].replace(/^\/files\//, "");
  assert.match(JSON.stringify(await mcp("read_file", {})), /hola\.md/);
  assert.match(JSON.stringify(await mcp("read_file", { path: ruta })), /# Hola/);

  // Plan: crear, editar (con columna), borrar y restaurar de la papelera
  const h = await mcp("create_card", { title: "Subtarea", description: "Algo", parent_id: c.id, criteria: ["Hecha"], deliverable: true, worker: IA });
  const hid = h.created.id;
  assert.ok((await tarjeta(hid)).entregable, "create_card con deliverable");
  assert.deepEqual((await tarjeta(hid)).criterios.map((x) => x.texto), ["Hecha"]);
  // Con el nombre con el que la IA los ve en las tarjetas, también
  const h2 = await mcp("create_card", { title: "Con acceptance_criteria", parent_id: c.id, acceptance_criteria: ["Uno"], worker: IA });
  assert.deepEqual((await tarjeta(h2.created.id)).criterios.map((x) => x.texto), ["Uno"]);
  await mcp("update_card", { id: hid, title: "Subtarea 2", column: "review", worker: IA });
  let t = await tarjeta(hid);
  assert.equal(t.title, "Subtarea 2");
  assert.equal(t.column, "review");
  assert.match(JSON.stringify(await mcp("list_cards", { project: pid })), /Subtarea 2/);
  assert.match(JSON.stringify(await mcp("get_card", { id: hid })), /Subtarea 2/);
  await mcp("delete_card", { ids: [hid], reason: "Prueba", worker: IA });
  assert.equal(await tarjeta(hid), undefined);
  assert.match(JSON.stringify(await mcp("trash", {})), new RegExp(hid));
  await mcp("trash", { id: hid, worker: IA });
  assert.ok(await tarjeta(hid), "trash con id la restaura");

  // Entrega con criterios
  await mcp("submit_result", { id: c.id, result: "Resumen. Hecho.", criteria: [{ id: (await tarjeta(c.id)).criterios[0].id, met: true, evidence: "prueba" }], worker: IA });
  t = await tarjeta(c.id);
  assert.equal(t.column, "review");
  assert.equal(t.result, "Resumen. Hecho.");

});

test("no hay comandos (prompts): la app de Claude los rechazaba", async () => {
  const r = await rpc("prompts/list");
  assert.ok(!r?.prompts?.length, JSON.stringify(r));
});

test("wait_for_work acepta cualquier espera sin error (la recorta a 55 s) y las instrucciones dicen que se reintente", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prueba", version: "1" } });
  assert.match(init.instructions, /no responde.*vuelve a llamar/s);
  const dir = path.join(TMP, "espera");
  fs.mkdirSync(dir);
  const p = await api("/api/projects", { name: "Espera", dir });
  const c = await api("/api/cards", { title: "Lista", projectId: p.id });
  await api(`/api/cards/${c.id}/move`, { column: "doing" });
  const t0 = Date.now();
  const w = await mcp("wait_for_work", { worker: "IA de espera", project: p.id, timeout_seconds: 999 });
  assert.equal(w.work?.id, c.id);
  assert.ok(Date.now() - t0 < 5000);
});

test("el orden de «En curso» manda siempre, también para las tarjetas devueltas a la IA", async () => {
  const dir = path.join(TMP, "orden");
  fs.mkdirSync(dir);
  const p = await api("/api/projects", { name: "Orden", dir });
  const IA = "IA del orden";
  const crear = async (title) => {
    const c = await api("/api/cards", { title, projectId: p.id });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    return c;
  };
  const toma = async () => (await mcp("wait_for_work", { worker: IA, project: p.id, timeout_seconds: 1 })).work?.title;
  const devuelta = await crear("Devuelta");
  assert.equal(await toma(), "Devuelta");
  await mcp("submit_result", { id: devuelta.id, result: "Primera entrega.", worker: IA });
  const otra = await crear("Otra");
  const tercera = await crear("Tercera");
  // La persona comenta el resultado: vuelve a «En curso», al final de la cola, para su misma IA
  await api(`/api/cards/${devuelta.id}/feedback`, { text: "Falta una cosa" });
  assert.equal((await tarjeta(devuelta.id)).status, "returned");
  assert.equal(await toma(), "Otra", "la devuelta no se salta la cola");
  await mcp("submit_result", { id: otra.id, result: "ok", worker: IA });
  // Si la persona la sube arriba, va primero
  await api(`/api/cards/${devuelta.id}/move`, { column: "doing", beforeId: tercera.id });
  assert.equal(await toma(), "Devuelta");
  await mcp("submit_result", { id: devuelta.id, result: "Corregida.", worker: IA });
  assert.equal(await toma(), "Tercera");
});
