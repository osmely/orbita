// Lo que hace Claude Code llega a la tarjeta por sus hooks http: actividad en vivo, lista de tareas y cuándo te espera.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SIN_CHROME, abrirNavegador, arrancarOrbita, esperar } from "./navegador.mjs";

describe("Claude en vivo (hooks)", { skip: SIN_CHROME }, () => {
  let o, n, p, dir, c;
  const IA = "Claude · web";
  // Como lo manda Claude Code: POST con el JSON del evento, sin Origin
  const evento = async (e, sesion = "s1") => {
    const r = await fetch(`${o.B}/api/claude/evento`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sesion, transcript_path: "/tmp/x.jsonl", cwd: dir, permission_mode: "default", ...e }) });
    return { status: r.status, cuerpo: r.status === 200 ? await r.json() : null };
  };
  const t = (k) => `toolu_${k}`;
  before(async () => {
    o = await arrancarOrbita();
    dir = o.carpeta("Web");
    p = await o.api("/api/projects", { name: "Web", dir });
    c = await o.api("/api/cards", { title: "Formulario de contacto", projectId: p.id });
    n = await abrirNavegador({ ancho: 1400, alto: 1000 });
  });
  after(async () => {
    await n?.cerrar();
    await o?.parar();
  });

  test("sin tarjeta en curso, el evento se ignora (204)", async () => {
    assert.equal((await evento({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t0" })).status, 204);
    assert.equal((await o.tarjeta(c.id)).claude, undefined);
  });

  test("los eventos llegan a la tarjeta en curso: actividad, fallos, tareas y rutas relativas", async () => {
    await o.api(`/api/cards/${c.id}/move`, { column: "doing" });
    await o.mcp("wait_for_work", { worker: IA, timeout_seconds: 3 });
    await o.mcp("report_progress", { id: c.id, step: "Empezando", percent: 5, worker: IA });
    await evento({ hook_event_name: "UserPromptSubmit", prompt: "Haz el formulario de contacto con validación" });
    await evento({ hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_use_id: t(1), tool_input: { todos: [{ content: "Leer la página actual", status: "completed" }, { content: "Crear el formulario", status: "in_progress" }, { content: "Validar y probar", status: "pending" }] } });
    await evento({ hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_use_id: t(1), tool_input: {}, duration_ms: 3 });
    await evento({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: t(2), tool_input: { file_path: `${dir}/src/pages/contacto.astro` } });
    await evento({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: t(2), tool_input: {}, duration_ms: 12 });
    await evento({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: t(5), tool_input: { command: "npm test -- contacto" } });
    await evento({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: t(5), tool_input: {}, error: "Exit code 1\n✖ valida el email", is_interrupt: false, duration_ms: 2300 });
    await evento({ hook_event_name: "PreToolUse", tool_name: "mcp__orbita__report_progress", tool_use_id: t(6), tool_input: {} });
    await evento({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: t(7), tool_input: { command: "npm run build", description: "Compila la web" } });
    const card = await o.tarjeta(c.id);
    const act = card.claude?.actividad || [];
    assert.ok(act.length >= 5, `${act.length} entradas`);
    assert.equal(act.find((a) => a.id === t(2))?.estado, "ok");
    assert.equal(act.find((a) => a.id === t(2))?.ms, 12);
    assert.equal(act.find((a) => a.id === t(5))?.estado, "error");
    assert.ok(!act.some((a) => /report_progress/.test(a.texto || "")), "lo que hace con Órbita no se repite");
    assert.ok(act.some((a) => a.texto === "src/pages/contacto.astro"));
    assert.equal(card.claude.todos.length, 3);
  });

  test("el panel muestra «Claude ahora» y la tarjeta lo que corre ahora", async () => {
    await n.ir(`${o.B}/?proyecto=${p.id}#t=${c.id}`, 1800);
    assert.ok((await n.ev(`!document.querySelector("#dClaudeWrap").hidden && document.querySelectorAll("#dClaudeFeed li").length`)) >= 4);
    assert.ok(await n.ev(`document.querySelector('.card[data-id="${c.id}"] .meta-claude')?.textContent.includes("npm run build")`));
  });

  test("se actualiza sin recargar al terminar el comando y el turno", async () => {
    await evento({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: t(7), tool_input: {}, duration_ms: 5400 });
    await evento({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "He creado el formulario. **Falla** la prueba del email." });
    await esperar(900);
    assert.ok(await n.ev(`document.querySelector("#dClaudeFeed").textContent.includes("5.4 s") && document.querySelector("#dClaudeFeed").textContent.includes("Falla")`));
  });

  test("permiso pendiente: la tarjeta queda «esperando permiso» y se marca en el tablero", async () => {
    await evento({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    assert.equal((await o.tarjeta(c.id)).claude?.espera?.tipo, "permiso");
    await esperar(800);
    assert.ok(await n.ev(`document.querySelector('.card[data-id="${c.id}"]').classList.contains("te-espera")`));
    await evento({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: t(8), tool_input: { command: "ls" } });
    assert.ok(!(await o.tarjeta(c.id)).claude?.espera, "al volver a moverse, deja de esperar");
  });

  test("fin de turno con la tarjeta en curso: Órbita le pide no parar (y no hay bucle)", async () => {
    const s1 = await evento({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "¿Stripe o PayPal?" });
    assert.equal(s1.status, 200);
    assert.equal(s1.cuerpo?.decision, "block");
    assert.match(s1.cuerpo.reason, /ask_human/);
    const s2 = await evento({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Espero tu respuesta." });
    assert.equal(s2.status, 204);
    assert.equal((await o.tarjeta(c.id)).claude?.espera?.tipo, "parado");
    assert.equal((await evento({ hook_event_name: "Stop", stop_hook_active: false }, "ajena")).status, 204, "una sesión que no usa Órbita no recibe «no pares»");
  });

  test("/api/claude/hooks da el bloque para copiar", async () => {
    const cfg = await o.api("/api/claude/hooks");
    assert.equal(Object.keys(cfg.configuracion.hooks).length, 7);
    assert.equal(cfg.configuracion.hooks.PreToolUse[0].hooks[0].type, "http");
  });

  test("sin errores de JavaScript", () => assert.deepEqual(n.errores, []));
});
