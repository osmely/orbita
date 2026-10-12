// Órbita · Estado, utilidades, API, conexión en vivo y barra de arriba.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { corto, elegirFiltro, proyectoPorDefecto, refrescarCola, renderAll, renderSeccion, renderSubnav, renderTabs, upsert } from "./tablero.js";
import { renderCounts, restaurarPapelera } from "./paginas.js";
import { closeDrawer, updateDrawer } from "./panel.js";
import { actualizarPendientes, dlg } from "./acciones.js";
import { pintarIAProyecto, pintarPlantillas } from "./extras.js";

// Órbita — interfaz del tablero. Todo el estado vive en el servidor; aquí
// solo pintamos lo que llega por /api/events.
export const state = { cards: new Map(), projects: [], files: [], brains: [], openId: null, view: "card", mcpUrl: "", filtro: leerFiltro(), seccion: "tablero" };

// Proyecto que se está viendo (su id). Siempre hay uno si existe alguno. Se recuerda entre visitas.
export function leerFiltro() {
  try {
    return localStorage.getItem("orbita.filtro") || "";
  } catch {
    return "";
  }
}
export function guardarFiltro() {
  try {
    localStorage.setItem("orbita.filtro", state.filtro);
  } catch {}
}
export function proyecto(id) {
  return state.projects.find((p) => p.id === id);
}
// Color estable por proyecto
export const TONOS = [262, 190, 330, 145, 30, 210, 0, 95];
export function tono(id) {
  return TONOS[[...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TONOS.length];
}
export function visible(c) {
  return !c.archivedAt && (state.filtro === "todos" || (state.filtro === "sin" ? !c.projectId : c.projectId === state.filtro));
}
export function $(sel, el = document) {
  return el.querySelector(sel);
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function md(s) {
  return window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || "")) : `<pre>${esc(s)}</pre>`;
}

export const STATUS = {
  idle: null,
  queued: ["Esperando a una IA", "agent"],
  running: ["Trabajando", "agent"],
  waiting: ["Te pregunta", "warn"],
  returned: ["Devuelta con comentarios", "warn"],
  ready: ["Listo para revisar", "ok"],
  done: ["Hecha", "ok"],
};
export const LIVE = ["queued", "running", "returned"];
// En pantallas estrechas el texto de ayuda del objetivo no cabe entero
export const ayudaObjetivo = matchMedia("(max-width: 600px)");
// La barra de arriba: un objetivo que la IA divide en tarjetas
export function ponerAyuda() {
  $("#goalInput").placeholder = ayudaObjetivo.matches ? "Escribe un objetivo…" : "Un objetivo grande: la IA lo divide en tareas  ( / )";
}



export function fileIcon(f) {
  return /\.(png|jpe?g|gif|webp)$/i.test(f) ? "▣" : "✎";
}
export const LOG_ICON = { note: "✎", start: "▶", step: "◆", file: "✎", spawn: "✚", ask: "?", you: "✋", done: "✓", stop: "■" };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export function toast(msg, isErr = false, boton = null) {
  const t = $("#toast");
  t.textContent = msg;
  if (boton) {
    const b = document.createElement("button");
    b.textContent = boton.texto;
    b.onclick = () => {
      t.className = "toast";
      boton.accion();
    };
    t.append(" ", b);
  }
  t.className = "toast on" + (isErr ? " err" : "") + (boton ? " con-boton" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), boton ? 7000 : 3600);
}

export async function load() {
  const data = await api("/api/board");
  state.cards = new Map(data.cards.map((c) => [c.id, c]));
  state.projects = data.projects || [];
  state.faltantes = data.faltantes || [];
  state.plantillas = data.plantillas || [];
  state.papelera = data.papelera || [];
  state.version ??= data.version; // la versión con la que se cargó esta página
  const pedido = new URLSearchParams(location.search).get("proyecto"); // enlace directo: ?proyecto=<id>
  if (pedido) state.filtro = pedido;
  if (!proyecto(state.filtro)) state.filtro = proyectoPorDefecto();
  state.files = data.files;
  state.brains = data.brains;
  state.mcpUrl = data.mcpUrl;
  state.vista = data.vista; // /vista/<clave>/: sin la clave, el servidor no sirve la vista previa
  renderAll();
  renderBrains();
  actualizarPendientes();
}

export function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "hello" && ev.version && state.version && ev.version !== state.version) return versionNueva();
    if (ev.type === "cerrada") return orbitaCerrada();
    if (ev.type === "card") upsert(ev.card);
    else if (ev.type === "remove") {
      setTimeout(actualizarPendientes);
      state.cards.delete(ev.id);
      $(`.card[data-id="${ev.id}"]`)?.remove();
      if (state.openId === ev.id) closeDrawer();
      renderCounts();
    } else if (ev.type === "files") {
      state.files = ev.files;
      renderSubnav();
      if (state.seccion === "entregables") renderSeccion();
    } else if (ev.type === "papelera") {
      state.papelera = ev.papelera;
      // Si la borró una IA, se avisa con «Deshacer»
      if (ev.borrada) toast(`🗑 ${ev.borrada.por} borró «${corto(ev.borrada.title, 50)}»`, false, { texto: "Deshacer", accion: () => restaurarPapelera(ev.borrada.id) });
      if (state.seccion === "archivo") renderSeccion();
      renderSubnav();
    } else if (ev.type === "plantillas") {
      state.plantillas = ev.plantillas;
      if (dlg.open) pintarPlantillas();
    } else if (ev.type === "projects") {
      state.projects = ev.projects;
      state.faltantes = ev.faltantes || [];
      if (!proyecto(state.filtro)) state.filtro = proyectoPorDefecto(); // lo eliminaron (o es el primero que se crea)
      if (state.seccion === "tablero") renderAll();
      else {
        renderTabs();
        renderSubnav();
        renderSeccion(); // sin redibujar lo que estás escribiendo
      }
      refrescarAvisoPanel();
    } else if (ev.type === "enfoque") {
      enfocarProyecto(ev);
    } else if (ev.type === "brains") {
      state.brains = ev.brains;
      renderBrains();
      renderSubnav();
      if (state.view === "ia") pintarIAProyecto();
      refrescarAvisoPanel();
    }
  };
  es.onerror = () => {
    es.close();
    if (!state.cerrada) setTimeout(() => load().then(connect).catch(connect), 1500);
  };
}

