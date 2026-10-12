// Lo que escribe la IA se pinta saneado: un resultado con HTML malicioso no ejecuta nada, y el Markdown normal se ve completo.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

const MALO = [
  `<img src=x onerror="window.__xss=1">`,
  `<a href="javascript:window.__xss=2">enlace malo</a>`,
  `<svg><script>window.__xss=3</script></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror="window.__xss=4">`,
  `<form><math><mtext></form><form><mglyph><style></math><img src onerror="window.__xss=5">`,
  `<iframe srcdoc="<script>parent.__xss=6</script>"></iframe>`,
  `<div style="background:url(javascript:window.__xss=7)">x</div>`,
  `<noscript><p title="</noscript><img src=x onerror=window.__xss=8>">`,
].join("\n\n");
const MUESTRA = `**Resumen:** prueba de *Markdown* con \`código\`, [enlace](https://example.com) y ~~tachado~~.

## Tabla
| Col A | Col B |
|---|:-:|
| 1 | dos |

\`\`\`js
const x = 1 < 2 && "<b>";
\`\`\`

- [x] hecha
- [ ] pendiente

> cita

Autolink https://example.org`;

describe("Markdown saneado", { skip: SIN_CHROME }, () => {
  let o, n, p, mala, buena;
  const entregada = async (title, result) => {
    const c = await o.api("/api/cards", { title, projectId: p.id });
    await o.api(`/api/cards/${c.id}/move`, { column: "doing" });
    await o.mcp("wait_for_work", { worker: "IA prueba", timeout_seconds: 2 });
    await o.mcp("report_progress", { id: c.id, step: "x", worker: "IA prueba", detalle: result });
    await o.mcp("submit_result", { id: c.id, result, worker: "IA prueba" });
    return c;
  };
  before(async () => {
    o = await arrancarOrbita();
    p = await o.proyecto("Seguridad");
    mala = await entregada("Resultado malicioso", "Resumen: prueba.\n\n" + MALO);
    buena = await entregada("Resultado normal", MUESTRA);
    n = await abrirNavegador();
    await n.ir(`${o.B}/?proyecto=${p.id}`, 2500);
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("cargan DOMPurify y marked", async () => {
    const v = await n.ev(`({ purify: typeof window.DOMPurify?.sanitize, marked: typeof window.marked?.parse })`);
    assert.deepEqual(v, { purify: "function", marked: "function" });
  });

  test("un resultado con HTML malicioso no ejecuta nada (resultado, conversación y en vivo)", async () => {
    await n.ev(`document.querySelector('.card[data-id="${mala.id}"]').click()`);
    await esperar(800);
    for (const t of ["resultado", "chat", "vivo"]) {
      await n.ev(`document.querySelector('#dTabs [data-tab="${t}"]')?.click()`);
      await esperar(400);
    }
    await esperar(600);
    const r = await n.ev(`({ xss: window.__xss ?? null, on: [...document.querySelectorAll("#drawer *")].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length, js: [...document.querySelectorAll("#drawer [href], #drawer [src]")].filter((e) => /^\\s*javascript:/i.test(e.getAttribute("href") || e.getAttribute("src") || "")).length, scripts: document.querySelectorAll("#drawer script, #drawer iframe").length })`);
    assert.deepEqual(r, { xss: null, on: 0, js: 0, scripts: 0 });
  });

  test("el Markdown normal se ve completo", async () => {
    await n.ev(`document.querySelector("#dClose")?.click()`);
    await esperar(300);
    await n.ev(`document.querySelector('.card[data-id="${buena.id}"]').click()`);
    await esperar(800);
    await n.ev(`document.querySelector('#dTabs [data-tab="resultado"]')?.click()`);
    await esperar(500);
    const r = await n.ev(`(() => { const d = document.querySelector('#drawer [data-panel="resultado"]'); return { tabla: d.querySelectorAll("table td").length >= 2, codigo: !!d.querySelector("pre code"), tareas: d.querySelectorAll("input[type=checkbox]").length, cita: !!d.querySelector("blockquote"), enlaces: d.querySelectorAll("a[href^='https']").length >= 2, tachado: !!d.querySelector("del"), titulo: !!d.querySelector("h2") }; })()`);
    assert.deepEqual(r, { tabla: true, codigo: true, tareas: 2, cita: true, enlaces: true, tachado: true, titulo: true });
  });

  // Las imágenes rotas del ataque (src=x) dan 404, que no es un error de JavaScript
  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
