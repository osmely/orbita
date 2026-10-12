// Tokens por tarjeta a partir de un registro de sesión de Claude Code (con la forma real de sus líneas)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-tokens-"));
process.env.ORBITA_CLAUDE_PROYECTOS = RAIZ;
const { contarTokens, carpetaDeSesiones } = await import("../tokens.mjs");

const DIR = "/Users/alguien/Mis proyectos/web";
const carpeta = carpetaDeSesiones(DIR);
const archivo = path.join(carpeta, "sesion.jsonl");
const uso = (entrada, cache, salida) => ({ input_tokens: entrada, cache_read_input_tokens: cache, cache_creation_input_tokens: 0, output_tokens: salida });
const asistente = (id, usage, herramientas = []) => JSON.stringify({ type: "assistant", message: { id, usage, content: herramientas.map(([tid, name, input]) => ({ type: "tool_use", id: tid, name, input })) } });
const resultado = (tid, texto) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid, content: [{ type: "text", text: texto }] }] } });
const escribir = (lineas) => fs.appendFileSync(archivo, lineas.join("\n") + "\n");

test("la carpeta de sesiones es la de Claude Code (lo que no es letra o número, «-»)", () => {
  assert.equal(path.basename(carpeta), "-Users-alguien-Mis-proyectos-web");
});

test("cada respuesta cuenta para la tarjeta que la IA tiene entre manos, una sola vez", async () => {
  fs.mkdirSync(carpeta, { recursive: true });
  escribir([
    asistente("m0", uso(10, 0, 5), [["t1", "mcp__orbita__wait_for_work", { worker: "IA" }]]), // aún sin tarjeta: no cuenta
    resultado("t1", JSON.stringify({ work: { id: "aaaaaaaa", title: "A" } }, null, 2)),
    asistente("m1", uso(100, 1000, 20)),
    asistente("m1", uso(100, 1000, 20)), // el mismo mensaje en otra línea
    asistente("m2", uso(50, 2000, 30), [["t2", "mcp__orbita__report_progress", { id: "aaaaaaaa", step: "x" }]]),
    asistente("m3", uso(5, 3000, 40), [["t3", "mcp__orbita__submit_result", { id: "aaaaaaaa", result: "ok" }]]),
    asistente("m4", uso(7, 0, 7)), // ya entregada: de nadie
    // Retoma otra sin wait_for_work (p. ej., tras reiniciar la sesión)
    asistente("m5", uso(1, 500, 9), [["t4", "mcp__orbita__report_progress", { id: "bbbbbbbb", step: "y" }]]),
  ]);
  const t = await contarTokens([DIR]);
  assert.deepEqual(t.get("aaaaaaaa"), { entrada: 100 + 1000 + 50 + 2000 + 5 + 3000, salida: 20 + 30 + 40, cacheLeida: 6000, mensajes: 3 });
  assert.deepEqual(t.get("bbbbbbbb"), { entrada: 501, salida: 9, cacheLeida: 500, mensajes: 1 });
  assert.equal(t.size, 2);
});

test("en la siguiente pasada solo lee lo añadido (y una línea a medias espera a completarse)", async () => {
  const linea = asistente("m6", uso(2, 100, 11));
  fs.appendFileSync(archivo, linea.slice(0, 20)); // a medio escribir
  let t = await contarTokens([DIR]);
  assert.equal(t.get("bbbbbbbb").mensajes, 1);
  fs.appendFileSync(archivo, linea.slice(20) + "\n");
  t = await contarTokens([DIR]);
  assert.deepEqual(t.get("bbbbbbbb"), { entrada: 501 + 102, salida: 9 + 11, cacheLeida: 600, mensajes: 2 });
});

test("una carpeta que Claude Code no ha abierto nunca no da error", async () => {
  const t = await contarTokens(["/no/existe"]);
  assert.ok(t instanceof Map);
  fs.rmSync(RAIZ, { recursive: true, force: true });
});
