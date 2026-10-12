// En un teléfono (390 px): las secciones y los controles de la IA y la pausa se ven sin deslizar; las columnas vacías ocupan poco.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, abrirNavegador, arrancarOrbita } from "./navegador.mjs";

describe("móvil", { skip: SIN_CHROME }, () => {
  let o, n, m;
  before(async () => {
    o = await arrancarOrbita();
    const p = await o.proyecto("Web de la marca");
    for (const title of ["Diseñar el logo", "Elegir tipografía"]) {
      const c = await o.api("/api/cards", { title, projectId: p.id });
      await o.api(`/api/cards/${c.id}/move`, { column: "done" });
    }
    await o.api("/api/cards", { title: "Página de inicio", projectId: p.id });
    n = await abrirNavegador({ ancho: 390, alto: 844, movil: true });
    await n.ir(`${o.B}/?proyecto=${p.id}`, 2500);
    m = await n.ev(`(() => { const nav = document.querySelector("#subnav"); const fuera = (e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; };
      return { secciones: [...nav.querySelectorAll(".sub")].filter(fuera).length, total: nav.querySelectorAll(".sub").length, controles: [...nav.querySelectorAll(".pp-btn")].filter(fuera).length, desliza: nav.scrollWidth > nav.clientWidth + 1, scrollPagina: document.documentElement.scrollWidth > innerWidth + 1,
        vacias: [...document.querySelectorAll(".col.empty")].map((c) => Math.round(c.getBoundingClientRect().height)) }; })()`);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("las 4 secciones caben sin deslizar", () => {
    assert.equal(m.total, 4);
    assert.equal(m.secciones, 0);
    assert.equal(m.desliza, false);
  });
  test("la IA del proyecto y la pausa se ven", () => assert.equal(m.controles, 0));
  test("la página no tiene scroll horizontal", () => assert.equal(m.scrollPagina, false));
  test("una columna vacía ocupa poco alto", () => {
    assert.equal(m.vacias.length, 2);
    for (const h of m.vacias) assert.ok(h < 110, `${h} px`);
  });
  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
