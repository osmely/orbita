// Cada tarjeta muestra los tokens que gastó la IA, leídos de los registros de Claude Code de la carpeta del proyecto
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("tokens por tarjeta", { skip: SIN_CHROME }, () => {
  const sesiones = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-sesiones-"));
  let o, n, p, c, dir;
  before(async () => {
    process.env.ORBITA_CLAUDE_PROYECTOS = sesiones; // la Órbita de la prueba lee aquí, no en ~/.claude
    o = await arrancarOrbita();
    delete process.env.ORBITA_CLAUDE_PROYECTOS;
    dir = o.carpeta("Web");
    p = await o.api("/api/projects", { name: "Web", dir });
    c = await o.api("/api/cards", { title: "Con tokens", projectId: p.id });
    const carpeta = path.join(sesiones, dir.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(carpeta, { recursive: true });
    const linea = (o) => JSON.stringify(o);
    fs.writeFileSync(
      path.join(carpeta, "s.jsonl"),
      [
        linea({ type: "assistant", message: { id: "m1", usage: { input_tokens: 3, cache_read_input_tokens: 1_200_000, cache_creation_input_tokens: 4000, output_tokens: 12_500 }, content: [{ type: "tool_use", id: "t1", name: "mcp__orbita__report_progress", input: { id: c.id, step: "x" } }] } }),
        linea({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 2500 }, content: [{ type: "tool_use", id: "t2", name: "mcp__orbita__submit_result", input: { id: c.id, result: "ok" } }] } }),
      ].join("\n") + "\n",
    );
    n = await abrirNavegador();
    await n.ir(`${o.B}/?proyecto=${p.id}`, 1500);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
    fs.rmSync(sesiones, { recursive: true, force: true });
  });

  test("Órbita los cuenta sola y la tarjeta los guarda", async () => {
    let t;
    for (let i = 0; i < 30 && !t; i++) {
      await esperar(300);
      t = (await o.tarjeta(c.id)).tokens;
    }
    assert.equal(t?.entrada, 3 + 1_200_000 + 4000 + 2 + 300_000);
    assert.equal(t.salida, 15_000);
    assert.equal(t.mensajes, 2);
  });

  test("se ven en la tarjeta del tablero y en su panel, sin recargar", async () => {
    await esperar(500);
    assert.equal(await n.ev(`document.querySelector('.card[data-id="${c.id}"] .chip.tokens')?.textContent`), "⇣ 1,5M · ⇡ 15k");
    await n.ev(`document.querySelector('.card[data-id="${c.id}"]').click()`);
    await esperar(500);
    assert.match(await n.ev(`document.querySelector("#dMeta .chip.tokens")?.textContent || ""`), /Tokens: ⇣ 1,5M · ⇡ 15k/);
    assert.match(await n.ev(`document.querySelector("#dMeta .chip.tokens").title`), /1.504.005|1,504,005/);
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
