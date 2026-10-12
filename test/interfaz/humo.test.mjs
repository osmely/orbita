// Recorrido general: usa Órbita como una persona (crear, abrir, mover, secciones, ⌘K, entidades…) y la IA entrega.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, META, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("humo: un recorrido por toda la interfaz", { skip: SIN_CHROME }, () => {
  let o, n, p, id;
  before(async () => {
    o = await arrancarOrbita();
    p = await o.proyecto("Humo");
    n = await abrirNavegador();
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("carga la página con sus 4 columnas y la pestaña del proyecto", async () => {
    await n.ir(`${o.B}/?proyecto=${p.id}`, 2200);
    assert.equal(await n.ev(`document.querySelectorAll(".col").length`), 4);
    assert.equal(await n.ev(`document.querySelectorAll(".tabs .tab").length`), 1);
  });

  test("crear tarjeta con «＋ Nueva tarjeta» (Solo crear → Ideas)", async () => {
    await n.ev(`document.querySelector("#addBtn").click()`);
    await esperar(300);
    await n.ev(`document.querySelector('#newForm [name="title"]').focus()`);
    await n.escribir("Tarjeta creada en la prueba");
    await n.ev(`document.querySelector('#newForm button[value="ok"]').click()`);
    await esperar(700);
    const c = (await o.api("/api/board")).cards.find((x) => x.title === "Tarjeta creada en la prueba");
    assert.equal(c?.column, "backlog");
    id = c.id;
    assert.ok(await n.ev(`!!document.querySelector('.col[data-col="backlog"] .card[data-id="${id}"]')`));
  });

  test("abrir el panel de la tarjeta y recorrer sus pestañas", async () => {
    await n.ev(`document.querySelector('.card[data-id="${id}"]').click()`);
    await esperar(500);
    for (const t of ["chat", "resultado", "ajustes", "actividad", "tarea"]) {
      await n.ev(`document.querySelector('#dTabs [data-tab="${t}"]').click()`);
      await esperar(120);
    }
  });

  test("añadir un criterio y escribir en la conversación", async () => {
    await n.ev(`document.querySelector("#dCritInput").focus()`);
    await n.escribir("Funciona con módulos");
    await n.tecla("Enter");
    await esperar(500);
    await n.ev(`document.querySelector('#dTabs [data-tab="chat"]').click()`);
    await n.ev(`document.querySelector("#dFeedbackText").focus()`);
    await n.escribir("Nota de la prueba");
    await n.ev(`document.querySelector('#dSend [data-a="comment"]').click()`);
    await esperar(500);
    const c = await o.tarjeta(id);
    assert.equal(c.criterios.length, 1);
    assert.ok(c.thread.some((m) => m.texto === "Nota de la prueba"));
  });

  test("mover la tarjeta con la paleta (⌘K → «En curso»)", async () => {
    await n.tecla("k", META, "KeyK");
    await esperar(400);
    assert.ok(await n.ev(`!document.querySelector("#buscador").hidden`), "⌘K no abrió la paleta");
    await n.escribir("curso");
    await esperar(400);
    await n.tecla("Enter");
    await esperar(800);
    assert.equal((await o.tarjeta(id)).column, "doing");
  });

  test("⌘K solo tiene comandos: no busca en tarjetas y no hay 🔍", async () => {
    await n.tecla("Escape");
    await esperar(200);
    await n.ev(`document.querySelector("#drawer.on") && document.querySelector("#dClose")?.click()`);
    await n.tecla("k", META, "KeyK");
    await esperar(300);
    await n.escribir("Tarjeta creada");
    await esperar(400);
    const r = await n.ev(`({ items: [...document.querySelectorAll("#buscarLista [data-i]")].map((li) => li.className), lupa: !!document.querySelector("#searchBtn") })`);
    await n.tecla("Escape");
    assert.equal(r.lupa, false);
    assert.ok(r.items.every((c) => c.includes("b-cmd")), JSON.stringify(r.items));
  });

  test("vista previa aislada de un entregable HTML", async () => {
    await o.api(`/api/cards/${id}/move`, { column: "backlog" });
    await o.api(`/api/cards/${id}/move`, { column: "doing" });
    await o.mcp("wait_for_work", { worker: "IA humo", timeout_seconds: 3 });
    await o.mcp("write_file", { card_id: id, path: "juego.html", content: "<!doctype html><title>j</title><p id=x>hola</p>", worker: "IA humo" });
    await esperar(500);
    await n.ev(`document.querySelector('#subnav [data-s="entregables"]').click()`);
    await esperar(500);
    await n.ev(`[...document.querySelectorAll("#page .file")].find((b) => b.textContent.includes("juego.html")).click()`);
    await esperar(800);
    assert.match(await n.ev(`document.querySelector("#vFrame")?.getAttribute("src") || ""`), /^\/vista\//);
  });

  test("las 4 secciones se abren", async () => {
    for (const s of ["ajustes", "entidades", "entregables", "tablero"]) {
      await n.ev(`document.querySelector("#dClose")?.click(); document.querySelector('#subnav [data-s="${s}"]').click()`);
      await esperar(400);
    }
    assert.equal(await n.ev(`[...document.querySelectorAll("#subnav .sub")].map((b) => b.dataset.s).join(",")`), "tablero,ajustes,entidades,entregables");
  });

  test("el conocimiento está en «Contexto para la IA» y el archivo se abre desde «Hecho»", async () => {
    await n.ev(`document.querySelector('#subnav [data-s="ajustes"]').click()`);
    await esperar(300);
    assert.ok(await n.ev(`!!document.querySelector("#page [data-conocimiento] .kn-drop")`));
    await n.ev(`document.querySelector('#subnav [data-s="tablero"]').click()`);
    await esperar(300);
    await n.ev(`document.querySelector("#verArchivo").click()`);
    await esperar(300);
    assert.ok(await n.ev(`!!document.querySelector("#page .archivo-cabeza h2")`));
    assert.equal(await n.ev(`document.querySelector("#subnav .sub.on")?.dataset.s`), "tablero");
    await n.ev(`document.querySelector("#page [data-volver]").click()`);
    await esperar(300);
    assert.equal(await n.ev(`document.querySelector("#board").hidden`), false);
  });

  for (const [busca, llega] of [
    ["conocimiento", `document.querySelector('#subnav .sub.on')?.dataset.s === "ajustes" && !!document.querySelector("#page [data-conocimiento]")`],
    ["papelera", `!!document.querySelector("#page .archivo-cabeza")`],
  ])
    test(`⌘K «${busca}» lleva a su sitio`, async () => {
      await n.ev(`document.querySelector('#subnav [data-s="tablero"]').click()`);
      await esperar(300);
      await n.tecla("k", META, "KeyK");
      await esperar(400);
      await n.escribir(busca);
      await esperar(400);
      await n.tecla("Enter");
      await esperar(600);
      assert.ok(await n.ev(llega));
    });

  test("nueva entidad desde la interfaz", async () => {
    await n.ev(`document.querySelector('#subnav [data-s="entidades"]').click()`);
    await esperar(300);
    await n.ev(`document.querySelector("[data-nueva]").click()`);
    await esperar(300);
    await n.ev(`document.querySelector("#eNombre").focus()`);
    await n.escribir("Espada de prueba");
    await n.ev(`document.querySelector("#eCat").value = "Armas"; document.querySelector("#eGuardar").click()`);
    await esperar(700);
    const e = (await o.api("/api/board")).projects.find((x) => x.id === p.id).entidades?.find((x) => x.nombre === "Espada de prueba");
    assert.equal(e?.categoria, "Armas");
  });

  test("tema, avisos y barra de objetivo (sin preguntas rápidas)", async () => {
    await n.ev(`document.querySelector('#subnav [data-s="tablero"]').click(); document.querySelector("#temaBtn").click(); document.querySelector("#temaBtn").click()`);
    await n.ev(`document.querySelector("#alertsBtn").click()`);
    await esperar(200);
    await n.ev(`document.body.click()`);
    const r = await n.ev(`({ qa: !!document.querySelector("#qaBtn"), modo: !!document.querySelector(".modo") })`);
    assert.deepEqual(r, { qa: false, modo: false });
  });

  test("la IA entrega y el tablero se actualiza en vivo", async () => {
    const criterios = (await o.tarjeta(id)).criterios.map((c) => ({ id: c.id, met: true, evidence: "prueba" }));
    await o.mcp("submit_result", { id, result: "Hecho en la prueba", worker: "IA humo", criteria: criterios });
    await esperar(800);
    assert.ok(await n.ev(`!!document.querySelector('.col[data-col="review"] .card[data-id="${id}"]')`));
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
