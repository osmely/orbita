// Entregables: solo las tarjetas marcadas; al aprobarlas, su resultado se guarda en orbita/entregables/ y se ve en su sección.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("entregables", { skip: SIN_CHROME }, () => {
  let o, n, p, dir, t, e;
  const IA = "Claude · web";
  const trabajar = async (c, result, archivos = []) => {
    await o.api(`/api/cards/${c.id}/move`, { column: "doing" });
    await o.mcp("wait_for_work", { worker: IA, timeout_seconds: 3 });
    for (const a of archivos) await o.mcp("write_file", { card_id: c.id, path: a, content: "x", worker: IA });
    await o.mcp("submit_result", { id: c.id, result, worker: IA });
  };
  before(async () => {
    o = await arrancarOrbita();
    dir = o.carpeta("Tienda");
    p = await o.api("/api/projects", { name: "Tienda", dir });
    n = await abrirNavegador({ ancho: 1300, alto: 950 });
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("una tarea intermedia no es entregable", async () => {
    t = await o.api("/api/cards", { title: "Probar el carrito en el móvil", projectId: p.id });
    await trabajar(t, "Funciona en el móvil.", ["capturas/carrito-movil.png"]);
    await o.api(`/api/cards/${t.id}/move`, { column: "done" });
    assert.ok(!(await o.tarjeta(t.id)).documento);
  });

  test("al aprobar una entregable, su resultado se guarda en orbita/entregables/", async () => {
    e = await o.api("/api/cards", { title: "Informe de ventas de octubre", projectId: p.id, entregable: true });
    assert.equal(e.entregable, true);
    await trabajar(e, "**Resumen:** 1.200 € en octubre, +12 %.", ["ventas.csv"]);
    assert.ok(!(await o.tarjeta(e.id)).documento, "antes de aprobarla no hay documento");
    await o.api(`/api/cards/${e.id}/move`, { column: "done" });
    assert.equal((await o.tarjeta(e.id)).documento, "tienda/entregables/informe-de-ventas-de-octubre.md");
    assert.match(fs.readFileSync(path.join(dir, "orbita", "entregables", "informe-de-ventas-de-octubre.md"), "utf8"), /1\.200 €/);
  });

  test("la IA crea tarjetas entregables con deliverable", async () => {
    await o.mcp("create_card", { title: "Manual de usuario", project: p.id, deliverable: true });
    await o.mcp("create_card", { title: "Instalar dependencias", project: p.id });
    const todas = (await o.api("/api/board")).cards;
    assert.equal(todas.find((x) => x.title === "Manual de usuario").entregable, true);
    assert.equal(todas.find((x) => x.title === "Instalar dependencias").entregable, false);
  });

  test("marcar una ya aprobada guarda su documento al momento", async () => {
    await o.api(`/api/cards/${t.id}/edit`, { entregable: true });
    assert.match((await o.tarjeta(t.id)).documento || "", /probar-el-carrito-en-el-movil\.md$/);
    await o.api(`/api/cards/${t.id}/edit`, { entregable: false });
  });

  test("la sección «Entregables» muestra solo las entregables, con su estado, y aparte los archivos de trabajo", async () => {
    await n.ir(`${o.B}/?proyecto=${p.id}`, 1800);
    assert.equal(await n.ev(`[...document.querySelectorAll(".card")].filter((c) => c.querySelector(".chip.entregable")).length`), 2);
    await n.ev(`document.querySelector('#subnav [data-s="entregables"]').click()`);
    await esperar(600);
    const info = await n.ev(`({ entregables: [...document.querySelectorAll(".entregable-doc .link-card")].map((b) => b.textContent), estados: [...document.querySelectorAll(".ent-estado")].map((s) => s.textContent.trim()), trabajo: [...document.querySelectorAll(".trabajo .file")].map((b) => b.textContent), contador: document.querySelector('#subnav [data-s="entregables"] b')?.textContent })`);
    assert.deepEqual(info.entregables, ["Informe de ventas de octubre", "Manual de usuario"]);
    assert.match(info.estados[0], /^✓ Aprobado/);
    assert.equal(info.estados[1], "En preparación");
    assert.ok(info.trabajo.some((x) => x.includes("carrito-movil.png")));
    assert.equal(info.contador, "2");
  });

  test("en el panel de una entregable, los chips son pequeños (sin el estilo de la página Entregables)", async () => {
    await n.ir(`${o.B}/?proyecto=${p.id}#t=${e.id}`, 1800);
    const altos = await n.ev(`[...document.querySelectorAll("#dMeta .chip")].map((c) => Math.round(c.getBoundingClientRect().height))`);
    assert.ok(altos.length >= 2, JSON.stringify(altos));
    for (const h of altos) assert.ok(h <= 30, `chips: ${JSON.stringify(altos)} px`);
  });

  test("un enlace a un PDF en el resultado se abre en la vista previa, no como texto", async () => {
    const c = await o.api("/api/cards", { title: "Con un PDF", projectId: p.id });
    await o.api(`/api/cards/${c.id}/move`, { column: "doing" });
    await o.mcp("wait_for_work", { worker: IA, timeout_seconds: 3 });
    const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
    await o.mcp("write_file", { card_id: c.id, path: "documentos/muestra.pdf", content: Buffer.from(pdf).toString("base64"), encoding: "base64", worker: IA });
    await o.mcp("submit_result", { id: c.id, result: "**Resumen:** aquí está [el PDF](/files/tienda/documentos/muestra.pdf).", worker: IA });
    await n.ir(`${o.B}/?proyecto=${p.id}#t=${c.id}`, 1800);
    await n.ev(`document.querySelector('#dTabs [data-tab="resultado"]')?.click()`);
    await esperar(400);
    await n.ev(`document.querySelector('#drawer a[href="/files/tienda/documentos/muestra.pdf"]').click()`);
    await esperar(800);
    const src = await n.ev(`document.querySelector("iframe.vista-pdf")?.getAttribute("src") || ""`);
    assert.match(src, /^\/vista\/.+\/tienda\/documentos\/muestra\.pdf$/);
    const r = await fetch(o.B + src);
    assert.equal(r.headers.get("content-type"), "application/pdf");
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
