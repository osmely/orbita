// «＋ Nueva tarjeta»: título → Enter la crea y se la pide a la IA; lo demás está en «Más opciones»; teclado y móvil.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, META, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("nueva tarjeta", { skip: SIN_CHROME }, () => {
  let o, n;
  const porTitulo = async (t) => (await o.api("/api/board")).cards.find((c) => c.title === t);
  const abrir = async () => {
    await n.ev(`document.querySelector("#addBtn").click()`);
    await esperar(300);
  };
  before(async () => {
    o = await arrancarOrbita();
    const p = await o.proyecto("Web");
    await o.proyecto("Datos");
    n = await abrirNavegador();
    await n.ir(`${o.B}/?proyecto=${p.id}`, 2200);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("a la vista solo título, descripción y los botones; el resto, plegado", async () => {
    await abrir();
    const v = await n.ev(`(() => { const ve = (s) => !!document.querySelector(s)?.checkVisibility(); return { titulo: ve('#newForm [name=title]'), desc: ve('#newForm [name=description]'), criterios: ve('#newForm [name=criterios]'), proyecto: ve('#newProject'), entregable: ve('#newForm [name=entregable]'), foco: document.activeElement.name }; })()`);
    assert.deepEqual(v, { titulo: true, desc: true, criterios: false, proyecto: false, entregable: false, foco: "title" });
  });

  test("título → Enter: se crea y va a la IA (En curso)", async () => {
    await n.escribir("Tarea rápida con Enter");
    await n.tecla("Enter");
    await esperar(700);
    assert.equal((await porTitulo("Tarea rápida con Enter"))?.column, "doing");
    assert.equal(await n.ev(`document.querySelector("#newDialog").open`), false);
  });

  test("«Solo crear» la deja en Ideas", async () => {
    await abrir();
    await n.escribir("Solo creada");
    await n.ev(`document.querySelector('#newForm button[value="ok"]').click()`);
    await esperar(700);
    assert.equal((await porTitulo("Solo creada"))?.column, "backlog");
  });

  test("Esc cierra sin crear", async () => {
    await abrir();
    await n.escribir("No debe existir");
    await n.tecla("Escape");
    await esperar(400);
    assert.equal(await n.ev(`document.querySelector("#newDialog").open`), false);
    assert.equal(await porTitulo("No debe existir"), undefined);
  });

  test("«Más opciones»: criterios y entregable, con resumen; Cmd/Ctrl+Enter desde la descripción", async () => {
    await abrir();
    await n.escribir("Con opciones");
    await n.ev(`document.querySelector("#newMas summary").click()`);
    await esperar(200);
    await n.ev(`(() => { const f = document.querySelector("#newForm"); f.criterios.value = "Uno\\nDos"; f.entregable.checked = true; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.match(await n.ev(`document.querySelector("#newResumen").textContent`), /2 criterios.*entregable/);
    await n.ev(`document.querySelector("#newForm [name=description]").focus()`);
    await n.escribir("detalle");
    await n.tecla("Enter", META);
    await esperar(700);
    const c = await porTitulo("Con opciones");
    assert.equal(c?.column, "doing");
    assert.equal(c.criterios.length, 2);
    assert.equal(c.entregable, true);
    assert.equal(c.description, "detalle");
  });

  test("Enter en la descripción hace salto de línea, no envía", async () => {
    await abrir();
    await n.escribir("Multilínea");
    await n.ev(`document.querySelector("#newForm [name=description]").focus()`);
    await n.tecla("Enter");
    await esperar(300);
    const abierto = await n.ev(`document.querySelector("#newDialog").open`);
    await n.tecla("Escape");
    await esperar(300);
    assert.equal(abierto, true);
  });

  test("una plantilla con criterios abre «Más opciones» sola", async () => {
    const pl = await o.api("/api/plantillas", { desde: (await porTitulo("Con opciones")).id, nombre: "Con criterios" });
    await n.ev(`import("/js/nucleo.js").then((m) => { m.state.plantillas = [...(m.state.plantillas || []), ${JSON.stringify(pl)}]; })`);
    await n.ev(`import("/js/acciones.js").then((m) => m.abrirNueva(${JSON.stringify(pl.id)}))`);
    await esperar(300);
    const abierto = await n.ev(`document.querySelector("#newMas").open`);
    await n.tecla("Escape");
    await esperar(300);
    assert.equal(abierto, true);
  });

  test("en el móvil (375 px) no se sale nada y el botón principal va arriba", async () => {
    await n.tamano(375, 740, true);
    await esperar(300);
    await abrir();
    const m = await n.ev(`(() => { const d = document.querySelector("#newDialog").getBoundingClientRect(); const p = document.querySelector('#newForm .primary').getBoundingClientRect(); const bs = [...document.querySelectorAll('.nueva-botones button')].map((b) => b.getBoundingClientRect()); return { dentro: d.left >= 0 && d.right <= innerWidth, arriba: p.top <= Math.min(...bs.map((b) => b.top)), fuera: bs.some((b) => b.right > d.right + 1) }; })()`);
    await n.tecla("Escape");
    assert.deepEqual(m, { dentro: true, arriba: true, fuera: false });
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