// Cerrar Órbita del todo (el servidor). Abierta como app no hay Terminal donde pulsar Ctrl+C.
export async function cerrarOrbita() {
  const trabajando = [...state.cards.values()].filter((c) => c.status === "running" && !c.archivedAt).length;
  if (!confirm(`¿Cerrar Órbita?${trabajando ? ` La IA está trabajando en ${trabajando} tarjeta${trabajando === 1 ? "" : "s"}: no podrá entregar hasta que vuelvas a abrirla.` : ""} Todo queda guardado.`)) return;
  await api("/api/salir", {}).catch(() => {});
  orbitaCerrada();
}
export function orbitaCerrada() {
  if (state.cerrada) return;
  state.cerrada = true;
  window.close(); // la ventana de app que abrió Órbita se puede cerrar sola; una pestaña normal, no
  document.body.innerHTML = `<div class="bienvenida cerrada"><div class="orb grande" aria-hidden="true"><i></i></div><h2>Órbita está cerrada</h2><p>Todo quedó guardado. Ya puedes cerrar esta ventana; para volver, abre Órbita otra vez.</p><div class="actions"><button class="btn" id="reabrir">Volver a conectar</button></div></div>`;
  $("#reabrir").onclick = () => location.reload();
}

// Carpeta de trabajo de un proyecto: el diálogo nativo del sistema (lo abre el servidor, que corre en esta
// máquina). Si el sistema no tiene selector, se pide la ruta escrita. Devuelve la ruta, o null si se cancela.
export async function elegirCarpeta(titulo) {
  toast("Elige la carpeta en la ventana del sistema…");
  const { dir, sinSelector } = await api("/api/carpeta/elegir", { titulo });
  $("#toast").className = "toast";
  if (dir) return dir;
  if (!sinSelector) return null;
  return prompt(`${titulo}\n\nEscribe la ruta completa de la carpeta:`)?.trim() || null;
}
// Proyecto nuevo (o el que ya haya en esa carpeta)
export async function crearProyecto(nombre) {
  const dir = await elegirCarpeta(nombre ? `Carpeta de trabajo de «${nombre}»` : "Carpeta de trabajo del proyecto");
  if (!dir) return null;
  const p = await api("/api/projects", { name: nombre || "", dir });
  state.projects = [...state.projects.filter((x) => x.id !== p.id), p];
  toast(p.abierto ? `Proyecto «${p.name}» abierto desde su carpeta` : `Proyecto «${p.name}» creado en ${p.dir}`);
  return p;
}

// Una IA abrió un proyecto desde su chat (open_project): el tablero salta a él solo.
// Si estás escribiendo algo, no se te cambia la pantalla: solo se avisa, con «Ir».
export function enfocarProyecto(ev) {
  const p = proyecto(ev.projectId);
  if (!p) return;
  const texto = `◉ ${ev.por} ${ev.creado ? "abrió el proyecto" : "se conectó a"} «${corto(p.name, 40)}» y está escuchando`;
  const activo = document.activeElement;
  const escribiendo = /INPUT|TEXTAREA|SELECT/.test(activo?.tagName) && activo.value;
  if (escribiendo || $("#newDialog").open) return toast(texto, false, { texto: "Ir", accion: () => irAProyecto(p.id) });
  irAProyecto(p.id);
  toast(texto);
}
export function irAProyecto(id) {
  if (state.openId || state.view !== "card") closeDrawer();
  state.seccion = "tablero";
  elegirFiltro(id);
}

// Órbita se reinició con una interfaz nueva: recargar (sin perder lo que estés escribiendo)
export function versionNueva() {
  const escribiendo = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.value;
  if (!escribiendo) return location.reload();
  if ($("#updateBanner")) return;
  const b = document.createElement("div");
  b.id = "updateBanner";
  b.className = "update-banner";
  b.innerHTML = `✨ Hay una versión nueva de Órbita. <button>Recargar</button>`;
  b.querySelector("button").onclick = () => location.reload();
  document.body.append(b);
}

export function hasBrain() {
  return state.brains.length > 0;
}

// La tarjeta abierta dice si ninguna IA puede tomarla: cambia al conectarse una IA o al reanudar el proyecto
function refrescarAvisoPanel() {
  const c = state.openId && state.cards.get(state.openId);
  if (c) updateDrawer(c);
}
export function renderBrains() {
  const el = $("#brainStat");
  const listening = state.brains.filter((b) => b.listening);
  const names = (listening.length ? listening : state.brains).map((b) => b.name);
  el.classList.toggle("on", names.length > 0);
  el.classList.toggle("listening", listening.length > 0);
  $("#brainLabel").textContent = names.length > 2 ? `${names.length} IAs conectadas` : names.length ? `${names.join(" y ")} ${listening.length ? "escuchando" : "conectada"}` : "Conectar IA";
  el.title = names.length ? "IA conectada como cerebro del tablero" : "Ninguna IA conectada: pulsa para ver cómo conectar una";
  refrescarCola();
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
  ayudaObjetivo.addEventListener("change", ponerAyuda);
  ponerAyuda();
}
