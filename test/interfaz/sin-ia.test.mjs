// Una tarjeta en curso que ninguna IA puede tomar dice por qué y ofrece la acción; el aviso se va al resolverse.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("avisos de tarjetas sin IA", { skip: SIN_CHROME }, () => {
  let o, n, hey, otro, c1;
  const aviso = (id) => n.ev(`document.querySelector('.card[data-id="${id}"] .sin-ia')?.innerText || ""`);
  const banda = () => n.ev(`(() => { const b = document.querySelector("#sinIABanda"); return b && !b.hidden ? b.innerText : ""; })()`);
  const enCurso = async (title) => {
    const c = await o.api("/api/cards", { title, projectId: hey.id });
    await o.api(`/api/cards/${c.id}/move`, { column: "doing" });
    return c;
  };
  before(async () => {
    o = await arrancarOrbita();
    hey = await o.proyecto("Hey");
    otro = await o.proyecto("Otro");
    c1 = await enCurso("Tarea de Hey");
    n = await abrirNavegador();
    await n.ir(`${o.B}/?proyecto=${hey.id}`, 2200);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("sin ninguna IA: la tarjeta y la pestaña lo dicen, con «Conectar una IA»", async () => {
    assert.match(await aviso(c1.id), /Ninguna IA conectada[\s\S]*Conectar una IA/);
    assert.match(await banda(), /1 tarjeta/);
  });

  test("con una IA dedicada a otro proyecto sigue avisando (y no dice que la tomará)", async () => {
    await o.mcp("wait_for_work", { worker: "IA de Otro", project: otro.id, timeout_seconds: 0 });
    await esperar(800);
    assert.match(await aviso(c1.id), /Ninguna IA escucha este proyecto/);
    assert.doesNotMatch(await n.ev(`document.querySelector('.card[data-id="${c1.id}"] .step').innerText`), /la tomará/);
  });

  test("el panel de la tarjeta también avisa", async () => {
    await n.ev(`document.querySelector('.card[data-id="${c1.id}"]').click()`);
    await esperar(500);
    assert.match(await n.ev(`document.querySelector("#dMeta .sin-ia")?.innerText || ""`), /Ninguna IA/);
    await n.ev(`document.querySelector("#dClose")?.click()`);
    await esperar(300);
  });

  test("«Conectar una IA» abre la instrucción para copiar, sin abrir la tarjeta", async () => {
    await n.ev(`document.querySelector('.card[data-id="${c1.id}"] [data-sin-ia]').click()`);
    await esperar(500);
    assert.ok((await n.ev(`document.querySelector("#iaInstruccion")?.textContent || ""`)).includes(hey.id));
    await n.ev(`document.querySelector("#dClose")?.click()`);
    await esperar(300);
  });

  test("desaparece en cuanto una IA general empieza a escuchar (y la toma)", async () => {
    const r = await o.mcp("wait_for_work", { worker: "IA general", timeout_seconds: 1 });
    await esperar(800);
    assert.equal(r.work?.id, c1.id);
    assert.equal(await aviso(c1.id), "");
    assert.equal(await banda(), "");
  });

  test("en pausa: «▶ Reanudar» en la tarjeta, y al reanudar se va", async () => {
    const c2 = await enCurso("Otra de Hey");
    await o.api(`/api/projects/${hey.id}/pausa`, { pausado: true });
    await esperar(800);
    assert.match(await aviso(c2.id), /pausa[\s\S]*Reanudar/);
    await n.ev(`document.querySelector('.card[data-id="${c2.id}"] [data-sin-ia]').click()`);
    await esperar(900);
    assert.equal((await o.api("/api/board")).projects.find((x) => x.id === hey.id).pausado, false);
    assert.doesNotMatch(await aviso(c2.id), /pausa/);
  });

  test("con IA propia desconectada la nombra y ofrece «Lanzarla»; se va cuando escucha", async () => {
    await o.api(`/api/projects/${hey.id}/ia`, { ia: "IA de Hey" });
    await esperar(800);
    const card = (await o.api("/api/board")).cards.find((c) => c.title === "Otra de Hey");
    assert.match(await aviso(card.id), /IA de Hey, la IA de este proyecto, no está conectada[\s\S]*Lanzarla/);
    const r = await o.mcp("wait_for_work", { worker: "IA de Hey", project: hey.id, timeout_seconds: 1 });
    await esperar(800);
    assert.equal(r.work?.id, card.id);
    assert.equal(await aviso(card.id), "");
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
