// Lo que hace Claude Code, en vivo en la tarjeta. Si la persona añade a sus ajustes de Claude Code los hooks
// «http» que le muestra Órbita (ver configuracionHooks), cada evento llega aquí: antes y después de cada
// herramienta (un comando, un archivo leído o editado, una búsqueda…), cuando espera un permiso, cuando recibe una
// instrucción y cuando termina su turno, con lo que dijo. Se asigna a la tarjeta que se está trabajando en la
// carpeta de esa sesión (cwd). Órbita no lee ni cambia la configuración de Claude Code: solo recibe.
//
//   card.claude = { actividad: [{ t, tipo, texto, icono?, id?, estado?, ms?, error? }], todos: [{ texto, estado }], ultimo, sesion }
import path from "node:path";
import { board, findProject, touch } from "./estado.mjs";

const MAX = 150; // entradas que guarda cada tarjeta
const TRABAJANDO = ["running", "returned", "waiting"];
const corto = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// La tarjeta en curso de esta sesión: la del proyecto cuya carpeta contiene (o es) la carpeta de la sesión
const sesiones = new Map(); // session_id → id de la tarjeta (para desempatar)
function tarjetaDe(ev) {
  const cwd = path.resolve(String(ev.cwd || ""));
  const candidatas = board.cards.filter((c) => {
    if (!TRABAJANDO.includes(c.status) || c.archivedAt) return false;
    const dir = findProject(c.projectId)?.dir;
    return dir && (cwd === dir || cwd.startsWith(dir + path.sep));
  });
  if (!candidatas.length) return null;
  const anterior = candidatas.find((c) => c.id === sesiones.get(ev.session_id));
  const card = anterior || candidatas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  sesiones.set(ev.session_id, card.id);
  return card;
}

// Una línea legible por herramienta: «$ npm test», «✎ server.mjs», «🔎 «readJson» en server.mjs»…
function resumen(nombre, input = {}, cwd = "") {
  const rel = (f) => (f ? (cwd && String(f).startsWith(cwd + "/") ? String(f).slice(cwd.length + 1) : String(f)) : "");
  switch (nombre) {
    case "Bash":
      return { icono: "$", texto: corto(input.command, 200), nota: corto(input.description, 120) };
    case "Read":
      return { icono: "👁", texto: rel(input.file_path) };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { icono: "✎", texto: rel(input.file_path || input.notebook_path), nota: nombre === "Write" ? "escribe" : "edita" };
    case "Grep":
      return { icono: "🔎", texto: `«${corto(input.pattern, 80)}»${input.path ? ` en ${rel(input.path)}` : ""}` };
    case "Glob":
      return { icono: "🔎", texto: corto(input.pattern, 120) };
    case "WebSearch":
      return { icono: "🌐", texto: corto(input.query, 160) };
    case "WebFetch":
      return { icono: "🌐", texto: corto(input.url, 160) };
    case "Task":
    case "Agent":
      return { icono: "🤖", texto: corto(input.description || input.prompt, 160), nota: "subagente" };
    case "TodoWrite":
      return { icono: "☑", texto: "Actualiza su lista de tareas" };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(nombre);
      return { icono: "🧩", texto: mcp ? `${mcp[2]} (${mcp[1]})` : String(nombre || "herramienta") };
    }
  }
}

const IGNORAR = /^mcp__orbita__/; // lo que hace con Órbita ya se ve en la tarjeta

// Recibe un evento de los hooks de Claude Code y lo apunta en la tarjeta que toca. Devuelve su id (o null).
export function registrarEvento(ev) {
  const card = tarjetaDe(ev);
  if (!card) return null;
  const cl = (card.claude ??= { actividad: [], todos: [], ultimo: 0 });
  const ahora = Date.now();
  const añadir = (e) => cl.actividad.push({ t: ahora, ...e });
  const cwd = String(ev.cwd || "");
  switch (ev.hook_event_name) {
    case "PreToolUse": {
      if (IGNORAR.test(ev.tool_name)) return card.id;
      if (ev.tool_name === "TodoWrite" && Array.isArray(ev.tool_input?.todos))
        cl.todos = ev.tool_input.todos.slice(0, 50).map((x) => ({ texto: corto(x.content || x.activeForm, 200), estado: x.status }));
      const r = resumen(ev.tool_name, ev.tool_input, cwd);
      añadir({ tipo: "herramienta", herramienta: ev.tool_name, icono: r.icono, texto: r.texto, nota: r.nota, id: ev.tool_use_id, estado: "corriendo" });
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (IGNORAR.test(ev.tool_name)) return card.id;
      const fallo = ev.hook_event_name === "PostToolUseFailure";
      const fin = { estado: fallo ? (ev.is_interrupt ? "interrumpida" : "error") : "ok", ms: ev.duration_ms, error: fallo ? corto(String(ev.error || "").split("\n")[0], 200) : undefined };
      const e = [...cl.actividad].reverse().find((a) => a.tipo === "herramienta" && (ev.tool_use_id ? a.id === ev.tool_use_id : a.herramienta === ev.tool_name && a.estado === "corriendo"));
      if (e) Object.assign(e, fin);
      else {
        const r = resumen(ev.tool_name, ev.tool_input, cwd);
        añadir({ tipo: "herramienta", herramienta: ev.tool_name, icono: r.icono, texto: r.texto, nota: r.nota, id: ev.tool_use_id, ...fin });
      }
      break;
    }
    case "Notification":
      añadir({ tipo: ev.notification_type === "permission_prompt" ? "permiso" : "aviso", texto: corto(ev.message || ev.title, 300) });
      break;
    case "UserPromptSubmit":
      añadir({ tipo: "instruccion", texto: corto(String(ev.prompt || "").replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, "[texto pegado]"), 300) });
      break;
    case "Stop":
    case "SubagentStop":
      if (ev.last_assistant_message) añadir({ tipo: "dice", texto: corto(ev.last_assistant_message, 4000) });
      añadir({ tipo: "fin", texto: ev.hook_event_name === "SubagentStop" ? "Un subagente terminó" : "Claude terminó su turno" });
      for (const a of cl.actividad) if (a.estado === "corriendo") a.estado = "ok"; // lo que quedó sin cerrar
      break;
    default:
      return card.id;
  }
  if (cl.actividad.length > MAX) cl.actividad.splice(0, cl.actividad.length - MAX);
  cl.ultimo = ahora;
  cl.sesion = ev.session_id;
  touch(card);
  return card.id;
}

// El bloque de hooks que la persona puede añadir a sus ajustes de Claude Code (Órbita solo lo muestra)
export const EVENTOS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit", "Stop", "SubagentStop"];
export const configuracionHooks = (url) => ({ hooks: Object.fromEntries(EVENTOS.map((e) => [e, [{ matcher: "*", hooks: [{ type: "http", url, timeout: 3 }] }]])) });

// La última vez que llegó un evento de Claude a alguna tarjeta (para saber si está conectado)
export const ultimoEvento = () => Math.max(0, ...board.cards.map((c) => c.claude?.ultimo || 0)) || null;
