// Pausa sin cortes: un solo control de la IA del proyecto; al pausar, la IA termina su tarjeta y no toma más.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("pausa", { skip: SIN_CHROME }, () => {
  let o, n, p, enMarcha, siguiente;
  const IA = "Claude · pausa";
  before(async () => {
    o = await arrancarOrbita();
    p = await o.proyecto("Pausa");
    await o.proyecto("Otro");
    enMarcha = await o.api("/api/cards", { title: "La que está haciendo", projectId: p.id });
    siguiente = await o.api("/api/cards", { title: "La siguiente", projectId: p.id });
    await o.api(`/api/cards/${enMarcha.id}/move`, { column: "doing" });
    await o.api(`/api/cards/${siguiente.id}/move`, { column: "doing" });
    const w = await o.mcp("wait_for_work", { worker: IA, project: p.id, timeout_seconds: 2 });
    assert.equal(w.work?.id, enMarcha.id);
    n = await abrirNavegador();
    await n.ir(`${o.B}/?proyecto=${p.id}`, 2200);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("un solo control: la IA del proyecto y «▶ Trabajando»; sin «Solo este»", async () => {
    const r = await n.ev(`({ controles: document.querySelectorAll("#subnav .ia-control").length, botones: [...document.querySelectorAll("#subnav .pp-btn")].map((b) => b.innerText.trim()), solo: !!document.querySelector('[data-pp="solo"]') })`);
    assert.equal(r.controles, 1);
    assert.deepEqual(r.botones, [`🧠 ${IA}`, "▶ Trabajando"]);
    assert.equal(r.solo, false);
  });

  test("al pausar, la tarjeta en marcha sigue: la IA no recibe «DETENTE» y la tarjeta lo dice", async () => {
    await n.ev(`document.querySelector('#subnav [data-pp="pausar"]').click()`);
    await esperar(900);
    assert.equal((await o.api("/api/board")).projects.find((x) => x.id === p.id).pausado, true);
    assert.equal((await o.tarjeta(enMarcha.id)).status, "running");
    await o.mcp("report_progress", { id: enMarcha.id, step: "Sigo con ella", percent: 70, worker: IA }); // no lanza DETENTE
    await esperar(500);
    assert.match(await n.ev(`document.querySelector('.card[data-id="${enMarcha.id}"] .meta-pausa')?.innerText || ""`), /terminará esta y parará/);
    assert.equal(await n.ev(`document.querySelector('#subnav .ic-estado').innerText.trim()`), "⏸ Termina y para");
    assert.match(await n.ev(`document.querySelector("#pausaBanda").innerText`), /termina «La que está haciendo» y para/);
  });

  test("la IA entrega la que tenía y no recibe la siguiente mientras dura la pausa", async () => {
    await o.mcp("submit_result", { id: enMarcha.id, result: "Terminada.", worker: IA });
    assert.equal((await o.tarjeta(enMarcha.id)).column, "review");
    const w = await o.mcp("wait_for_work", { worker: IA, project: p.id, timeout_seconds: 1 });
    assert.equal(w.work, null);
    await esperar(600);
    assert.equal(await n.ev(`document.querySelector('#subnav .ic-estado').innerText.trim()`), "⏸ En pausa");
  });

  test("al reanudar desde el mismo control, la IA toma la siguiente", async () => {
    await n.ev(`document.querySelector('#subnav [data-pp="reanudar"]').click()`);
    await esperar(800);
    assert.equal(await n.ev(`document.querySelector('#subnav .ic-estado').innerText.trim()`), "▶ Trabajando");
    const w = await o.mcp("wait_for_work", { worker: IA, project: p.id, timeout_seconds: 2 });
    assert.equal(w.work?.id, siguiente.id);
  });

  test("la mitad de la IA abre su panel con la instrucción para lanzarla", async () => {
    await n.ev(`document.querySelector('#subnav [data-pp="ia"]').click()`);
    await esperar(500);
    assert.ok((await n.ev(`document.querySelector("#iaInstruccion")?.textContent || ""`)).includes(p.id));
    await n.ev(`document.querySelector("#dClose")?.click()`);
  });

  test("en el móvil el control se ve entero", async () => {
    await n.tamano(390, 844, true);
    await esperar(400);
    const fuera = await n.ev(`[...document.querySelectorAll("#subnav .pp-btn")].some((b) => { const r = b.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < 0 || !r.width; })`);
    assert.equal(fuera, false);
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
