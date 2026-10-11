// Órbita — interfaz del tablero. Todo el estado vive en el servidor; aquí
// solo pintamos lo que llega por /api/events.
const state = { cards: new Map(), projects: [], files: [], brains: [], openId: null, view: "card", mcpUrl: "", filtro: leerFiltro(), seccion: "tablero" };

// Proyecto que se está viendo (su id). Siempre hay uno si existe alguno. Se recuerda entre visitas.
function leerFiltro() {
  try {
    return localStorage.getItem("orbita.filtro") || "";
  } catch {
    return "";
  }
}
function guardarFiltro() {
  try {
    localStorage.setItem("orbita.filtro", state.filtro);
  } catch {}
}
const proyecto = (id) => state.projects.find((p) => p.id === id);
// Color estable por proyecto
const TONOS = [262, 190, 330, 145, 30, 210, 0, 95];
const tono = (id) => TONOS[[...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TONOS.length];
const visible = (c) => !c.archivedAt && (state.filtro === "todos" || (state.filtro === "sin" ? !c.projectId : c.projectId === state.filtro));
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (s) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || "")) : `<pre>${esc(s)}</pre>`);

const STATUS = {
  idle: null,
  queued: ["Esperando a una IA", "agent"],
  running: ["Trabajando", "agent"],
  waiting: ["Te pregunta", "warn"],
  returned: ["Devuelta con comentarios", "warn"],
  ready: ["Listo para revisar", "ok"],
  done: ["Hecha", "ok"],
};
const LIVE = ["queued", "running", "returned"];
// En pantallas estrechas el texto de ayuda del objetivo no cabe entero
const ayudaObjetivo = matchMedia("(max-width: 600px)");
// La barra de arriba: planificar un objetivo o hacer una pregunta rápida
let modoBarra = (() => {
  try {
    return localStorage.getItem("orbita.modo") === "preguntar" ? "preguntar" : "planificar";
  } catch {
    return "planificar";
  }
})();
const ponerAyuda = () => {
  const corto = ayudaObjetivo.matches;
  $("#goalInput").placeholder =
    modoBarra === "preguntar"
      ? corto ? "Pregunta algo…" : "Pregunta algo a la IA: te responde aquí mismo, sin crear tarjeta  ( / )"
      : corto ? "Escribe un objetivo…" : "Un objetivo grande: la IA lo divide en tareas  ( / )";
  $("#goalBtn span").textContent = modoBarra === "preguntar" ? "Preguntar" : "Planificar";
  for (const b of document.querySelectorAll(".modo [data-modo]")) {
    b.classList.toggle("on", b.dataset.modo === modoBarra);
    b.setAttribute("aria-checked", String(b.dataset.modo === modoBarra));
  }
  $("#goalForm").classList.toggle("preguntando", modoBarra === "preguntar");
};
for (const b of document.querySelectorAll(".modo [data-modo]"))
  b.onclick = () => {
    modoBarra = b.dataset.modo;
    try {
      localStorage.setItem("orbita.modo", modoBarra);
    } catch {}
    ponerAyuda();
    $("#goalInput").focus();
  };
ayudaObjetivo.addEventListener("change", ponerAyuda);
ponerAyuda();

const fileIcon = (f) => (/\.(png|jpe?g|gif|webp)$/i.test(f) ? "▣" : "✎");
const LOG_ICON = { note: "✎", start: "▶", step: "◆", file: "✎", spawn: "✚", ask: "?", you: "✋", done: "✓", stop: "■" };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, isErr = false, boton = null) {
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

async function load() {
  const data = await api("/api/board");
  state.cards = new Map(data.cards.map((c) => [c.id, c]));
  state.projects = data.projects || [];
  state.faltantes = data.faltantes || [];
  state.questions = data.questions || [];
  state.preguntasIA = data.preguntasIA || null;
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
  pintarContadorPreguntas();
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "hello" && ev.version && state.version && ev.version !== state.version) return versionNueva();
    if (ev.type === "cerrada") return orbitaCerrada();
    if (ev.type === "card") upsert(ev.card);
    else if (ev.type === "remove") {
      setTimeout(actualizarPendientes);
      state.cards.delete(ev.id);
      invalidarIndice();
      $(`.card[data-id="${ev.id}"]`)?.remove();
      if (state.openId === ev.id) closeDrawer();
      renderCounts();
    } else if (ev.type === "files") {
      state.files = ev.files;
      invalidarIndice();
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
    } else if (ev.type === "preguntasIA") {
      state.preguntasIA = ev.ia;
      if (state.view === "preguntas") renderPreguntas();
    } else if (ev.type === "questions") {
      const antes = new Map((state.questions || []).map((q) => [q.id, q.status]));
      state.questions = ev.questions;
      invalidarIndice();
      for (const q of ev.questions) if (q.status === "respondida" && antes.get(q.id) && antes.get(q.id) !== "respondida") avisarRespuesta(q);
      pintarContadorPreguntas();
      if (state.view === "preguntas") renderPreguntas();
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
    } else if (ev.type === "enfoque") {
      enfocarProyecto(ev);
    } else if (ev.type === "brains") {
      state.brains = ev.brains;
      renderBrains();
      renderSubnav();
      if (state.view === "ia") pintarIAProyecto();
      if (state.view === "preguntas") renderPreguntas();
    }
  };
  es.onerror = () => {
    es.close();
    if (!state.cerrada) setTimeout(() => load().then(connect).catch(connect), 1500);
  };
}

// Cerrar Órbita del todo (el servidor). Abierta como app no hay Terminal donde pulsar Ctrl+C.
async function cerrarOrbita() {
  const trabajando = [...state.cards.values()].filter((c) => c.status === "running" && !c.archivedAt).length;
  if (!confirm(`¿Cerrar Órbita?${trabajando ? ` La IA está trabajando en ${trabajando} tarjeta${trabajando === 1 ? "" : "s"}: no podrá entregar hasta que vuelvas a abrirla.` : ""} Todo queda guardado.`)) return;
  await api("/api/salir", {}).catch(() => {});
  orbitaCerrada();
}
function orbitaCerrada() {
  if (state.cerrada) return;
  state.cerrada = true;
  window.close(); // la ventana de app que abrió Órbita se puede cerrar sola; una pestaña normal, no
  document.body.innerHTML = `<div class="bienvenida cerrada"><div class="orb grande" aria-hidden="true"><i></i></div><h2>Órbita está cerrada</h2><p>Todo quedó guardado. Ya puedes cerrar esta ventana; para volver, abre Órbita otra vez.</p><div class="actions"><button class="btn" id="reabrir">Volver a conectar</button></div></div>`;
  $("#reabrir").onclick = () => location.reload();
}

// Carpeta de trabajo de un proyecto: el diálogo nativo del sistema (lo abre el servidor, que corre en esta
// máquina). Si el sistema no tiene selector, se pide la ruta escrita. Devuelve la ruta, o null si se cancela.
async function elegirCarpeta(titulo) {
  toast("Elige la carpeta en la ventana del sistema…");
  const { dir, sinSelector } = await api("/api/carpeta/elegir", { titulo });
  $("#toast").className = "toast";
  if (dir) return dir;
  if (!sinSelector) return null;
  return prompt(`${titulo}\n\nEscribe la ruta completa de la carpeta:`)?.trim() || null;
}
// Proyecto nuevo (o el que ya haya en esa carpeta)
async function crearProyecto(nombre) {
  const dir = await elegirCarpeta(nombre ? `Carpeta de trabajo de «${nombre}»` : "Carpeta de trabajo del proyecto");
  if (!dir) return null;
  const p = await api("/api/projects", { name: nombre || "", dir });
  state.projects = [...state.projects.filter((x) => x.id !== p.id), p];
  toast(p.abierto ? `Proyecto «${p.name}» abierto desde su carpeta` : `Proyecto «${p.name}» creado en ${p.dir}`);
  return p;
}

// Una IA abrió un proyecto desde su chat (open_project): el tablero salta a él solo.
// Si estás escribiendo algo, no se te cambia la pantalla: solo se avisa, con «Ir».
function enfocarProyecto(ev) {
  const p = proyecto(ev.projectId);
  if (!p) return;
  const texto = `◉ ${ev.por} ${ev.creado ? "abrió el proyecto" : "se conectó a"} «${corto(p.name, 40)}» y está escuchando`;
  const activo = document.activeElement;
  const escribiendo = /INPUT|TEXTAREA|SELECT/.test(activo?.tagName) && activo.value;
  if (escribiendo || $("#newDialog").open) return toast(texto, false, { texto: "Ir", accion: () => irAProyecto(p.id) });
  irAProyecto(p.id);
  toast(texto);
}
function irAProyecto(id) {
  if (state.openId || state.view !== "card") closeDrawer();
  state.seccion = "tablero";
  elegirFiltro(id);
}

// Órbita se reinició con una interfaz nueva: recargar (sin perder lo que estés escribiendo)
function versionNueva() {
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

const hasBrain = () => state.brains.length > 0;

function renderBrains() {
  const el = $("#brainStat");
  const listening = state.brains.filter((b) => b.listening);
  const names = (listening.length ? listening : state.brains).map((b) => b.name);
  el.classList.toggle("on", names.length > 0);
  el.classList.toggle("listening", listening.length > 0);
  $("#brainLabel").textContent = names.length > 2 ? `${names.length} IAs conectadas` : names.length ? `${names.join(" y ")} ${listening.length ? "escuchando" : "conectada"}` : "Conectar IA";
  el.title = names.length ? "IA conectada como cerebro del tablero" : "Ninguna IA conectada: pulsa para ver cómo conectar una";
  refrescarCola();
}

// ---------------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------------

function renderAll() {
  for (const col of document.querySelectorAll(".col")) $(".drop", col).innerHTML = "";
  for (const card of [...state.cards.values()].sort((a, b) => a.order - b.order)) placeCard(card);
  renderTabs();
  renderSubnav();
  renderSeccion();
  renderCounts();
  if (state.openId && state.cards.has(state.openId)) updateDrawer(state.cards.get(state.openId));
}

function upsert(card) {
  invalidarIndice();
  const antes = state.cards.get(card.id);
  state.cards.set(card.id, card);
  // ¿Necesita tu atención? La IA entregó o te pregunta algo
  if (antes && antes.status !== card.status && !card.archivedAt) {
    if (card.status === "ready") avisar(card, "entrega");
    else if (card.status === "waiting") avisar(card, "pregunta");
  }
  actualizarPendientes();
  placeCard(card);
  refrescarCola();
  renderTabs();
  renderSubnav();
  if (state.seccion === "archivo" || state.seccion === "ajustes") renderSeccion();
  renderCounts();
  if (state.openId === card.id && state.view === "card") updateDrawer(card);
}

function placeCard(card) {
  let el = $(`.card[data-id="${card.id}"]`);
  if (!visible(card)) return el?.remove(); // de otro proyecto, o archivada
  const drop = $(`.col[data-col="${card.column}"] .drop`);
  if (!el) {
    el = document.createElement("article");
    el.dataset.id = card.id;
    el.draggable = true;
    el.addEventListener("click", () => openDrawer(card.id));
    el.addEventListener("dragstart", (e) => {
      document.documentElement.style.setProperty("--alto-arrastre", el.offsetHeight + "px"); // el hueco, del alto de la tarjeta
      e.dataTransfer.setData("text/plain", card.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      quitarLinea();
    });
  }
  // En su sitio según el orden de la columna
  const siguiente = [...drop.children].find((x) => x !== el && x.dataset.id && (state.cards.get(x.dataset.id)?.order ?? 0) > card.order);
  if (el.parentElement !== drop || el.nextElementSibling !== (siguiente || null)) {
    const cambiaDeColumna = el.parentElement && el.parentElement !== drop;
    drop.insertBefore(el, siguiente || null);
    if (cambiaDeColumna) {
      el.style.animation = "none";
      el.offsetHeight;
      el.style.animation = "";
    }
  }
  el.className = `card ${card.status}`;
  el.innerHTML = cardHTML(card);
  ajustarEtiquetas(el);
}

// Si una etiqueta no cabe, se quitan palabras enteras (nunca se corta a mitad de palabra)
function ajustarEtiquetas(raiz) {
  for (const chip of raiz.querySelectorAll("[data-completo]")) {
    const palabras = chip.dataset.completo.split(/\s+/);
    let n = palabras.length;
    const icono = chip.textContent.trim().charAt(0) + " ";
    chip.textContent = icono + chip.dataset.completo;
    while (chip.scrollWidth > chip.clientWidth && n > 1) chip.textContent = icono + palabras.slice(0, --n).join(" ").replace(/[,.;:–-]+$/, "") + "…";
  }
}
let esperaAjuste;
addEventListener("resize", () => {
  clearTimeout(esperaAjuste);
  esperaAjuste = setTimeout(() => ajustarEtiquetas(document), 120);
});

// Corta un texto por palabra completa: "planifica una app tipo calculadora…"
function corto(texto, max = 26) {
  if (texto.length <= max) return texto;
  const recorte = texto.slice(0, max + 1);
  const espacio = recorte.lastIndexOf(" ");
  return (espacio > max * 0.5 ? recorte.slice(0, espacio) : texto.slice(0, max)).replace(/[\s,.;:–-]+$/, "") + "…";
}

// "lleva 3 min" / "hace 12 s"
function duracion(desde) {
  const s = Math.max(0, Math.round((Date.now() - desde) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// Posición en la cola, en el mismo orden en que wait_for_work entrega las tarjetas
// Tarjetas a las que todavía espera (las que no están en Hecho)
const pendientesDe = (c) => (c.dependsOn || []).map((id) => state.cards.get(id)).filter((d) => d && d.column !== "done");

const pausado = (c) => !!proyecto(c.projectId)?.pausado;
function enCola(c) {
  const cola = [...state.cards.values()].filter((x) => x.status === "queued" && !x.archivedAt && !pausado(x) && !pendientesDe(x).length).sort((a, b) => a.order - b.order); // el orden de la columna es la prioridad
  return { pos: cola.findIndex((x) => x.id === c.id) + 1, total: cola.length };
}
function textoCola(c) {
  const faltan = pendientesDe(c);
  if (faltan.length) return `🔒 Espera a ${faltan.map((d) => `«${d.title}»`).join(" y ")}`;
  if (pausado(c)) {
    // ¿La IA que la tenía ya se enteró? Solo se entera en su siguiente llamada a Órbita
    if (c.revocada && !c.revocada.avisada) return `⏸ Avisando a ${c.revocada.worker}: parará en su próxima acción`;
    if (c.pausada && c.revocada?.avisada) return `⏸ En pausa · ${c.revocada.worker} se detuvo ✓`;
    return "⏸ En pausa · proyecto pausado";
  }
  const { pos, total } = enCola(c);
  const suya = proyecto(c.projectId)?.ia;
  if (suya) {
    const b = state.brains.find((x) => x.name === suya);
    return `En cola · ${b?.listening ? `la tomará ${suya}` : b ? `${suya} está con otra tarjeta` : `esperando a ${suya} (no está conectada)`}`;
  }
  const escuchando = state.brains.filter((b) => b.listening).map((b) => b.name);
  const quien = escuchando.length ? `la tomará ${escuchando.join(" o ")}` : state.brains.length ? `${state.brains[0].name} está con otra tarjeta` : "esperando a que se conecte una IA";
  return `En cola · ${pos}.ª de ${total} · ${quien}`;
}

// Estados que la columna ya explica: no hace falta etiqueta
const OBVIO = { backlog: ["idle"], doing: ["queued", "running", "returned"], review: ["ready", "waiting"], done: ["done"] };
const PASOS = ["step", "file", "web", "spawn", "ask", "you"];

function cardHTML(c) {
  const s = STATUS[c.status];
  const chips = [];
  if (c.kind === "plan") chips.push(`<span class="chip plan">🎯 objetivo</span>`);
  const p = proyecto(c.projectId);
  if (p && state.filtro === "todos") chips.push(`<span class="chip proj" style="--h:${tono(p.id)}" title="Proyecto: ${esc(p.name)}" data-completo="${esc(p.name)}">● ${esc(corto(p.name, 40))}</span>`);
  else if (!p && c.tag && c.kind !== "plan") chips.push(`<span class="chip plan" title="Objetivo: ${esc(c.tag)}" data-completo="${esc(c.tag)}">✦ ${esc(corto(c.tag, 40))}</span>`);
  if (c.worker) {
    const titulo = c.origin === "ia" ? `La creó la IA y la trabaja ${c.worker}` : `La trabaja ${c.worker}`;
    chips.push(`<span class="chip ext" title="${esc(titulo)}">${c.origin === "ia" ? "✚ " : ""}🧠 ${esc(c.worker)}</span>`);
  } else if (c.origin === "ia") chips.push(`<span class="chip agent" title="La creó la IA">✚ creada por la IA</span>`);
  if (s && !(OBVIO[c.column] || []).includes(c.status)) chips.push(`<span class="chip ${s[1]}">${s[0]}</span>`);
  const faltan = pendientesDe(c);
  if (faltan.length && c.column !== "done") chips.push(`<span class="chip lock" title="Espera a: ${esc(faltan.map((d) => d.title).join(", "))}">🔒 espera a ${faltan.length}</span>`);
  if (c.versions?.length > 1) chips.push(`<span class="chip" title="${c.versions.length} versiones: ${c.versions.length - 1} vuelta${c.versions.length > 2 ? "s" : ""} de revisión">↻ ${c.versions.length}</span>`);
  if (c.programa) chips.push(`<span class="chip prog" title="Próxima: ${esc(fechaProg(c.programa.proxima))}">${c.programa.tipo === "una" ? "⏰" : "🔁"} ${esc(resumenPrograma(c.programa))}</span>`);
  if (c.origin === "programada") chips.push(`<span class="chip prog" title="La creó una tarea programada">🔁 programada</span>`);
  const cr = c.criterios || [];
  if (cr.length) {
    const revisados = cr.filter((x) => x.estado);
    const si = cr.filter((x) => x.estado === "cumple").length;
    const marcados = cr.filter((x) => x.falla).length;
    const lista = cr.map((x) => `${x.estado === "cumple" ? "✓" : x.estado === "no" ? "✗" : "○"} ${x.texto}`).join("\n");
    if (marcados) chips.push(`<span class="chip crit mal" title="${esc(lista)}">✗ ${marcados} no se cumple${marcados > 1 ? "n" : ""}</span>`);
    else if (revisados.length) chips.push(`<span class="chip crit ${si === cr.length ? "bien" : "medio"}" title="${esc(lista)}">${si}/${cr.length} ✓</span>`);
    else chips.push(`<span class="chip crit" title="${esc(lista)}">☐ ${cr.length} criterio${cr.length > 1 ? "s" : ""}</span>`);
  }
  if (c.attachments?.length) chips.push(`<span class="chip adj" title="${c.attachments.length} archivo${c.attachments.length > 1 ? "s" : ""} adjuntado${c.attachments.length > 1 ? "s" : ""} por ti">📎 ${c.attachments.length}</span>`);
  if (c.files?.length) chips.push(`<span class="chip" title="${c.files.length} archivo${c.files.length > 1 ? "s" : ""} de la IA">✎ ${c.files.length}</span>`);

  let live = "";
  if (LIVE.includes(c.status)) {
    const trabajando = c.status === "running";
    const pasos = trabajando ? (c.log || []).filter((l) => PASOS.includes(l.kind) && l.t >= (c.startedAt || 0)).slice(-3) : [];
    const linea = c.status === "queued" ? textoCola(c) : c.step || "Pensando…";
    live = `<div class="live">
      <div class="bar"><i style="width:${Math.max(c.status === "queued" ? 0 : 4, c.progress)}%"></i></div>
      <div class="step">${trabajando ? '<i class="spinner"></i>' : ""}<span>${esc(linea)}</span></div>
      ${trabajando ? `<div class="meta-live"><span>${c.progress} %</span>${c.startedAt ? `<span>lleva <b class="since" data-since="${c.startedAt}">${duracion(c.startedAt)}</b></span>` : ""}${c.live ? "<span>📝 avance en vivo</span>" : ""}</div>` : ""}
      ${pasos.length > 1 ? `<ol class="mini-pasos">${pasos.slice(0, -1).reverse().map((p) => `<li>${esc(p.text)}</li>`).join("")}</ol>` : ""}
    </div>`;
  }
  const question = c.status === "waiting" ? `<div class="question">❓ ${esc(c.question)}</div>` : "";
  const preview = c.status === "ready" && c.result ? `<div class="preview">${esc(c.result.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[#*_`>|-]/g, "").slice(0, 260))}</div>` : "";
  const desc = c.description && !preview && !question && !live ? `<div class="desc">${esc(c.description)}</div>` : "";

  return `<h3>${esc(c.title)}</h3>${desc}${live}${question}${preview}${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}`;
}

// El tiempo que lleva cada tarjeta avanza solo
setInterval(() => {
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = duracion(Number(el.dataset.since));
}, 1000);

// La posición en la cola cambia cuando se mueve cualquier otra tarjeta
function refrescarCola() {
  for (const c of state.cards.values()) if (c.status === "queued" || c.dependsOn?.length) placeCard(c); // también las que esperan a otras
}

// ---------------------------------------------------------------------------
// Pestañas de proyecto (como en el navegador) y lo que hay dentro de cada una
// ---------------------------------------------------------------------------

// Pestañas cerradas (cerrar no borra el proyecto: se reabre con ＋)
const cerradas = new Set(leerLista("orbita.pestanasCerradas"));
function leerLista(clave) {
  try {
    return JSON.parse(localStorage.getItem(clave) || "[]");
  } catch {
    return [];
  }
}
function guardarCerradas() {
  try {
    localStorage.setItem("orbita.pestanasCerradas", JSON.stringify([...cerradas]));
  } catch {}
}

const deFiltro = (f, c) => (f === "todos" ? true : f === "sin" ? !c.projectId : c.projectId === f);

function renderTabs() {
  const vivas = [...state.cards.values()].filter((c) => !c.archivedAt);
  const cuantas = (f) => vivas.filter((c) => deFiltro(f, c)).length;
  const pendientes = (f) => vivas.filter((c) => deFiltro(f, c) && (c.status === "ready" || c.status === "waiting")).length;
  const abiertas = state.projects.filter((p) => !cerradas.has(p.id) || p.id === state.filtro);
  const pestanas = [
    ...abiertas.map((p) => ({ id: p.id, nombre: p.name, h: tono(p.id), cerrable: true, pausado: p.pausado })),
  ];
  $("#tabs").innerHTML = pestanas
    .map(
      (t) => `<div class="tab ${state.filtro === t.id ? "on" : ""}${t.pausado ? " pausada" : ""}" role="tab" tabindex="0" aria-selected="${state.filtro === t.id}" data-f="${esc(t.id)}" title="${esc(t.nombre)}${t.pausado ? " · en pausa: la IA no toma sus tarjetas" : ""}${t.cerrable ? " · doble clic para renombrar" : ""}">
        ${t.pausado ? `<span class="tab-pausa" aria-label="En pausa">⏸</span>` : t.h != null ? `<i class="tab-dot" style="--h:${t.h}"></i>` : `<span class="tab-ico">${t.icono}</span>`}
        <span class="tab-name">${esc(t.nombre)}</span>
        ${pendientes(t.id) ? `<b class="tab-badge" title="Esperan tu revisión">${pendientes(t.id)}</b>` : `<small class="tab-count">${cuantas(t.id) || ""}</small>`}
        ${t.cerrable ? `<button class="tab-close" data-cerrar="${esc(t.id)}" title="Cerrar pestaña (el proyecto no se borra)" aria-label="Cerrar pestaña">✕</button>` : ""}
      </div>`,
    )
    .join("");
  for (const t of document.querySelectorAll("#tabs .tab")) {
    // Ojo: un on* que devuelve false cancela el evento; por eso cuerpos con llaves y sin devolver nada
    t.onclick = (e) => {
      if (!e.target.closest(".tab-close")) elegirFiltro(t.dataset.f);
    };
    t.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      elegirFiltro(t.dataset.f);
    };
    if (proyecto(t.dataset.f)) t.ondblclick = () => renombrarEnPestana(t);
  }
  for (const b of document.querySelectorAll("#tabs [data-cerrar]")) b.onclick = () => cerrarPestana(b.dataset.cerrar);
  $("#tabs .tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("#workspace").classList.toggle("pegada", $("#tabs .tab")?.classList.contains("on")); // esquina recta solo bajo la primera pestaña
}

function renombrarEnPestana(t) {
  const p = proyecto(t.dataset.f);
  const nombre = t.querySelector(".tab-name");
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = p.name;
  nombre.replaceWith(input);
  input.focus();
  input.select();
  const terminar = (guardar) => {
    if (guardar && input.value.trim() && input.value.trim() !== p.name) api(`/api/projects/${p.id}/edit`, { name: input.value.trim() }).catch((err) => toast(err.message, true));
    renderTabs();
  };
  input.onkeydown = (e) => (e.key === "Enter" ? terminar(true) : e.key === "Escape" ? terminar(false) : null);
  input.onblur = () => terminar(true);
}

// Sin pestaña «Todos»: siempre se ve un proyecto. El primero con la pestaña abierta (o cualquiera).
function proyectoPorDefecto(excepto = null) {
  const otros = state.projects.filter((p) => p.id !== excepto);
  return (otros.find((p) => !cerradas.has(p.id)) || otros[0])?.id || "";
}

function cerrarPestana(id) {
  if (state.filtro === id) {
    // Se pasa a la pestaña de al lado; la última abierta no se cierra (no habría nada que mostrar)
    const abiertas = state.projects.filter((p) => !cerradas.has(p.id) || p.id === id);
    const i = abiertas.findIndex((p) => p.id === id);
    const vecina = abiertas[i + 1] || abiertas[i - 1];
    if (!vecina) return toast("Es la única pestaña abierta: abre otro proyecto con ＋ antes de cerrarla", true);
    cerradas.add(id);
    guardarCerradas();
    elegirFiltro(vecina.id);
  } else {
    cerradas.add(id);
    guardarCerradas();
    renderTabs();
  }
  toast(`Pestaña cerrada. «${proyecto(id)?.name}» sigue intacto: ábrela de nuevo con ＋`);
}

function elegirFiltro(f) {
  state.filtro = f;
  if (cerradas.delete(f)) guardarCerradas(); // abrir un proyecto reabre su pestaña
  if (state.seccion !== "tablero" && !SECCIONES(f).some((x) => x[0] === state.seccion)) state.seccion = "tablero";
  guardarFiltro();
  renderAll();
}

// Menú ＋: proyecto nuevo o reabrir una pestaña cerrada
$("#tabNew").onclick = (e) => {
  e.stopPropagation();
  const menu = $("#tabMenu");
  const cerrados = state.projects.filter((p) => cerradas.has(p.id) && p.id !== state.filtro);
  menu.innerHTML = `<form id="tabNewForm"><h4>Nuevo proyecto</h4><div class="row-in"><input name="name" placeholder="Nombre (opcional)"><button class="btn primary">Elegir carpeta…</button></div>
    <p class="muted" style="margin:8px 0 0">Cada proyecto vive en su carpeta de trabajo: Órbita guarda su tablero en <code>orbita/</code> dentro de ella. Si la carpeta ya tiene un proyecto de Órbita, se abre ese.</p></form>
    ${cerrados.length ? `<h4 style="margin-top:14px">Reabrir</h4><ul class="reabrir">${cerrados.map((p) => `<li><button data-abrir="${p.id}"><i class="tab-dot" style="--h:${tono(p.id)}"></i>${esc(p.name)}</button></li>`).join("")}</ul>` : ""}`;
  menu.hidden = !menu.hidden;
  // Con muchas pestañas el ＋ queda a la derecha: el menú se abre hacia donde hay sitio
  const aLaDerecha = $("#tabNew").getBoundingClientRect().left > innerWidth / 2;
  menu.style.left = aLaDerecha ? "auto" : "";
  menu.style.right = aLaDerecha ? "0" : "";
  $("#tabNew").setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) menu.querySelector("input").focus();
  $("#tabNewForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      menu.hidden = true;
      const p = await crearProyecto(String(new FormData(ev.target).get("name") || "").trim());
      if (!p) return;
      state.seccion = p.abierto ? "tablero" : "ajustes"; // recién creado: lo primero es contarle a la IA de qué va
      elegirFiltro(p.id);
    } catch (err) {
      toast(err.message, true);
    }
  };
  for (const b of menu.querySelectorAll("[data-abrir]")) b.onclick = () => ((menu.hidden = true), elegirFiltro(b.dataset.abrir));
};
document.addEventListener("click", (e) => {
  if (!$("#tabMenu").hidden && !e.target.closest(".tab-add")) $("#tabMenu").hidden = true;
});

// Secciones dentro de la pestaña
const SECCIONES = (f) =>
  proyecto(f)
    ? [["tablero", "Tablero"], ["ajustes", "Instrucciones y memoria"], ["entidades", "Entidades"], ["conocimiento", "Conocimiento"], ["entregables", "Entregables"], ["archivo", "Archivo"]]
    : [["tablero", "Tablero"], ["entregables", "Entregables"], ["archivo", "Archivo"]];

function archivosDe(f) {
  const p = proyecto(f);
  if (!p) return f === "todos" ? state.files : [];
  return state.files.filter((x) => x.startsWith(p.folder + "/") && !x.startsWith(p.folder + "/conocimiento/") && !x.startsWith(p.folder + "/entidades/"));
}

function renderSubnav() {
  const f = state.filtro;
  const p = proyecto(f);
  const n = {
    conocimiento: p?.knowledge?.length || 0,
    entidades: p?.entidades?.length || 0,
    entregables: archivosDe(f).length,
    archivo: [...state.cards.values()].filter((c) => c.archivedAt && deFiltro(f, c)).length + (state.papelera || []).filter((x) => f === "todos" || (f === "sin" ? !x.projectId : x.projectId === f)).length,
    ajustes: p && (p.instructions || p.memory) ? "●" : 0,
  };
  // Play / pausa: a la derecha de las secciones
  const otrasActivas = state.projects.filter((x) => x.id !== f && !x.pausado).length;
  const estadoIA = (nombre) => {
    const b = state.brains.find((x) => x.name === nombre);
    return !b ? ["off", "no conectada"] : b.listening ? ["on", "escuchando"] : ["trab", b.tarjeta ? `trabajando: ${b.tarjeta}` : "conectada"];
  };
  const botonIA = p
    ? p.ia
      ? `<button class="pp-btn ia-btn" data-pp="ia" title="La IA de este proyecto: ${esc(estadoIA(p.ia)[1])}"><i class="ia-dot ${estadoIA(p.ia)[0]}"></i>🧠 ${esc(corto(p.ia, 28))}</button>`
      : `<button class="pp-btn" data-pp="ia" title="Dale su propia IA para que avance en paralelo a los demás proyectos">🧠 Su propia IA</button>`
    : "";
  const pp = p
    ? `<span class="pp">${botonIA}${p.pausado ? `<button class="pp-btn play" data-pp="reanudar" title="La IA vuelve a tomar sus tarjetas">▶ Reanudar</button>` : `<button class="pp-btn" data-pp="pausar" title="La IA deja de tomar sus tarjetas (lo que lleva se conserva)">⏸ Pausar</button>`}${otrasActivas ? `<button class="pp-btn solo" data-pp="solo" title="Pausa los demás proyectos: la IA trabaja solo en este">▶ Solo este</button>` : ""}</span>`
    : "";
  $("#subnav").innerHTML =
    (p ? SECCIONES(f) : [])
      .map(([id, nombre]) => `<button class="sub ${state.seccion === id ? "on" : ""}" data-s="${id}">${nombre}${n[id] ? ` <b>${n[id]}</b>` : ""}</button>`)
      .join("") + pp;
  for (const b of document.querySelectorAll("#subnav [data-pp]"))
    b.onclick = () => ({ pausar: () => pausarProyecto(f, true), reanudar: () => pausarProyecto(f, false), solo: () => soloEste(f), todos: reanudarTodos, ia: () => openIAProyecto(f) })[b.dataset.pp]();
  // Aviso sobre el tablero de un proyecto en pausa
  let banda = $("#pausaBanda");
  if (!banda) {
    banda = document.createElement("div");
    banda.id = "pausaBanda";
    banda.className = "pausa-banda";
    $("#subnav").after(banda);
  }
  banda.hidden = !p?.pausado;
  if (p?.pausado) {
    const delProyecto = [...state.cards.values()].filter((c) => c.projectId === p.id && !c.archivedAt && c.column === "doing");
    const sinEnterarse = delProyecto.filter((c) => c.revocada && !c.revocada.avisada);
    const quien = [...new Set(sinEnterarse.map((c) => c.revocada.worker))].join(" y ");
    banda.innerHTML = `<span>⏸ <b>${esc(p.name)}</b> está en pausa: la IA no toma sus tarjetas${delProyecto.length ? ` (${delProyecto.length} esperan en «En curso», con todo lo que llevaban)` : ""}.${
      sinEnterarse.length ? ` <b class="avisando">Avisando a ${esc(quien)}: parará en cuanto vuelva a comunicarse con Órbita.</b>` : ""
    }</span><button class="btn mini-btn" id="pausaReanudar">▶ Reanudar</button>`;
    $("#pausaReanudar").onclick = () => pausarProyecto(p.id, false);
  }
  // Proyectos cuya carpeta de trabajo no aparece (se movió, se borró o es un disco desconectado)
  let falta = $("#faltaBanda");
  if (!falta) {
    falta = document.createElement("div");
    falta.id = "faltaBanda";
    falta.className = "pausa-banda falta-banda";
    banda.after(falta);
  }
  const faltan = state.faltantes || [];
  falta.hidden = !faltan.length;
  falta.innerHTML = faltan
    .map((x) => `<div class="falta-fila"><span>⚠ No encuentro la carpeta de <b>${esc(x.name)}</b>: <code>${esc(x.dir)}</code> <small class="muted">(${esc(x.motivo || "")})</small></span><button class="btn mini-btn" data-ubicar="${esc(x.id)}">Buscar carpeta…</button><button class="btn mini-btn" data-quitar-falta="${esc(x.id)}">Quitar de la lista</button></div>`)
    .join("");
  for (const b of falta.querySelectorAll("[data-ubicar]"))
    b.onclick = async () => {
      const x = faltan.find((y) => y.id === b.dataset.ubicar);
      try {
        const dir = await elegirCarpeta(`¿Dónde está ahora «${x.name}»? (la carpeta que contiene orbita/)`);
        if (!dir) return;
        await api(`/api/faltantes/${x.id}/ubicar`, { dir });
        toast(`«${x.name}» vuelve a estar en el tablero`);
        await load(); // trae sus tarjetas
      } catch (err) {
        toast(err.message, true);
      }
    };
  for (const b of falta.querySelectorAll("[data-quitar-falta]"))
    b.onclick = () => {
      const x = faltan.find((y) => y.id === b.dataset.quitarFalta);
      if (confirm(`¿Quitar «${x.name}» de la lista? Su carpeta no se toca: si vuelve a aparecer, ábrela con ＋.`)) api(`/api/faltantes/${x.id}/quitar`, {}).catch((err) => toast(err.message, true));
    };
  for (const b of document.querySelectorAll("#subnav .sub"))
    b.onclick = () => {
      state.seccion = b.dataset.s;
      renderSubnav();
      renderSeccion();
    };
}

function renderSeccion() {
  if (!proyecto(state.filtro)) return bienvenida();
  const enTablero = state.seccion === "tablero";
  $("#board").hidden = !enTablero;
  $("#page").hidden = enTablero;
  if (enTablero) return;
  const pagina = $("#page");
  if (pagina.dataset.vista !== `${state.filtro}:${state.seccion}`) {
    pagina.dataset.vista = `${state.filtro}:${state.seccion}`;
    pagina.innerHTML = "";
  }
  ({ ajustes: paginaAjustes, entidades: paginaEntidades, conocimiento: paginaConocimiento, entregables: paginaEntregables, archivo: paginaArchivo })[state.seccion]?.(pagina);
}

// Sin ningún proyecto todavía: lo primero es crear uno (con su carpeta de trabajo)
function bienvenida() {
  $("#board").hidden = true;
  const pagina = $("#page");
  pagina.hidden = false;
  if (pagina.dataset.vista === "bienvenida") return;
  pagina.dataset.vista = "bienvenida";
  pagina.innerHTML = `<div class="bienvenida">
    <div class="orb grande" aria-hidden="true"><i></i></div>
    <h2>Empieza con un proyecto</h2>
    <p>Cada proyecto vive en una carpeta de tu ordenador: la del código o los documentos con los que va a trabajar la IA. Órbita guarda su tablero en <code>orbita/</code>, dentro de esa carpeta.</p>
    <div class="actions"><button class="btn primary" id="bvCrear">Elegir carpeta…</button><button class="btn" id="bvIA">Conectar una IA</button></div>
    <p class="muted">También puedes pedírselo a tu IA: <i>«Abre en Órbita un proyecto aquí y quédate escuchando»</i>.</p>
  </div>`;
  $("#bvCrear").onclick = async () => {
    try {
      const p = await crearProyecto("");
      if (p) {
        state.seccion = p.abierto ? "tablero" : "ajustes";
        elegirFiltro(p.id);
      }
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#bvIA").onclick = openConnect;
}

// Instrucciones y memoria (y nombre, y eliminar si está vacío)
function paginaAjustes(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".ajustes")) {
    pagina.innerHTML = `<div class="ajustes">
      <p class="intro">Lo que escribas aquí lo recibe la IA con <b>cada tarjeta</b> de este proyecto.</p>
      <label class="campo"><span>Nombre</span><input class="campo-input" data-campo="name"></label>
      <label class="campo"><span>Instrucciones para la IA</span><textarea data-campo="instructions" rows="6" placeholder="Reglas fijas para todas las tarjetas: idioma y tono, tecnología, formato de entrega, qué evitar…"></textarea></label>
      <label class="campo"><span>Memoria <small class="muted" data-memoria-fecha></small></span><textarea data-campo="memory" rows="10" placeholder="Lo que la IA aprende entre tarjetas: decisiones, preferencias, datos. Puedes editarla."></textarea></label>
      <div class="campo"><span>Secretos <small class="muted">claves de API, tokens, contraseñas de servicios…</small></span>
        <ul class="kn-list secretos" data-secretos></ul>
        <form class="secreto-nuevo" data-secreto-form autocomplete="off">
          <input class="campo-input" name="nombre" placeholder="NOMBRE (p. ej. STRIPE_API_KEY)" spellcheck="false" autocapitalize="characters" required>
          <input class="campo-input" name="valor" type="password" placeholder="Valor" autocomplete="new-password" required>
          <button class="btn mini-btn">Guardar</button>
        </form>
        <small class="muted">La IA recibe solo los nombres con cada tarjeta y pide el valor cuando lo necesita (queda en la actividad de la tarjeta). Si lo pega en un resultado o un comentario, el tablero lo tapa. Se guardan en la carpeta de datos de Órbita, solo en este equipo: no van en <code>orbita/</code>, así que no viajan con la carpeta ni acaban en un repositorio. Una vez guardado, el valor no se vuelve a mostrar; para cambiarlo, guárdalo otra vez con el mismo nombre.</small></div>
      <div class="campo"><span>Carpeta de trabajo</span>
        <div class="carpeta-trabajo"><code data-carpeta></code><button type="button" class="btn mini-btn" data-mostrar>Abrir</button><button type="button" class="btn mini-btn" data-cambiar-carpeta>Cambiar…</button></div>
        <small class="muted">La IA trabaja aquí. Órbita guarda el tablero del proyecto y sus entregables en <code>orbita/</code>, dentro de esta carpeta: si la copias o la subes a un repositorio, el proyecto va con ella.</small></div>
      <div class="peligro" data-peligro></div>
    </div>`;
    for (const campo of pagina.querySelectorAll("[data-campo]"))
      campo.onchange = () =>
        api(`/api/projects/${p.id}/edit`, { [campo.dataset.campo]: campo.value })
          .then(() => toast(campo.dataset.campo === "name" ? "Proyecto renombrado" : "Guardado"))
          .catch((err) => toast(err.message, true));
    const form = pagina.querySelector("[data-secreto-form]");
    form.nombre.oninput = () => (form.nombre.value = form.nombre.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nombre = form.nombre.value.trim();
      const habia = (proyecto(state.filtro)?.secretos || []).some((x) => x.nombre === nombre);
      try {
        await api(`/api/projects/${state.filtro}/secretos`, { nombre, valor: form.valor.value });
        form.reset();
        toast(habia ? `Secreto ${nombre} cambiado` : `Secreto ${nombre} guardado`);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  // Secretos: solo nombres y fechas (el valor no sale del servidor)
  const secretos = p.secretos || [];
  pagina.querySelector("[data-secretos]").innerHTML = secretos.length
    ? secretos
        .map((x) => `<li><span class="file"><code>${esc(x.nombre)}</code> <span class="muted">•••••••• · ${esc(new Date(x.t).toLocaleDateString())}</span></span><button type="button" class="btn mini-btn" data-cambiar="${esc(x.nombre)}" title="Escribir un valor nuevo">Cambiar</button><button type="button" class="icon-btn" data-quitar="${esc(x.nombre)}" title="Borrar el secreto">✕</button></li>`)
        .join("")
    : `<li class="muted">Este proyecto aún no tiene secretos.</li>`;
  for (const b of pagina.querySelectorAll("[data-secretos] [data-cambiar]"))
    b.onclick = () => {
      const form = pagina.querySelector("[data-secreto-form]");
      form.nombre.value = b.dataset.cambiar;
      form.valor.focus();
    };
  for (const b of pagina.querySelectorAll("[data-secretos] [data-quitar]"))
    b.onclick = () => {
      if (!confirm(`¿Borrar el secreto ${b.dataset.quitar}? La IA dejará de poder usarlo.`)) return;
      api(`/api/projects/${p.id}/secretos/${encodeURIComponent(b.dataset.quitar)}`, undefined, "DELETE")
        .then(() => toast(`Secreto ${b.dataset.quitar} borrado`))
        .catch((err) => toast(err.message, true));
    };
  // Rellenar sin pisar el campo que estás escribiendo
  for (const campo of pagina.querySelectorAll("[data-campo]")) {
    const valor = p[campo.dataset.campo] || "";
    if (document.activeElement !== campo && campo.value !== valor) {
      const habia = campo.value;
      campo.value = valor;
      if (habia) {
        campo.classList.remove("flash");
        void campo.offsetWidth;
        campo.classList.add("flash");
      }
    }
  }
  pagina.querySelector("[data-memoria-fecha]").textContent = p.memoryAt ? `actualizada ${new Date(p.memoryAt).toLocaleString()}` : "la IA la irá completando";
  pagina.querySelector("[data-carpeta]").textContent = p.dir;
  pagina.querySelector("[data-mostrar]").onclick = () => api(`/api/projects/${p.id}/mostrar`, {}).catch((err) => toast(err.message, true));
  pagina.querySelector("[data-cambiar-carpeta]").onclick = async () => {
    try {
      const dir = await elegirCarpeta(`Nueva carpeta de trabajo de «${p.name}» (su carpeta orbita/ se moverá allí)`);
      if (!dir) return;
      await api(`/api/projects/${p.id}/carpeta`, { dir });
      toast(`«${p.name}» trabaja ahora en ${dir}`);
    } catch (err) {
      toast(err.message, true);
    }
  };
  const tiene = [...state.cards.values()].some((c) => c.projectId === p.id);
  pagina.querySelector("[data-peligro]").innerHTML = tiene
    ? `<p class="muted">Para eliminar el proyecto, primero mueve o elimina sus tarjetas. Si solo quieres quitarlo de la vista, cierra su pestaña (✕).</p>`
    : `<button class="btn danger" data-eliminar>Eliminar proyecto</button> <span class="muted">Está vacío. Sus archivos no se tocan.</span>`;
  pagina.querySelector("[data-eliminar]")?.addEventListener("click", () => {
    if (!confirm(`¿Eliminar el proyecto «${p.name}»?`)) return;
    api(`/api/projects/${p.id}`, undefined, "DELETE")
      .then(() => {
        toast("Proyecto eliminado");
        elegirFiltro(proyectoPorDefecto(p.id));
      })
      .catch((err) => toast(err.message, true));
  });
}

// Entidades: lo que existe en el proyecto y perdura (personajes, armas, objetos, personas, lugares…), como fichas
// agrupadas por categoría. Las va guardando la IA (save_entity) y aquí se ven, se buscan y se editan.
const ICONOS_CATEGORIA = [
  // [cómo se reconoce, icono, tono del color]
  [/personaj|heroe|villan|npc|criatur|enemig|monstru|bestia/, "🧙", 268],
  [/arma/, "⚔️", 0],
  [/objet|item|inventari|equipo|recurso|pocion|artefact/, "🎒", 32],
  [/persona|contact|cliente|usuari|gente|miembro|autor/, "👤", 205],
  [/lugar|mapa|zona|nivel|region|ciudad|escenari|mundo/, "🗺️", 145],
  [/hechiz|magia|habilidad|poder|talento/, "✨", 300],
  [/faccion|grupo|organiz|empresa|clan|gremio|reino/, "🏰", 20],
  [/vehicul|nave|montura/, "🚀", 185],
  [/mision|quest|evento|capitulo|escena/, "📜", 48],
  [/concept|idea|tema|regla/, "💡", 58],
];
const categoriaConocida = (cat) => ICONOS_CATEGORIA.find(([re]) => re.test(sinTildes(cat)));
const iconoCategoria = (cat) => categoriaConocida(cat)?.[1] || "🏷️";
// Un color propio por categoría: el de las habituales, o uno de la paleta según su nombre
const TONOS_CATEGORIA = [268, 205, 145, 32, 330, 185, 0, 95, 48, 300];
const tonoCategoria = (cat) => categoriaConocida(cat)?.[2] ?? TONOS_CATEGORIA[[...sinTildes(cat)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) % TONOS_CATEGORIA.length];
const imagenEntidad = (e) => (e.imagen ? `/files/${e.imagen.split("/").map(encodeURIComponent).join("/")}?v=${e.actualizada?.t || ""}` : "");

function paginaEntidades(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".entidades")) {
    pagina.innerHTML = `<div class="entidades">
      <div class="ent-barra">
        <input class="campo-input" type="search" placeholder="Buscar por nombre, detalles o etiquetas…" data-buscar autocomplete="off">
        <button class="btn primary" data-nueva>＋ Nueva entidad</button>
      </div>
      <div class="ent-cats" data-cats></div>
      <div data-grupos></div>
    </div>`;
    const buscar = pagina.querySelector("[data-buscar]");
    buscar.value = state.entBusca || "";
    buscar.oninput = () => {
      state.entBusca = buscar.value;
      paginaEntidades(pagina);
    };
    pagina.querySelector("[data-nueva]").onclick = () => abrirEntidad(state.filtro, null);
  }
  const todas = p.entidades || [];
  const porCat = new Map();
  for (const e of todas) porCat.set(e.categoria, (porCat.get(e.categoria) || 0) + 1);
  if (state.entCat && !porCat.has(state.entCat)) state.entCat = "";
  const cats = [...porCat.keys()].sort((a, b) => a.localeCompare(b));
  pagina.querySelector("[data-cats]").innerHTML = todas.length
    ? [`<button class="ent-cat ${state.entCat ? "" : "on"}" data-cat="">Todas <b>${todas.length}</b></button>`, ...cats.map((c) => `<button class="ent-cat ${state.entCat === c ? "on" : ""}" data-cat="${esc(c)}" style="--h:${tonoCategoria(c)}">${iconoCategoria(c)} ${esc(c)} <b>${porCat.get(c)}</b></button>`)].join("")
    : "";
  for (const b of pagina.querySelectorAll("[data-cat]"))
    b.onclick = () => {
      state.entCat = b.dataset.cat;
      paginaEntidades(pagina);
    };
  const palabras = sinTildes(state.entBusca || "").split(/\s+/).filter(Boolean);
  const visibles = todas.filter((e) => (!state.entCat || e.categoria === state.entCat) && palabras.every((w) => sinTildes([e.nombre, e.categoria, e.resumen, e.detalles, ...(e.etiquetas || [])].join(" ")).includes(w)));
  const grupos = pagina.querySelector("[data-grupos]");
  if (!todas.length) {
    grupos.innerHTML = `<div class="ent-vacio">
      <div class="ent-vacio-iconos" aria-hidden="true">🧙 ⚔️ 🎒 👤 🗺️</div>
      <h3>Aún no hay entidades</h3>
      <p>Las entidades son lo que existe en el proyecto y conviene recordar: los personajes de un juego, sus armas y objetos, las personas de un informe, los lugares de una historia… Cada una es una ficha con su categoría, resumen, detalles e imagen.</p>
      <p class="muted">La IA las va guardando mientras trabaja. También puedes pedírselo en una tarjeta: <i>«Extrae los personajes, armas y objetos del juego como entidades»</i>, o crearlas tú.</p>
    </div>`;
    return;
  }
  if (!visibles.length) {
    grupos.innerHTML = `<p class="muted ent-nada">Ninguna entidad coincide con la búsqueda.</p>`;
    return;
  }
  const enGrupos = new Map();
  for (const e of visibles.sort((a, b) => a.nombre.localeCompare(b.nombre))) enGrupos.set(e.categoria, [...(enGrupos.get(e.categoria) || []), e]);
  grupos.innerHTML = [...enGrupos.keys()]
    .sort((a, b) => enGrupos.get(b).length - enGrupos.get(a).length || a.localeCompare(b)) // los más numerosos primero
    .map(
      (cat) => `<section class="ent-grupo" style="--h:${tonoCategoria(cat)}">
        <h3><span class="ent-grupo-ico">${iconoCategoria(cat)}</span>${esc(cat)} <b>${enGrupos.get(cat).length}</b></h3>
        <div class="ent-grid">${enGrupos
          .get(cat)
          .map(
            (e) => `<button class="ent-ficha" data-ent="${esc(e.id)}">
              <span class="ent-img ${e.imagen ? "" : "sin"}">${e.imagen ? `<img src="${esc(imagenEntidad(e))}" alt="" loading="lazy">` : `<span class="ent-img-ico">${iconoCategoria(cat)}</span>`}</span>
              <span class="ent-txt"><b>${esc(e.nombre)}</b>${e.resumen ? `<span class="ent-resumen">${esc(e.resumen)}</span>` : ""}${e.etiquetas?.length ? `<span class="ent-tags">${e.etiquetas.slice(0, 4).map((t) => `<i>${esc(t)}</i>`).join("")}</span>` : ""}</span>
            </button>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");
  for (const b of grupos.querySelectorAll("[data-ent]")) b.onclick = () => abrirEntidad(state.filtro, b.dataset.ent);
}

// La ficha de una entidad, en el panel lateral: se edita y se guarda con «Guardar» (id null = nueva)
function abrirEntidad(pid, id) {
  const p = proyecto(pid);
  const e = id ? (p?.entidades || []).find((x) => x.id === id) : null;
  if (!p || (id && !e)) return toast("Esa entidad ya no existe", true);
  state.openId = null;
  state.view = "entidad";
  state.entidadAbierta = { pid, id };
  const cat = e?.categoria || state.entCat || "";
  const cats = [...new Set([...(p.entidades || []).map((x) => x.categoria), "Personajes", "Armas", "Objetos", "Personas", "Lugares"])];
  const cuando = (x) => (x ? `${esc(x.por)}, ${new Date(x.t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "");
  $("#drawerBody").innerHTML = `
    <div class="d-head">
      <textarea class="t" rows="1" id="eNombre" placeholder="Nombre de la entidad" maxlength="120">${esc(e?.nombre || "")}</textarea>
      <button class="icon-btn" id="dClose" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="ent-cabecera">
      <label class="ent-foto" id="eFoto" title="${id ? "Pulsa o arrastra una imagen" : "Guárdala primero para añadirle una imagen"}" style="--h:${tonoCategoria(cat || "x")}">
        ${e?.imagen ? `<img src="${esc(imagenEntidad(e))}" alt="">` : `<span class="ent-img-ico">${iconoCategoria(cat)}</span><small>${id ? "＋ Imagen" : ""}</small>`}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden id="eFotoInput" ${id ? "" : "disabled"}>
      </label>
      <div class="ent-campos">
        <label class="field">Categoría <input id="eCat" list="eCats" value="${esc(cat)}" placeholder="Personajes, Armas, Objetos…" maxlength="40" autocomplete="off"></label>
        <datalist id="eCats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <label class="field">Etiquetas <input id="eTags" value="${esc((e?.etiquetas || []).join(", "))}" placeholder="separadas por comas" autocomplete="off"></label>
      </div>
    </div>
    <label class="campo"><span>Resumen</span><input class="campo-input" id="eResumen" maxlength="500" value="${esc(e?.resumen || "")}" placeholder="Una línea que la describa"></label>
    <div class="d-section">
      <h4>Detalles <button class="mini" id="eEditar" style="margin-left:auto">${e?.detalles ? "Editar" : "Escribir"}</button></h4>
      <div class="result" id="eVista" ${e?.detalles ? "" : "hidden"}>${e?.detalles ? md(e.detalles) : ""}</div>
      <textarea class="d-desc" id="eDetalles" rows="12" hidden placeholder="Todo lo que conviene recordar: atributos, historia, relaciones… (Markdown)">${esc(e?.detalles || "")}</textarea>
    </div>
    ${e ? `<p class="muted ent-meta">Creada por ${cuando(e.creada)}${e.actualizada && e.actualizada.t !== e.creada.t ? ` · actualizada por ${cuando(e.actualizada)}` : ""}</p>` : ""}
    <div class="actions">
      <button class="btn primary" id="eGuardar">${id ? "Guardar" : "Crear entidad"}</button>
      ${e?.imagen ? `<button class="btn" id="eQuitarFoto">Quitar imagen</button>` : ""}
      ${id ? `<button class="btn danger" id="eBorrar">Eliminar</button>` : ""}
    </div>`;
  autosize($("#eNombre"));
  $("#eNombre").addEventListener("input", (ev) => autosize(ev.target));
  $("#dClose").onclick = closeDrawer;
  const detalles = $("#eDetalles");
  if (!id) detalles.hidden = false;
  $("#eEditar").onclick = () => {
    detalles.hidden = !detalles.hidden;
    $("#eVista").hidden = !detalles.hidden || !detalles.value.trim();
    if (detalles.hidden) $("#eVista").innerHTML = md(detalles.value);
    $("#eEditar").textContent = detalles.hidden ? "Editar" : "Vista previa";
    if (!detalles.hidden) detalles.focus();
  };
  $("#eGuardar").onclick = async () => {
    try {
      const guardada = await api(`/api/projects/${pid}/entidades`, { id: id || undefined, categoria: $("#eCat").value, nombre: $("#eNombre").value, resumen: $("#eResumen").value, detalles: detalles.value, etiquetas: $("#eTags").value });
      toast(id ? `«${guardada.nombre}» guardada` : `«${guardada.nombre}» creada en ${guardada.categoria}`);
      if (!id) setTimeout(() => abrirEntidad(pid, guardada.id), 50); // ya puede llevar imagen
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#eBorrar")?.addEventListener("click", () => {
    if (!confirm(`¿Eliminar «${e.nombre}» de ${e.categoria}?`)) return;
    api(`/api/projects/${pid}/entidades/${id}`, undefined, "DELETE")
      .then(() => {
        toast(`«${e.nombre}» eliminada`);
        closeDrawer();
      })
      .catch((err) => toast(err.message, true));
  });
  $("#eQuitarFoto")?.addEventListener("click", () => api(`/api/projects/${pid}/entidades/${id}/imagen`, undefined, "DELETE").then(() => abrirEntidad(pid, id)).catch((err) => toast(err.message, true)));
  if (id) {
    const foto = $("#eFoto");
    const subirFoto = async (archivos) => {
      const f = [...archivos].find((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type));
      if (!f) return toast("La imagen tiene que ser PNG, JPG, GIF o WebP", true);
      await subir(`/api/projects/${pid}/entidades/${id}/imagen`, [f], () => "Imagen actualizada");
      abrirEntidad(pid, id);
    };
    $("#eFotoInput").onchange = (ev) => subirFoto(ev.target.files);
    foto.ondragover = (ev) => (ev.preventDefault(), foto.classList.add("over"));
    foto.ondragleave = () => foto.classList.remove("over");
    foto.ondrop = (ev) => {
      ev.preventDefault();
      foto.classList.remove("over");
      subirFoto(ev.dataTransfer.files);
    };
  }
  showDrawer();
  if (!id) $("#eNombre").focus();
}

// Conocimiento: archivos de referencia que la IA recibe
const tamano = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
function paginaConocimiento(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".conocimiento")) {
    pagina.innerHTML = `<div class="conocimiento">
      <p class="intro">Archivos de referencia para la IA: guías, documentos, datos, imágenes. Los textos pequeños los recibe directamente; el resto los lee cuando los necesita.</p>
      <ul class="kn-list" data-kn></ul>
      <label class="kn-drop">⬆︎ Arrastra archivos aquí o <u>elige archivos</u> <small>(hasta 10 MB cada uno)</small><input type="file" multiple hidden data-subir></label>
    </div>`;
    pagina.querySelector("[data-subir]").onchange = (e) => subirConocimiento(p.id, e.target.files);
    const zona = pagina.querySelector(".kn-drop");
    zona.ondragover = (e) => (e.preventDefault(), zona.classList.add("over"));
    zona.ondragleave = () => zona.classList.remove("over");
    zona.ondrop = (e) => {
      e.preventDefault();
      zona.classList.remove("over");
      subirConocimiento(p.id, e.dataTransfer.files);
    };
  }
  const lista = pagina.querySelector("[data-kn]");
  lista.innerHTML =
    (p.knowledge || [])
      .map((k) => `<li><button class="file" data-f="${esc(k.path)}"><span class="ico">${fileIcon(k.name)}</span>${esc(k.name)}</button><span class="muted">${tamano(k.size)}</span><button class="icon-btn" data-quitar-kn="${esc(k.name)}" title="Quitar">✕</button></li>`)
      .join("") || `<li class="muted">Todavía no hay archivos de conocimiento.</li>`;
  for (const b of lista.querySelectorAll("[data-f]")) b.onclick = () => openFile(b.dataset.f);
  for (const b of lista.querySelectorAll("[data-quitar-kn]"))
    b.onclick = () => confirm(`¿Quitar «${b.dataset.quitarKn}» del conocimiento del proyecto?`) && api(`/api/projects/${p.id}/knowledge/${encodeURIComponent(b.dataset.quitarKn)}`, undefined, "DELETE").catch((err) => toast(err.message, true));
}

const adjuntar = (cardId, archivos) => subir(`/api/cards/${cardId}/attachments`, archivos, (n) => `📎 «${n}» adjuntado`);
const subirConocimiento = (id, archivos) => subir(`/api/projects/${id}/knowledge`, archivos, (n) => `«${n}» añadido al conocimiento`);

async function subir(ruta, archivos, mensaje) {
  for (const f of archivos) {
    if (f.size > 10 * 1024 * 1024) {
      toast(`«${f.name}» pasa de 10 MB`, true);
      continue;
    }
    const data = await new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] || "");
      r.onerror = mal;
      r.readAsDataURL(f);
    });
    try {
      await api(ruta, { name: f.name, data });
      toast(mensaje(f.name));
    } catch (err) {
      toast(err.message, true);
    }
  }
}

// Entregables: lo que escribió la IA en la carpeta del proyecto
function paginaEntregables(pagina) {
  const f = state.filtro;
  const p = proyecto(f);
  const archivos = archivosDe(f);
  const grupos = p ? [[p.folder, archivos]] : [...new Set(archivos.map((x) => (x.includes("/") ? x.split("/")[0] : "")))].map((d) => [d, archivos.filter((x) => (d ? x.startsWith(d + "/") : !x.includes("/")))]);
  pagina.innerHTML = `<p class="intro">${p ? `Lo que escribió la IA para este proyecto, en <code>${esc(p.dir)}/orbita/</code>.` : "Lo que escribió la IA en todos los proyectos."}</p>
    ${
      archivos.length
        ? grupos
            .map(([dir, lista]) => {
              const dueño = state.projects.find((x) => x.folder === dir);
              return `${p ? "" : `<h4 class="grupo">${dueño ? `<i class="tab-dot" style="--h:${tono(dueño.id)}"></i>${esc(dueño.name)}` : dir ? `<code>${esc(dir)}/</code>` : "Sueltos"}</h4>`}<div class="files">${lista.map((x) => `<button class="file" data-f="${esc(x)}"><span class="ico">${fileIcon(x)}</span>${esc(dir ? x.slice(dir.length + 1) : x)}</button>`).join("")}</div>`;
            })
            .join("")
        : `<div class="empty-state">Todavía no hay entregables.</div>`
    }`;
  for (const b of pagina.querySelectorAll("[data-f]")) b.onclick = () => openFile(b.dataset.f);
}

// Archivo: tarjetas archivadas del proyecto, con «Restaurar»
function paginaArchivo(pagina) {
  const archivadas = [...state.cards.values()].filter((c) => c.archivedAt && deFiltro(state.filtro, c)).sort((a, b) => b.archivedAt - a.archivedAt);
  pagina.innerHTML = `<p class="intro">Las tarjetas archivadas no se borran: siguen aquí con su resultado y sus archivos.</p>
    ${
      archivadas.length
        ? `<ul class="archive-list">${archivadas
            .map((c) => `<li>${state.filtro === "todos" && proyecto(c.projectId) ? `<i class="tab-dot" style="--h:${tono(c.projectId)}" title="${esc(proyecto(c.projectId).name)}"></i>` : ""}<button class="link-card" data-open="${c.id}">${esc(c.title)}</button><time>${new Date(c.archivedAt).toLocaleDateString()}</time><button class="btn mini-btn" data-restore="${c.id}">Restaurar</button></li>`)
            .join("")}</ul><div class="actions"><button class="btn" id="restoreAll">Restaurar todas</button></div>`
        : '<div class="empty-state">No hay tarjetas archivadas.</div>'
    }`;
  for (const b of pagina.querySelectorAll("[data-restore]")) b.onclick = () => api(`/api/cards/${b.dataset.restore}/unarchive`, {}).then(() => toast("Restaurada en «Hecho»"));
  for (const b of pagina.querySelectorAll("[data-open]")) b.onclick = () => openDrawer(b.dataset.open);
  pagina.querySelector("#restoreAll")?.addEventListener("click", () => Promise.all(archivadas.map((c) => api(`/api/cards/${c.id}/unarchive`, {}))).then(() => toast("Todas restauradas")));
  // Papelera: lo que borró una IA (30 días)
  const papelera = (state.papelera || []).filter((x) => state.filtro === "todos" || (state.filtro === "sin" ? !x.projectId : x.projectId === state.filtro));
  if (papelera.length) {
    pagina.insertAdjacentHTML(
      "beforeend",
      `<h3 class="papelera-titulo">🗑 Papelera <small>lo que borró una IA · se vacía sola a los 30 días</small></h3>
      <ul class="archive-list papelera">${papelera
        .map((x) => `<li><span class="link-card">${esc(x.title)}</span><span class="muted papelera-por" title="${esc(x.motivo || "")}">${esc(x.por)}${x.motivo ? ` · ${esc(corto(x.motivo, 50))}` : ""}</span><time>${new Date(x.borradaEn).toLocaleDateString()}</time><button class="btn mini-btn" data-restaurar-p="${x.id}">Restaurar</button><button class="icon-btn" data-borrar-p="${x.id}" title="Borrar del todo" aria-label="Borrar del todo">✕</button></li>`)
        .join("")}</ul>`,
    );
    for (const b of pagina.querySelectorAll("[data-restaurar-p]")) b.onclick = () => restaurarPapelera(b.dataset.restaurarP);
    for (const b of pagina.querySelectorAll("[data-borrar-p]"))
      b.onclick = async () => {
        const x = state.papelera.find((y) => y.id === b.dataset.borrarP);
        if (!confirm(`¿Borrar del todo «${x?.title}»? No se podrá recuperar.`)) return;
        await api(`/api/papelera/${b.dataset.borrarP}`, undefined, "DELETE").catch((err) => toast(err.message, true));
      };
  }
}

async function restaurarPapelera(id) {
  try {
    const card = await api(`/api/papelera/${id}/restaurar`, {});
    upsert(card);
    toast(`↶ «${corto(card.title, 50)}» restaurada`);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderCounts() {
  const cards = [...state.cards.values()].filter(visible);
  for (const col of document.querySelectorAll(".col")) {
    const n = cards.filter((c) => c.column === col.dataset.col).length;
    $(".count", col).textContent = n || "";
    col.classList.toggle("empty", n === 0);
  }
  const active = [...state.cards.values()].filter((c) => c.status === "running").length; // en todos los proyectos
  $("#statAgents").textContent = active;
  $("#agentDots").innerHTML = "<i></i>".repeat(Math.min(active, 4));
  const hechas = cards.filter((c) => c.column === "done").length;
  $("#archiveDone").hidden = hechas === 0;
  $("#archiveDone").textContent = `Archivar ${hechas}`;
}

// Archivar lo hecho del proyecto visible (se puede deshacer)
$("#archiveDone").onclick = async () => {
  const ids = [...state.cards.values()].filter((c) => visible(c) && c.column === "done").map((c) => c.id);
  try {
    const { archived } = await api("/api/archive", { ids });
    toast(`🗄 ${archived} tarjeta${archived === 1 ? "" : "s"} archivada${archived === 1 ? "" : "s"}`, false, {
      texto: "Deshacer",
      accion: () => Promise.all(ids.map((id) => api(`/api/cards/${id}/unarchive`, {}))),
    });
  } catch (err) {
    toast(err.message, true);
  }
};

// Arrastrar y soltar entre columnas
// Línea que marca dónde caerá la tarjeta
const linea = document.createElement("div");
linea.className = "drop-line";
const quitarLinea = () => linea.remove();

// Las librerías de Markdown se cargan sin bloquear: cuando llegan, se vuelve a pintar lo abierto con formato
addEventListener("load", () => {
  if (state.openId && state.view === "card" && state.cards.has(state.openId)) {
    $("#dResult").dataset.src = "";
    $("#dLive") && ($("#dLive").dataset.src = "");
    $("#dThread") && ($("#dThread").dataset.firma = "");
    updateDrawer(state.cards.get(state.openId));
  }
});

// Un enlace #t=<id> abre esa tarjeta también si la página ya estaba abierta
addEventListener("hashchange", () => {
  const id = /^#t=(\w+)$/.exec(location.hash)?.[1];
  if (id && state.cards.has(id) && state.openId !== id) openDrawer(id);
});

// Arrastrar archivos desde el ordenador: se adjuntan a la tarjeta sobre la que se sueltan
const arrastraArchivos = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
function marcarParaAdjuntar(card) {
  for (const c of document.querySelectorAll(".card.adjuntar")) if (c !== card) c.classList.remove("adjuntar");
  card?.classList.add("adjuntar");
}
// Un archivo soltado fuera de una zona válida no debe abrirse en la pestaña (te sacaría de Órbita)
document.addEventListener("dragover", (e) => arrastraArchivos(e) && e.preventDefault());
document.addEventListener("drop", (e) => {
  if (!arrastraArchivos(e)) return;
  e.preventDefault();
  marcarParaAdjuntar(null);
});
document.addEventListener("dragleave", (e) => {
  if (arrastraArchivos(e) && !e.relatedTarget) marcarParaAdjuntar(null); // salió de la ventana
});

// La tarjeta antes de la que caería, según la altura del ratón (null = al final)
function tarjetaDebajo(drop, y) {
  return [...drop.querySelectorAll(".card:not(.dragging)")].find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) || null;
}

for (const col of document.querySelectorAll(".col")) {
  const drop = $(".drop", col);
  col.addEventListener("dragenter", (e) => e.preventDefault()); // es un sitio válido donde soltar
  col.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (arrastraArchivos(e)) return marcarParaAdjuntar(e.target.closest(".card")); // archivos: se adjuntan a la tarjeta, no hay hueco
    col.classList.add("over");
    const antesDe = tarjetaDebajo(drop, e.clientY);
    if (linea.parentElement !== drop || linea.nextElementSibling !== antesDe) drop.insertBefore(linea, antesDe); // solo si cambia de sitio
  });
  // El navegador avisa de «salida» al pasar de una tarjeta al fondo (y el hueco mueve las tarjetas bajo el cursor):
  // solo cuenta como salir de la columna si el cursor está de verdad fuera de ella
  col.addEventListener("dragleave", (e) => {
    const r = col.getBoundingClientRect();
    const fuera = e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom;
    if (fuera) {
      col.classList.remove("over");
      if (linea.parentElement === drop) quitarLinea();
    }
  });
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    if (arrastraArchivos(e)) {
      const destino = e.target.closest(".card");
      marcarParaAdjuntar(null);
      if (destino) adjuntar(destino.dataset.id, e.dataTransfer.files);
      else toast("Suelta los archivos sobre una tarjeta para adjuntárselos");
      return;
    }
    col.classList.remove("over");
    const antes = tarjetaDebajo(drop, e.clientY);
    quitarLinea();
    const id = e.dataTransfer.getData("text/plain");
    const card = state.cards.get(id);
    if (!card) return;
    const beforeId = antes?.dataset.id || null;
    const actual = $(`.card[data-id="${id}"]`);
    if (card.column === col.dataset.col && (actual?.nextElementSibling?.dataset?.id || null) === beforeId) return; // no cambia nada
    move(id, col.dataset.col, beforeId);
  });
}

// Subir o bajar una posición (desde el panel: sirve en el móvil y con el teclado)
function desplazar(id, paso) {
  const c = state.cards.get(id);
  const lista = [...state.cards.values()].filter((x) => x.column === c.column && visible(x)).sort((a, b) => a.order - b.order);
  const i = lista.findIndex((x) => x.id === id);
  const destino = i + paso;
  if (destino < 0 || destino >= lista.length) return;
  const beforeId = paso < 0 ? lista[destino].id : lista[destino + 1]?.id || null;
  move(id, c.column, beforeId);
}

async function move(id, column, beforeId) {
  try {
    await api(`/api/cards/${id}/move`, beforeId !== undefined ? { column, beforeId } : { column });
    const antes = state.cards.get(id);
    if (column === "doing" && antes?.column !== "doing") toast(hasBrain() ? "Enviada a la IA ⚡" : "En cola. La tomará la próxima IA que se conecte.");
    if (column === "done") toast("Hecha ✓");
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Panel de detalle
// ---------------------------------------------------------------------------

function openDrawer(id) {
  const card = state.cards.get(id);
  if (!card) return;
  history.replaceState(null, "", "#t=" + id); // enlace directo a la tarjeta
  state.openId = id;
  state.view = "card";
  $("#drawerBody").innerHTML = `
    <!-- Fijo arriba: el título, el estado y lo que se puede decidir. Debajo, cada parte en su pestaña
         (se abre la que toca según el estado: ver pintarPestanas). -->
    <div class="d-head">
      <textarea class="t" rows="1" id="dTitle">${esc(card.title)}</textarea>
      <button class="icon-btn" id="dClose" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="d-meta" id="dMeta"></div>
    <div class="actions card-actions" id="dActions"></div>
    <nav class="d-tabs" id="dTabs" role="tablist" aria-label="Partes de la tarjeta">
      <button role="tab" data-tab="vivo"><i class="live-dot"></i>En vivo</button>
      <button role="tab" data-tab="tarea">Tarea<b data-n="tarea"></b></button>
      <button role="tab" data-tab="chat">Conversación<b data-n="chat"></b></button>
      <button role="tab" data-tab="resultado">Resultado<b data-n="resultado"></b></button>
      <span class="d-tabs-sep"></span>
      <button role="tab" data-tab="ajustes" title="Proyecto, repetir, espera a, adjuntos…">⚙ Ajustes<b data-n="ajustes"></b></button>
      <button role="tab" data-tab="actividad" title="Todo lo que ha pasado con la tarjeta">🕘<b data-n="actividad"></b></button>
    </nav>
    <div class="d-tab" role="tabpanel" data-panel="vivo">
      <div class="d-section live-box" id="dLiveWrap">
        <h4><i class="live-dot"></i>En vivo <span class="live-at" id="dLiveAt"></span></h4>
        <div class="result" id="dLive"></div>
      </div>
    </div>
    <div class="d-tab" role="tabpanel" data-panel="tarea">
      <textarea class="d-desc" id="dDesc" placeholder="Detalles, contexto, cómo sabrás que está bien hecho…">${esc(card.description)}</textarea>
      <div class="d-section crit-box" id="dCrit">
        <h4>✅ Terminado cuando… <span class="crit-res" id="dCritRes"></span></h4>
        <ul class="crit-list" id="dCritList"></ul>
        <form class="crit-add" id="dCritForm"><input id="dCritInput" placeholder="Añadir criterio… la IA los revisará uno a uno al entregar (Enter; pega varios, uno por línea)" autocomplete="off" /><button class="mini">＋</button></form>
      </div>
    </div>
    <div class="d-tab" role="tabpanel" data-panel="chat">
      <div class="d-section chat" id="dChat">
        <ol class="thread" id="dThread"></ol>
        <div class="composer">
          <textarea id="dFeedbackText" rows="2"></textarea>
          <div class="actions" id="dSend"></div>
        </div>
      </div>
    </div>
    <div class="d-tab" role="tabpanel" data-panel="resultado">
      <div class="d-section" id="dResultWrap">
        <h4>Resultado <span class="ver-nav" id="dVer"></span><button class="mini" id="dEditResult">Editar</button></h4>
        <div class="exportar" id="dExport" hidden>
          <button class="mini" data-exp="copiar" title="Copiar el resultado en Markdown">⧉ Copiar</button>
          <button class="mini" data-exp="md" title="Descargar en Markdown, con las imágenes dentro">⤓ .md</button>
          <button class="mini" data-exp="pagina" title="Abrir como página limpia para leer o compartir">↗ Página</button>
          <button class="mini" data-exp="pdf" title="Guardar como PDF (desde el diálogo de imprimir)">⎙ PDF</button>
        </div>
        <div class="ver-aviso" id="dVerAviso" hidden></div>
        <div class="result" id="dResult"></div>
        <textarea class="d-desc" id="dResultEdit" rows="10" hidden placeholder="Escribe el resultado a mano (Markdown)…"></textarea>
      </div>
      <div class="d-section" id="dFilesWrap"><h4>Archivos</h4><div class="files" id="dFiles"></div></div>
      <div class="d-vacio" id="dResultVacio">Todavía no hay resultado. Lo entrega la IA al terminar, o <button class="mini" id="dEscribir">✎ escríbelo tú</button></div>
    </div>
    <div class="d-tab" role="tabpanel" data-panel="ajustes">
      <label class="field d-project">Proyecto <select id="dProject"></select></label>
      <div class="d-herr"><button class="mini" id="dComoPlantilla" title="Guarda título, descripción, criterios y proyecto para crear tarjetas iguales">⧉ Guardar como plantilla</button><form class="pl-guardar" id="dPlForm" hidden><input id="dPlNombre" maxlength="60" autocomplete="off" aria-label="Nombre de la plantilla" /><button class="mini">Guardar</button></form></div>
      <div class="d-section prog-box" id="dProg">
        <h4>🔁 Repetir <span class="prog-prox" id="dProgProx"></span></h4>
        <div class="prog-row">
          <select id="dProgTipo" aria-label="Repetición"><option value="">No se repite</option><option value="una">Una vez, el…</option><option value="diaria">Cada día</option><option value="semanal">Cada semana</option><option value="mensual">Cada mes</option></select>
          <input type="date" id="dProgFecha" hidden aria-label="Fecha" />
          <span class="prog-dias" id="dProgDias" hidden>${["L", "M", "X", "J", "V", "S", "D"].map((l, i) => `<button type="button" class="dia" data-dia="${(i + 1) % 7}" aria-pressed="false">${l}</button>`).join("")}</span>
          <label class="prog-diames" id="dProgDiaMesL" hidden>el día <input type="number" min="1" max="31" id="dProgDiaMes" value="1" /></label>
          <label class="prog-hora" id="dProgHoraL" hidden>a las <input type="time" id="dProgHora" value="09:00" /></label>
        </div>
      </div>
      <div class="d-section deps" id="dDeps"><h4>Espera a</h4><ul class="dep-list" id="dDepList"></ul>
        <label class="field"><select id="dDepAdd"></select></label>
      </div>
      <div class="d-section adjuntos" id="dAdj"><h4>Adjuntos</h4><ul class="kn-list" id="dAdjList"></ul>
        <label class="kn-drop" id="dAdjDrop">📎 Arrastra archivos aquí o <u>elige archivos</u> <small>(la IA los recibe con la tarjeta)</small><input type="file" multiple hidden id="dAdjInput"></label>
      </div>
      <div class="actions" id="dActionsMas"></div>
    </div>
    <div class="d-tab" role="tabpanel" data-panel="actividad">
      <ul class="timeline" id="dLog"></ul>
    </div>
  `;
  for (const b of document.querySelectorAll("#dTabs [data-tab]")) b.onclick = () => mostrarPestana(b.dataset.tab, true);
  $("#dEscribir").onclick = () => action(id, "escribir");
  delete $("#drawerBody").dataset.elegida; // tarjeta nueva en el panel: vuelve a mandar el estado
  delete $("#drawerBody").dataset.pestana;
  delete $("#drawerBody").dataset.toca;
  const edit = (field) => (e) => api(`/api/cards/${id}/edit`, { [field]: e.target.value }).catch((err) => toast(err.message, true));
  autosize($("#dTitle"));
  $("#dTitle").addEventListener("input", (e) => autosize(e.target));
  $("#dTitle").addEventListener("change", edit("title"));
  llenarProyectos($("#dProject"), card.projectId || "");
  $("#dProject").addEventListener("change", (e) => api(`/api/cards/${id}/edit`, { projectId: e.target.value || null }).catch((err) => toast(err.message, true)));
  $("#dDesc").addEventListener("change", edit("description"));
  $("#dResultEdit").addEventListener("change", edit("result"));
  $("#dAdjInput").onchange = (e) => adjuntar(id, e.target.files);
  const zonaAdj = $("#dAdjDrop");
  zonaAdj.ondragover = (e) => (e.preventDefault(), zonaAdj.classList.add("over"));
  zonaAdj.ondragleave = () => zonaAdj.classList.remove("over");
  zonaAdj.ondrop = (e) => {
    e.preventDefault();
    zonaAdj.classList.remove("over");
    adjuntar(id, e.dataTransfer.files);
  };
  $("#dFeedbackText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#dSend .btn")?.click(); // Cmd/Ctrl+Enter envía
  });
  for (const b of document.querySelectorAll("#dExport [data-exp]")) b.onclick = () => exportar(id, b.dataset.exp);
  for (const sel of ["#dProgTipo", "#dProgFecha", "#dProgDiaMes", "#dProgHora"]) $(sel).onchange = () => guardarPrograma(id);
  $("#dComoPlantilla").onclick = () => {
    $("#dComoPlantilla").hidden = true;
    $("#dPlForm").hidden = false;
    $("#dPlNombre").value = state.cards.get(id).title.slice(0, 60);
    $("#dPlNombre").focus();
    $("#dPlNombre").select();
  };
  $("#dPlForm").onsubmit = async (e) => {
    e.preventDefault();
    await guardarComoPlantilla(id, $("#dPlNombre").value.trim());
    $("#dPlForm").hidden = true;
    $("#dComoPlantilla").hidden = false;
  };
  for (const b of document.querySelectorAll("#dProgDias .dia"))
    b.onclick = () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      guardarPrograma(id);
    };
  $("#dCritForm").onsubmit = (e) => {
    e.preventDefault();
    const nuevos = $("#dCritInput").value.split("\n").map((t) => t.trim()).filter(Boolean);
    if (!nuevos.length) return;
    $("#dCritInput").value = "";
    guardarCriterios(id, [...(state.cards.get(id).criterios || []).map((x) => x.texto), ...nuevos]);
  };
  // Pegar varias líneas: un criterio por línea (un <input> se comería los saltos de línea)
  $("#dCritInput").addEventListener("paste", (e) => {
    const lineas = (e.clipboardData?.getData("text") || "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (lineas.length < 2) return;
    e.preventDefault();
    $("#dCritInput").value = "";
    guardarCriterios(id, [...(state.cards.get(id).criterios || []).map((x) => x.texto), ...lineas]);
  });
  state.verVersion = null; // null = la última
  state.verCambios = false;
  $("#dEditResult").onclick = () => {
    const ta = $("#dResultEdit");
    ta.hidden = !ta.hidden;
    $("#dResult").hidden = !ta.hidden || !state.cards.get(id)?.result;
    $("#dEditResult").textContent = ta.hidden ? "Editar" : "Listo";
    if (!ta.hidden) {
      ta.value = state.cards.get(id)?.result || "";
      ta.focus();
    }
  };
  $("#dClose").addEventListener("click", closeDrawer);
  updateDrawer(card);
  $("#drawer").classList.add("on");
  $("#scrim").classList.add("on");
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function updateDrawer(c) {
  const s = STATUS[c.status];
  const col = { backlog: "Ideas", doing: "En curso", review: "Para revisar", done: "Hecho" }[c.column];
  $("#dMeta").innerHTML = [
    `<span class="chip">${col}</span>`,
    s ? `<span class="chip ${s[1]}">${s[0]}</span>` : "",
    c.worker ? `<span class="chip ext">🧠 ${esc(c.worker)}</span>` : "",
    c.status === "running" ? `<span class="chip agent">${c.progress} % · ${esc(c.step)}</span>` : "",
    c.status === "running" && c.startedAt ? `<span class="chip">lleva <span data-since="${c.startedAt}">${duracion(c.startedAt)}</span></span>` : "",
    c.status === "queued" ? `<span class="chip agent">${esc(textoCola(c))}</span>` : "",
    c.inbox?.length ? `<span class="chip warn">${c.inbox.length} mensaje${c.inbox.length > 1 ? "s" : ""} sin leer por la IA</span>` : "",
  ].join("");

  pintarHilo(c);
  pintarDependencias(c);
  pintarCriterios(c);
  pintarPrograma(c);
  $("#dAdjList").innerHTML = (c.attachments || [])
    .map((a) => `<li><button class="file" data-f="${esc(a.path)}"><span class="ico">${fileIcon(a.name)}</span>${esc(a.name)}</button><span class="muted">${tamano(a.size)}</span><button class="icon-btn" data-quitar-adj="${esc(a.name)}" title="Quitar">✕</button></li>`)
    .join("");
  for (const b of document.querySelectorAll("#dAdjList [data-f]")) b.onclick = () => openFile(b.dataset.f);
  for (const b of document.querySelectorAll("#dAdjList [data-quitar-adj]"))
    b.onclick = () => confirm(`¿Quitar el adjunto «${b.dataset.quitarAdj}»?`) && api(`/api/cards/${c.id}/attachments/${encodeURIComponent(b.dataset.quitarAdj)}`, undefined, "DELETE").catch((err) => toast(err.message, true));

  // Avance intermedio de la IA: visible mientras trabaja (y mientras espera tu respuesta)
  const enVivo = Boolean(c.live) && ["running", "returned", "waiting"].includes(c.status);
  $("#dLiveWrap").hidden = !enVivo;
  if (enVivo) {
    const caja = $("#dLive");
    if (caja.dataset.src !== c.live) {
      caja.innerHTML = md(c.live);
      caja.dataset.src = c.live;
      $("#dLiveWrap").classList.remove("flash");
      void $("#dLiveWrap").offsetWidth;
      $("#dLiveWrap").classList.add("flash");
    }
    $("#dLiveAt").innerHTML = c.liveAt ? `actualizado hace <span data-since="${c.liveAt}">${duracion(c.liveAt)}</span>` : "";
  }

  const editing = !$("#dResultEdit").hidden;
  $("#dResultWrap").hidden = !c.result && !editing; // sin resultado, solo el aviso (y «✎ escríbelo tú»)
  $("#dResultVacio").hidden = !$("#dResultWrap").hidden;
  $("#dResult").hidden = editing || !c.result;
  pintarVersiones(c);
  $("#dExport").hidden = !c.result || editing;
  if (!c.result && !editing) $("#dResult").hidden = true;

  $("#dFilesWrap").hidden = !c.files?.length;
  $("#dFiles").innerHTML = (c.files || []).map((f) => `<button class="file" data-f="${esc(f)}"><span class="ico">${fileIcon(f)}</span>${esc(f)}</button>`).join("");
  for (const b of document.querySelectorAll("#dFiles .file")) b.onclick = () => openFile(b.dataset.f);

  // Acciones según el estado
  const acts = [];
  if (c.status === "queued") acts.push(`<button class="btn" data-a="unqueue">Sacar de la cola</button>`);
  else if (c.worker && ["running", "returned"].includes(c.status)) acts.push(`<button class="btn" data-a="unqueue">Quitársela a ${esc(c.worker)}</button>`);
  else {
    if (c.column === "review") acts.push(`<button class="btn go" data-a="approve">✓ Aprobar</button>`);
    if (c.column !== "done" && c.column !== "review") acts.push(`<button class="btn" data-a="approve">Marcar como hecha</button>`);
  }
  if (c.column === "review" && !(c.worker && ["running", "returned", "waiting"].includes(c.status))) acts.push(`<button class="btn" data-a="ir-devolver" title="Contesta a la IA o dile qué cambiar">↩ Responder…</button>`);
  $("#dActions").innerHTML = acts.join("");
  $("#dActions").hidden = !acts.length;
  // Lo de mantenimiento, dentro de «Ajustes»
  const mas = [`<span class="pos"><button class="btn" data-a="up" title="Subir una posición en su columna (Alt+↑)">↑</button><button class="btn" data-a="down" title="Bajar una posición en su columna (Alt+↓)">↓</button></span>`];
  if (c.log?.length) mas.push(`<button class="btn" data-a="reset">Empezar de cero</button>`);
  mas.push(`<button class="btn danger" data-a="delete">Eliminar</button>`);
  $("#dActionsMas").innerHTML = mas.join("");
  for (const b of document.querySelectorAll("#dActions .btn, #dActionsMas .btn")) b.onclick = () => action(c.id, b.dataset.a);
  pintarPestanas(c);

  const log = $("#dLog");
  const items = [...(c.log || [])].reverse();
  log.innerHTML = items.length
    ? items
        .map(
          (l) => `<li class="${l.kind}"><span class="k">${LOG_ICON[l.kind] || "·"}</span><div class="x">${esc(l.text)}<time>${new Date(l.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div></li>`,
        )
        .join("")
    : `<div class="empty-state">Sin actividad todavía.</div>`;
}

// Pestañas del panel. Al abrirlo (o si cambia el estado y no has elegido tú) se muestra la que toca:
// trabajando → En vivo; te pregunta → Conversación; entregada → Resultado; si no, la Tarea.
function pestanaQueToca(c) {
  if (c.status === "waiting") return "chat";
  if (["running", "returned"].includes(c.status)) return "vivo";
  if (c.result && ["review", "done"].includes(c.column)) return "resultado";
  return "tarea";
}
function pintarPestanas(c) {
  const enCurso = ["running", "returned", "waiting"].includes(c.status);
  const pendientes = (c.dependsOn || []).filter((d) => state.cards.get(d)?.column !== "done").length;
  const cr = c.criterios || [];
  const si = cr.filter((x) => x.estado === "cumple").length;
  const n = {
    tarea: cr.length ? (cr.some((x) => x.estado) ? `${si}/${cr.length} ✓` : cr.length) : "",
    chat: c.status === "waiting" ? "?" : c.thread?.length || "",
    resultado: c.versions?.length > 1 ? `v${c.versions.at(-1).n}` : c.result ? "✓" : "",
    ajustes: [pendientes ? `🔒${pendientes}` : "", c.programa ? "🔁" : "", c.attachments?.length ? `📎${c.attachments.length}` : ""].filter(Boolean).join(" "),
    actividad: c.log?.length || "",
  };
  for (const b of document.querySelectorAll("#dTabs [data-n]")) b.textContent = n[b.dataset.n] ?? "";
  $('#dTabs [data-tab="chat"]').classList.toggle("aviso", c.status === "waiting");
  $('#dTabs [data-tab="vivo"]').hidden = !enCurso && !(c.live && c.status === "running");
  const panel = $("#drawerBody");
  const toca = pestanaQueToca(c);
  // Lo que elegiste se respeta; si no elegiste, sigue al estado (p. ej. al entregar pasa a «Resultado»)
  if (!panel.dataset.elegida || panel.dataset.toca !== toca) {
    if (!panel.dataset.elegida || !document.querySelector(`#dTabs [data-tab="${panel.dataset.pestana}"]:not([hidden])`)) mostrarPestana(toca);
    panel.dataset.toca = toca;
  }
  if (!panel.dataset.pestana) mostrarPestana(toca);
}
function mostrarPestana(cual, elegida = false) {
  const panel = $("#drawerBody");
  panel.dataset.pestana = cual;
  if (elegida) panel.dataset.elegida = "1";
  for (const b of document.querySelectorAll("#dTabs [data-tab]")) {
    b.classList.toggle("on", b.dataset.tab === cual);
    b.setAttribute("aria-selected", String(b.dataset.tab === cual));
  }
  for (const p of document.querySelectorAll("#drawerBody [data-panel]")) p.hidden = p.dataset.panel !== cual;
}

async function action(id, a) {
  try {
    if (a === "escribir") {
      mostrarPestana("resultado", true);
      $("#dResultWrap").hidden = false;
      $("#dResultVacio").hidden = true;
      $("#dEditResult").click();
      return;
    }
    if (a === "ir-devolver") {
      mostrarPestana("chat", true);
      $("#dFeedbackText").focus();
      return;
    }
    if (a === "unqueue") await api(`/api/cards/${id}/move`, { column: "backlog" });
    if (a === "up") desplazar(id, -1);
    if (a === "down") desplazar(id, +1);
    if (a === "approve") await move(id, "done");
    if (a === "feedback") {
      const text = $("#dFeedbackText").value;
      if (text.trim()) await feedback(id, text);
      else await move(id, "doing");
    }
    if (a === "answer") await feedback(id, $("#dFeedbackText").value, true);
    if (a === "comment") {
      const text = $("#dFeedbackText").value.trim();
      if (!text) return toast("Escribe tu mensaje", true);
      await api(`/api/cards/${id}/comment`, { text });
      $("#dFeedbackText").value = "";
      const c = state.cards.get(id);
      toast(c?.worker && LIVE.includes(c.status) ? `Enviado: ${c.worker} lo leerá en su próximo paso` : "Anotado en la conversación");
    }
    if (a === "reset" && confirm("¿Borrar el trabajo hecho y volver a Ideas?")) await api(`/api/cards/${id}/reset`, {});
    if (a === "delete" && confirm("¿Eliminar esta tarjeta?")) {
      await api(`/api/cards/${id}`, undefined, "DELETE");
      closeDrawer();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function feedback(id, text, isAnswer = false) {
  try {
    await api(`/api/cards/${id}/feedback`, { text });
    const ta = $("#dFeedbackText");
    if (ta) ta.value = "";
    toast(isAnswer ? "Respuesta enviada a la IA" : "Enviado a la IA: sigue con esta tarjeta");
  } catch (err) {
    toast(err.message, true);
  }
}

function closeDrawer() {
  if ($("#drawer").contains(document.activeElement)) document.activeElement.blur(); // si no, los atajos creen que sigues escribiendo
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  state.openId = null;
  state.view = "card";
  $("#drawer").classList.remove("on");
  $("#scrim").classList.remove("on");
}

function showDrawer() {
  $("#drawer").classList.add("on");
  $("#scrim").classList.add("on");
}

// Versiones del resultado: ‹ Versión 2 de 3 › y «Ver cambios» respecto a la anterior
function pintarVersiones(c) {
  const vs = c.versions || [];
  const ultima = vs.length - 1;
  let i = state.verVersion == null ? ultima : Math.min(state.verVersion, ultima);
  if (i < 0) {
    $("#dVer").innerHTML = "";
    $("#dVerAviso").hidden = true;
    $("#dResult").innerHTML = c.result ? md(c.result) : "";
    return;
  }
  const v = vs[i];
  const anterior = vs[i - 1];
  $("#dVer").innerHTML =
    vs.length > 1
      ? `<button class="mini" data-ver="-1" ${i === 0 ? "disabled" : ""} title="Versión anterior">‹</button><span>Versión ${v.n} de ${vs.at(-1).n}</span><button class="mini" data-ver="1" ${i === ultima ? "disabled" : ""} title="Versión siguiente">›</button>${anterior ? `<button class="mini ${state.verCambios ? "on" : ""}" data-cambios title="Qué cambió respecto a la versión ${anterior.n}">${state.verCambios ? "Ocultar cambios" : "Ver cambios"}</button>` : ""}`
      : "";
  for (const b of document.querySelectorAll("#dVer [data-ver]"))
    b.onclick = () => {
      state.verVersion = Math.max(0, Math.min(ultima, i + Number(b.dataset.ver)));
      pintarVersiones(c);
    };
  $("#dVer [data-cambios]")?.addEventListener("click", () => {
    state.verCambios = !state.verCambios;
    pintarVersiones(c);
  });
  const fecha = new Date(v.t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("#dVerAviso").hidden = i === ultima && !state.verCambios;
  $("#dVerAviso").innerHTML = i === ultima ? `Cambios de la versión ${v.n} respecto a la ${anterior?.n}` : `Estás viendo la <b>versión ${v.n}</b> (${esc(v.quien)}, ${fecha}). La actual es la ${vs.at(-1).n}.`;
  const clave = `${c.id}:${i}:${state.verCambios}:${v.result.length}`;
  if ($("#dResult").dataset.src === clave) return;
  $("#dResult").dataset.src = clave;
  $("#dResult").innerHTML = state.verCambios && anterior ? diferencias(anterior.result, v.result) : md(v.result);
}

// Diferencias línea a línea (LCS): verde lo añadido, rojo tachado lo quitado
function diferencias(antes, despues) {
  const a = antes.split("\n"), b = despues.split("\n");
  if (a.length * b.length > 4_000_000) return `<p class="muted">Las versiones son demasiado largas para compararlas aquí.</p>` + md(despues);
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lineas = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) lineas.push(["igual", a[i++]]), j++;
    else if (i < m && (j === n || lcs[i + 1][j] >= lcs[i][j + 1])) lineas.push(["menos", a[i++]]); // primero lo que se quita…
    else lineas.push(["mas", b[j++]]); // …y después lo que entra
  }
  const añadidas = lineas.filter((l) => l[0] === "mas").length, quitadas = lineas.filter((l) => l[0] === "menos").length;
  return `<p class="diff-resumen"><span class="mas">+${añadidas}</span> <span class="menos">−${quitadas}</span> líneas</p><div class="diff">${lineas
    .map(([tipo, texto]) => `<div class="d-${tipo}"><span>${tipo === "mas" ? "+" : tipo === "menos" ? "−" : " "}</span>${esc(texto) || "&nbsp;"}</div>`)
    .join("")}</div>`;
}

// Conversación: tú a la derecha, la IA a la izquierda
const ETIQUETA = { respuesta: "respuesta", pregunta: "❓ pregunta", nota: "📝 nota", entrega: "✓ entregó" };
function pintarHilo(c) {
  const lista = $("#dThread");
  const mensajes = c.thread || [];
  const firma = `${mensajes.length}:${mensajes.at(-1)?.t || 0}:${c.status}`;
  if (lista.dataset.firma !== firma) {
    lista.dataset.firma = firma;
    lista.innerHTML = mensajes.length
      ? mensajes
          .map((m, i) => {
            const pendiente = m.tipo === "pregunta" && i === mensajes.length - 1 && c.status === "waiting";
            const hora = new Date(m.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            return `<li class="msg ${m.de} ${m.tipo}${pendiente ? " pendiente" : ""}"><div class="who">${m.de === "persona" ? "Tú" : `🧠 ${esc(m.quien || "IA")}`}${ETIQUETA[m.tipo] ? ` · <span>${ETIQUETA[m.tipo]}</span>` : ""}<time>${hora}</time></div><div class="txt">${md(m.texto)}</div></li>`;
          })
          .join("")
      : ""; // vacía: el campo de abajo ya dice a quién le llega lo que escribas
    lista.scrollTop = lista.scrollHeight;
  }
  // El cuadro de texto se adapta a lo que está pasando
  const ta = $("#dFeedbackText");
  const quien = c.worker || "la IA";
  let botones;
  if (c.status === "waiting") {
    ta.placeholder = "Tu respuesta…";
    botones = `<button class="btn primary" data-a="answer">Responder</button>`;
  } else if (LIVE.includes(c.status)) {
    ta.placeholder = c.status === "queued" ? "Instrucciones para quien la tome…" : `Escribe a ${quien}: lo leerá en su próximo paso, sin detenerse…`;
    botones = `<button class="btn primary" data-a="comment">Enviar</button>`;
  } else if (c.column === "backlog") {
    ta.placeholder = "Nota o instrucción para quien la trabaje…";
    botones = `<button class="btn primary" data-a="feedback">⚡ Pedírsela a la IA</button><button class="btn" data-a="comment">Solo anotar</button>`;
  } else {
    // Entregada: aquí se le contesta (a lo que preguntó u ofreció al entregar) o se le piden cambios
    ta.placeholder = `Responde a ${quien} o pide cambios: lo recibe y sigue con esta tarjeta…`;
    botones = `<button class="btn primary" data-a="feedback">↩ Responder a la IA</button><button class="btn" data-a="comment">Solo anotar</button>`;
  }
  const marcados = (c.criterios || []).filter((x) => x.falla);
  if (marcados.length && c.column === "review") ta.placeholder = `La IA sabrá que no se cumple${marcados.length > 1 ? "n" : ""} ${marcados.map((x) => `«${corto(x.texto, 40)}»`).join(", ")}. Añade lo que quieras…`;
  if ($("#dSend").dataset.modo !== botones) {
    $("#dSend").dataset.modo = botones;
    $("#dSend").innerHTML = botones;
    for (const b of document.querySelectorAll("#dSend .btn")) b.onclick = () => action(c.id, b.dataset.a);
  }
}

// «Espera a…» en el panel de la tarjeta
function pintarDependencias(c) {
  const deps = (c.dependsOn || []).map((id) => state.cards.get(id)).filter(Boolean);
  $("#dDepList").innerHTML = deps.length
    ? deps
        .map((d) => `<li class="${d.column === "done" ? "hecha" : ""}"><span class="dep-estado">${d.column === "done" ? "✓" : "⏳"}</span><button class="link-card" data-open="${d.id}">${esc(d.title)}</button><span class="muted">${d.column === "done" ? "hecha" : { backlog: "en Ideas", doing: "en curso", review: "para revisar" }[d.column]}</span><button class="icon-btn dep-quitar" data-quitar="${d.id}" title="Ya no esperar a esta">✕</button></li>`)
        .join("")
    : "";
  // Candidatas: mismo proyecto, sin archivar, que no sean ella ni la esperen ya (eso haría un ciclo; el servidor lo comprueba)
  const esperanA = (id, vistas = new Set()) => [...state.cards.values()].some((x) => x.dependsOn?.includes(id) && (x.id === c.id || (!vistas.has(x.id) && (vistas.add(x.id), esperanA(x.id, vistas)))));
  const candidatas = [...state.cards.values()].filter((x) => x.id !== c.id && !x.archivedAt && !c.dependsOn?.includes(x.id) && x.projectId === c.projectId && !esperanA(x.id) && !(x.dependsOn || []).includes(c.id));
  $("#dDepAdd").innerHTML = `<option value="">＋ Añadir una tarjeta a la que espera…</option>` + candidatas.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join("");
  $("#dDepAdd").hidden = candidatas.length === 0;
  $("#dDeps").hidden = !deps.length && !candidatas.length; // nada que mostrar ni que elegir
  const guardar = (ids) => api(`/api/cards/${c.id}/edit`, { dependsOn: ids }).catch((err) => toast(err.message, true));
  $("#dDepAdd").onchange = (e) => {
    if (e.target.value) guardar([...(c.dependsOn || []), e.target.value]);
  };
  for (const b of document.querySelectorAll("#dDepList [data-quitar]")) b.onclick = () => guardar(c.dependsOn.filter((x) => x !== b.dataset.quitar));
  for (const b of document.querySelectorAll("#dDepList [data-open]")) b.onclick = () => openDrawer(b.dataset.open);
}

// Opciones de proyecto para un <select>
// Toda tarjeta es de un proyecto: si no se indica, el que estás viendo (o «General», o el primero)
function llenarProyectos(select, valor) {
  select.innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  select.value = proyecto(valor)?.id || proyecto(state.filtro)?.id || state.projects.find((p) => p.name === "General")?.id || state.projects[0]?.id || "";
}

async function openFile(f) {
  const url = "/files/" + f.split("/").map(encodeURIComponent).join("/");
  const vista = state.vista + f.split("/").map(encodeURIComponent).join("/"); // aislada: puede ejecutarse sin tocar el tablero
  const ext = (f.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const tipo =
    ["html", "htm"].includes(ext) ? "html"
    : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "img"
    : ext === "pdf" ? "pdf"
    : ["mp3", "wav", "ogg"].includes(ext) ? "audio"
    : ["mp4", "webm"].includes(ext) ? "video"
    : ext === "md" ? "md"
    : ["csv", "tsv"].includes(ext) ? "csv"
    : ext === "json" ? "json"
    : LENGUAJE[ext] ? "codigo"
    : "texto";
  const text = ["md", "csv", "json", "codigo", "texto"].includes(tipo) ? await (await fetch(url)).text() : "";
  const back = state.openId;
  state.view = "file";
  const nombre = f.split("/").pop();
  let cuerpo;
  if (tipo === "html")
    cuerpo = `<div class="vista-barra"><span class="muted">▶ Funciona aquí mismo, aislada de tu tablero</span><button class="mini" id="vRecargar" title="Volver a cargar">↻ Recargar</button><button class="mini" id="vGrande" title="A pantalla completa">⛶ En grande</button><a class="mini" href="${esc(vista)}" target="_blank" rel="noopener">↗ Pestaña nueva</a></div>
      <iframe class="vista-html" id="vFrame" src="${esc(vista)}" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups" title="${esc(nombre)}"></iframe>`;
  else if (tipo === "img") cuerpo = `<img src="${esc(ext === "svg" ? vista : url)}" alt="${esc(f)}">`;
  else if (tipo === "pdf") cuerpo = `<iframe class="vista-html vista-pdf" src="${esc(vista)}" title="${esc(nombre)}"></iframe>`;
  else if (tipo === "audio") cuerpo = `<audio controls src="${esc(vista)}" style="width:100%"></audio>`;
  else if (tipo === "video") cuerpo = `<video controls src="${esc(vista)}" style="width:100%;border-radius:10px"></video>`;
  else if (tipo === "md") cuerpo = `<div class="result">${md(text)}</div>`;
  else if (tipo === "csv") cuerpo = tablaCSV(text, ext === "tsv" ? "\t" : null);
  else if (tipo === "json") {
    let bonito = text;
    try {
      bonito = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
    cuerpo = bloqueCodigo(bonito, "json");
  } else if (tipo === "codigo") cuerpo = bloqueCodigo(text, LENGUAJE[ext]);
  else cuerpo = `<pre>${esc(text)}</pre>`;
  $("#drawerBody").innerHTML = `
    <div class="d-head"><div class="t" style="font-family:var(--mono);font-size:15px">${esc(f)}</div><button class="icon-btn" id="dBack" title="Volver">←</button></div>
    <div class="vista-acciones"><a class="mini" href="${esc(url)}" download="${esc(nombre)}">⤓ Descargar</a></div>
    <div class="d-section file-view tipo-${tipo}">${cuerpo}</div>`;
  $("#dBack").onclick = () => (back && state.cards.has(back) ? openDrawer(back) : closeDrawer());
  if (tipo === "html") {
    $("#vRecargar").onclick = () => ($("#vFrame").src = vista);
    $("#vGrande").onclick = () => vistaGrande(vista, nombre);
  }
  showDrawer(); // desde «Entregables» el panel podía estar cerrado: el archivo se abría sin verse
}

// A pantalla completa, dentro de Órbita (sigue aislada); Esc o ✕ para salir
function vistaGrande(src, nombre) {
  const capa = document.createElement("div");
  capa.className = "vista-grande";
  capa.id = "vistaGrande";
  capa.innerHTML = `<div class="vg-barra"><span>${esc(nombre)}</span><span class="muted vg-nota">Esc con el cursor fuera de la página · dentro, las teclas son de la página</span><button class="btn" id="vgCerrar" title="Salir de la vista en grande">✕ Salir</button></div><iframe src="${esc(src)}" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups" title="${esc(nombre)}"></iframe>`;
  document.body.append(capa);
  const cerrar = () => {
    capa.remove();
    document.removeEventListener("keydown", tecla, true);
  };
  const tecla = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // que no cierre también el panel
    cerrar();
  };
  document.addEventListener("keydown", tecla, true);
  $("#vgCerrar").onclick = cerrar;
  capa.querySelector("iframe").focus(); // para jugar o escribir sin hacer clic antes
}

// CSV → tabla (con comillas, comas dentro de comillas y saltos de línea)
function tablaCSV(texto, sep) {
  sep ||= (texto.split("\n")[0].match(/;/g) || []).length > (texto.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') (campo += '"'), i++;
      else if (ch === '"') comillas = false;
      else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) fila.push(campo), (campo = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo), filas.push(fila), (fila = []), (campo = "");
    } else campo += ch;
  }
  if (campo || fila.length) fila.push(campo), filas.push(fila);
  const datos = filas.filter((r) => r.some((c) => c.trim()));
  if (!datos.length) return `<p class="muted">El archivo está vacío.</p>`;
  const [cab, ...resto] = datos;
  const max = 500;
  const num = (v) => /^[+-]?[\d.,]+\s?%?$/.test(v.trim()) && /\d/.test(v);
  return `<div class="tabla-csv"><table><thead><tr>${cab.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${resto
    .slice(0, max)
    .map((r) => `<tr>${cab.map((_, k) => `<td${num(r[k] || "") ? ' class="num"' : ""}>${esc(r[k] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div><p class="muted tabla-pie">${resto.length} fila${resto.length === 1 ? "" : "s"} × ${cab.length} columna${cab.length === 1 ? "" : "s"}${resto.length > max ? ` (se muestran ${max})` : ""}</p>`;
}

// Código con colores, sin librerías: comentarios, cadenas, números y palabras clave
const LENGUAJE = { js: "js", mjs: "js", cjs: "js", ts: "js", jsx: "js", tsx: "js", py: "py", css: "css", sh: "sh", bash: "sh", zsh: "sh", sql: "sql", yml: "yaml", yaml: "yaml", java: "js", c: "js", cpp: "js", go: "js", rs: "js", swift: "js", rb: "py", php: "js", xml: "xml" };
const CLAVES = {
  js: "async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
  sh: "if then else elif fi for while do done case esac function in export local return echo exit",
  sql: "select from where and or not insert into values update set delete create table drop alter join left right inner on group by order having limit as null primary key",
  css: "",
  yaml: "true false null",
  json: "true false null",
  xml: "",
};
function bloqueCodigo(texto, lenguaje) {
  const claves = new Set((CLAVES[lenguaje] || "").split(" ").filter(Boolean));
  const comentario = lenguaje === "py" || lenguaje === "sh" || lenguaje === "yaml" ? "#[^\\n]*" : lenguaje === "sql" ? "--[^\\n]*" : lenguaje === "json" ? "(?!)" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const re = new RegExp(`(${comentario})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, "g");
  const colorear = (t) => {
    let html = "", ultimo = 0;
    for (const m of t.matchAll(re)) {
      html += esc(t.slice(ultimo, m.index));
      const [todo, com, cad, num, pal] = m;
      if (com) html += `<span class="c-com">${esc(com)}</span>`;
      else if (cad) html += `<span class="c-cad">${esc(cad)}</span>`;
      else if (num) html += `<span class="c-num">${esc(num)}</span>`;
      else if (pal && claves.has(lenguaje === "sql" ? pal.toLowerCase() : pal)) html += `<span class="c-clave">${esc(pal)}</span>`;
      else html += esc(todo);
      ultimo = m.index + todo.length;
    }
    return html + esc(t.slice(ultimo));
  };
  const lineas = colorear(texto.length > 400_000 ? texto.slice(0, 400_000) : texto).split("\n");
  return `<pre class="codigo" data-lenguaje="${esc(lenguaje)}"><code>${lineas.map((l, i) => `<span class="ln">${i + 1}</span>${l}`).join("\n")}</code></pre>`;
}

// Conectar una IA como cerebro
function openConnect() {
  state.openId = null;
  state.view = "connect";
  const url = state.mcpUrl;
  const snippets = [
    ["Claude Code", "Conéctalo una vez (queda disponible en todas tus sesiones):", `claude mcp add --transport http --scope user orbita ${url}`],
    ["Cursor / Windsurf / VS Code", "Añade esto a la configuración MCP (por ejemplo ~/.cursor/mcp.json):", JSON.stringify({ mcpServers: { orbita: { url } } }, null, 2)],
    ["Claude Desktop", "Añade esto a claude_desktop_config.json (usa el puente mcp-remote):", JSON.stringify({ mcpServers: { orbita: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2)],
  ];
  const tools = [
    ["wait_for_work", "escucha el tablero y toma la siguiente tarjeta en «En curso»"],
    ["report_progress", "mueve la barra de progreso en vivo"],
    ["submit_result", "entrega el resultado para que lo revises"],
    ["ask_human", "te hace una pregunta"],
    ["create_card", "crea tarjetas (por ejemplo, al planificar un objetivo)"],
    ["list_cards / get_card / claim_card", "consulta el tablero y toma tarjetas concretas"],
    ["move_card", "mueve tarjetas si se lo pides"],
    ["list_files / read_file / write_file", "comparte entregables"],
  ];
  const brains = state.brains.length
    ? `<div class="brain-now on">🧠 Conectada ahora: <b>${state.brains.map((b) => esc(b.name) + (b.listening ? " (escuchando)" : "")).join(", ")}</b></div>`
    : `<div class="brain-now">Ahora mismo no hay ninguna IA conectada. Las tarjetas que pongas en «En curso» esperarán a que se conecte una.</div>`;
  $("#drawerBody").innerHTML = `
    <div class="d-head"><div class="t">Conecta un cerebro</div><button class="icon-btn" id="dClose">✕</button></div>
    <p class="sub" style="margin:6px 0 4px;font-size:13px">Órbita no usa API keys. La inteligencia la pone la IA que conectes por MCP: Claude Code, Cursor, Claude Desktop o cualquier otra. Esa IA toma las tarjetas que pongas en «En curso», te muestra su progreso y te entrega el resultado.</p>
    ${brains}
    <div class="mcp-url"><code>${esc(url)}</code><button class="btn" data-copy="${esc(url)}">Copiar</button></div>
    ${snippets.map(([name, hint, code]) => `<div class="d-section"><h4>${name}</h4><p class="sub" style="margin:0 0 8px">${hint}</p><div class="snippet"><pre>${esc(code)}</pre><button class="btn" data-copy="${esc(code)}">Copiar</button></div></div>`).join("")}
    <div class="d-section"><h4>Ponla a trabajar</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">En Claude Code usa el comando del servidor:</p>
      <div class="snippet"><pre>/mcp__orbita__trabajar</pre><button class="btn" data-copy="/mcp__orbita__trabajar">Copiar</button></div>
      <p class="sub" style="margin:10px 0 0;font-size:13px">En cualquier otra IA, pídele: <i>«Sé el cerebro de mi tablero Órbita: usa wait_for_work y trabaja las tarjetas una tras otra»</i>.</p>
    </div>
    <div class="d-section"><h4>Un proyecto nuevo, desde tu IA</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">No hace falta tocar la app: pídeselo en su chat y el tablero cambia solo al proyecto. En Claude Code:</p>
      <div class="snippet"><pre>/mcp__orbita__nuevo_proyecto Mi proyecto</pre><button class="btn" data-copy="/mcp__orbita__nuevo_proyecto ">Copiar</button></div>
      <p class="sub" style="margin:10px 0 0;font-size:13px">O con tus palabras: <i>«Abre en Órbita un proyecto llamado Web de la tienda y quédate escuchando»</i>. Cada sesión puede llevar su propio proyecto, en paralelo.</p>
    </div>
    <div class="d-section"><h4>Lo que puede hacer</h4><ul class="tool-list">${tools.map(([t, d]) => `<li><code>${t}</code><span>${d}</span></li>`).join("")}</ul></div>`;
  $("#dClose").onclick = closeDrawer;
  for (const b of document.querySelectorAll("[data-copy]"))
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast("Copiado ✓");
      } catch {
        toast("No se pudo copiar; selecciónalo a mano", true);
      }
    };
  showDrawer();
}

// ---------------------------------------------------------------------------
// Objetivo, nueva tarjeta y atajos
// ---------------------------------------------------------------------------

$("#goalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#goalInput");
  const goal = input.value.trim();
  if (!goal) return input.focus();
  if (modoBarra === "preguntar") return preguntar(goal);
  try {
    // El plan va al proyecto que estás viendo; solo si no hay ninguno se crea uno (con su carpeta de trabajo)
    const actual = proyecto(state.filtro);
    let cuerpo = { goal, projectId: actual?.id };
    if (!actual) {
      const dir = await elegirCarpeta(`Carpeta de trabajo para «${goal.length > 60 ? goal.slice(0, 59) + "…" : goal}»`);
      if (!dir) return;
      cuerpo = { goal, dir };
    }
    const card = await api("/api/goal", cuerpo);
    input.value = "";
    state.seccion = "tablero";
    elegirFiltro(card.projectId);
    const donde = actual ? `en «${corto(actual.name, 40)}»` : "en un proyecto nuevo";
    toast(hasBrain() ? `🎯 Objetivo añadido ${donde}. La IA lo está dividiendo en tarjetas…` : `🎯 Objetivo añadido ${donde}. Conecta una IA para que lo divida en tarjetas.`);
  } catch (err) {
    toast(err.message, true);
  }
});

const dlg = $("#newDialog");
$("#addBtn").onclick = () => abrirNueva();
// Nueva tarjeta, opcionalmente desde una plantilla
function abrirNueva(plantillaId = null) {
  $("#newForm").reset();
  delete dlg.dataset.plantilla;
  $("#newCampos").hidden = true;
  $("#newCampos").innerHTML = "";
  llenarProyectos($("#newProject"), state.filtro);
  pintarPlantillas();
  dlg.showModal();
  if (plantillaId) aplicarPlantilla(plantillaId);
  else $("#newForm").title.focus();
}
// Enter en un campo de una línea = «Crear» (antes cerraba sin crear: el botón por defecto era «Cancelar»)
$("#newForm").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type === "checkbox" || e.isComposing) return;
  e.preventDefault();
  $("#newForm").requestSubmit($('#newForm button[value="ok"]'));
});
$("#newForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  // Con plantilla: todos sus campos rellenos
  const vacio = [...document.querySelectorAll("#newCampos input")].find((i) => !i.value.trim());
  if (vacio) {
    e.preventDefault();
    toast(`Rellena «${vacio.dataset.campo}»`, true);
    vacio.focus();
    return;
  }
  const f = new FormData(e.target);
  try {
    await api("/api/cards", { title: f.get("title"), description: f.get("description"), criterios: String(f.get("criterios") || "").split("\n").map((t) => t.trim()).filter(Boolean), run: f.get("run") === "on", projectId: f.get("projectId") || null });
  } catch (err) {
    toast(err.message, true);
  }
});

$("#brainStat").onclick = openConnect;
$("#scrim").onclick = closeDrawer;

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName) || dlg.open;
  if (!typing && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && state.openId && state.view === "card") {
    e.preventDefault();
    return desplazar(state.openId, e.key === "ArrowUp" ? -1 : +1); // Alt+↑/↓ mueve la tarjeta abierta
  }
  if (e.key === "Escape" && !$("#alertsPanel").hidden) $("#alertsBtn").click();
  else if (e.key === "Escape" && $("#drawer").classList.contains("on")) closeDrawer();
  if (typing) return;
  if (e.key === "/") {
    e.preventDefault();
    $("#goalInput").focus();
  }
  if (e.key === "n") {
    e.preventDefault();
    $("#addBtn").click();
  }
});

load()
  .then(() => {
    const id = /^#t=(\w+)$/.exec(location.hash)?.[1];
    if (id && state.cards.has(id)) openDrawer(id);
  })
  .then(connect)
  .catch((err) => toast(err.message, true));


// ---------------------------------------------------------------------------
// Avisos: contador en la pestaña, aviso del navegador y sonido
// ---------------------------------------------------------------------------

const avisos = leerAvisos();
function leerAvisos() {
  try {
    return { navegador: false, sonido: false, ...JSON.parse(localStorage.getItem("orbita.avisos") || "{}") };
  } catch {
    return { navegador: false, sonido: false };
  }
}
function guardarAvisos() {
  try {
    localStorage.setItem("orbita.avisos", JSON.stringify(avisos));
  } catch {}
}

const noMirando = () => document.hidden || !document.hasFocus();

function avisar(card, tipo) {
  if (!noMirando()) return; // si estás mirando el tablero ya lo ves
  const quien = card.worker || "La IA";
  if (avisos.sonido) sonar(tipo);
  if (avisos.navegador && "Notification" in window && Notification.permission === "granted") {
    const n = new Notification(tipo === "pregunta" ? `❓ ${quien} te pregunta algo` : `✓ ${quien} entregó una tarjeta`, {
      body: tipo === "pregunta" ? `${card.title}\n${card.question}` : card.title,
      tag: `orbita-${card.id}`, // si llega otro aviso de la misma tarjeta, sustituye al anterior
      icon: ICONO_BASE,
    });
    n.onclick = () => {
      window.focus();
      openDrawer(card.id);
      n.close();
    };
  }
}

// Dos o tres notas suaves (sin archivos de audio)
let audio;
function sonar(tipo) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const notas = tipo === "pregunta" ? [659.25, 880] : [523.25, 659.25, 783.99];
    notas.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.12;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
  } catch {}
}

// «(2) Órbita» y un punto con el número en el icono de la pestaña
const ICONO_BASE = $("#favicon").href;
let ultimoN = -1;
function actualizarPendientes() {
  const n = [...state.cards.values()].filter((c) => !c.archivedAt && (c.status === "ready" || c.status === "waiting")).length;
  if (n === ultimoN) return;
  ultimoN = n;
  document.title = n ? `(${n}) Órbita` : "Órbita";
  $("#favicon").href = n ? iconoConNumero(n) : ICONO_BASE;
}
function iconoConNumero(n) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = "#a78bfa";
  x.beginPath();
  x.arc(26, 34, 14, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#f43f5e";
  x.beginPath();
  x.arc(44, 20, 19, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#fff";
  x.font = "bold 26px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(n > 9 ? "9+" : String(n), 44, 21);
  return c.toDataURL("image/png");
}

// Panel de ajustes del botón 🔔
function pintarAvisos() {
  const soportado = "Notification" in window;
  const permiso = soportado ? Notification.permission : "no";
  $("#optNotif").checked = avisos.navegador && permiso === "granted";
  $("#optNotif").disabled = !soportado;
  $("#optSound").checked = avisos.sonido;
  $("#notifEstado").textContent = !soportado
    ? "Este navegador no permite avisos."
    : permiso === "denied"
      ? "Bloqueados en el navegador: actívalos en los ajustes de este sitio."
      : "";
  const activo = $("#optNotif").checked || avisos.sonido;
  $("#alertsIcon").textContent = activo ? "🔔" : "🔕";
  $("#alertsBtn").classList.toggle("on", activo);
}
$("#alertsBtn").onclick = (e) => {
  e.stopPropagation();
  const panel = $("#alertsPanel");
  panel.hidden = !panel.hidden;
  $("#alertsBtn").setAttribute("aria-expanded", String(!panel.hidden));
  pintarAvisos();
};
document.addEventListener("click", (e) => {
  if (!$("#alertsPanel").hidden && !e.target.closest(".alerts")) {
    $("#alertsPanel").hidden = true;
    $("#alertsBtn").setAttribute("aria-expanded", "false");
  }
});
$("#optNotif").onchange = async (e) => {
  if (e.target.checked && Notification.permission !== "granted") {
    const r = await Notification.requestPermission(); // solo se pide aquí, porque tú lo activas
    if (r !== "granted") e.target.checked = false;
  }
  avisos.navegador = e.target.checked;
  guardarAvisos();
  pintarAvisos();
  if (avisos.navegador) toast("🔔 Te avisaré aunque estés en otra pestaña");
};
$("#optSound").onchange = (e) => {
  avisos.sonido = e.target.checked;
  guardarAvisos();
  pintarAvisos();
  if (avisos.sonido) sonar("entrega"); // así oyes cómo suena (y el navegador lo permite)
};
$("#testSound").onclick = () => sonar("pregunta");
pintarAvisos();


// ---------------------------------------------------------------------------
// Preguntas rápidas: la IA responde sin crear tarjeta
// ---------------------------------------------------------------------------

async function preguntar(texto) {
  try {
    const projectId = proyecto(state.filtro) ? state.filtro : null; // en la pestaña de un proyecto, con su contexto
    await api("/api/questions", { text: texto, projectId });
    $("#goalInput").value = "";
    openPreguntas();
    if (!hasBrain()) toast("Tu pregunta espera a que se conecte una IA");
  } catch (err) {
    toast(err.message, true);
  }
}

function pintarContadorPreguntas() {
  const n = (state.questions || []).filter((q) => q.status !== "respondida").length;
  $("#qaCount").hidden = !n;
  $("#qaCount").textContent = n;
}

function avisarRespuesta(q) {
  if (!noMirando() || state.view === "preguntas") return;
  if (avisos.sonido) sonar("entrega");
  if (avisos.navegador && "Notification" in window && Notification.permission === "granted") {
    const n = new Notification(`💬 ${q.worker || "La IA"} respondió`, { body: q.text.slice(0, 140), tag: `orbita-q-${q.id}`, icon: ICONO_BASE });
    n.onclick = () => (window.focus(), openPreguntas(), n.close());
  }
}

function renderPreguntas() {
  const lista = [...(state.questions || [])].reverse();
  const quien = state.brains.find((b) => b.listening)?.name;
  // La caja de texto se crea una sola vez: si llegan cambios mientras escribes, solo se repinta la lista
  if (!$("#qaForm")) {
    $("#drawerBody").innerHTML = `
    <div class="d-head"><div class="t">Preguntas rápidas</div><button class="icon-btn" id="dClose">✕</button></div>
    <form class="qa-form" id="qaForm"><textarea id="qaText" rows="2" placeholder="Pregunta algo… (Cmd/Ctrl+Enter para enviar)"></textarea><button class="btn primary">Preguntar</button></form>
    <p class="muted qa-ctx"></p>
    <div class="qa-ia" id="qaIA"></div>
    <ol class="qa-list"></ol>`;
    $("#dClose").onclick = closeDrawer;
    const ta = $("#qaText");
    $("#qaForm").onsubmit = (e) => {
      e.preventDefault();
      if (ta.value.trim()) preguntar(ta.value.trim());
    };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#qaForm").requestSubmit();
    };
  }
  pintarIAPreguntas();
  $("#drawerBody .qa-ctx").innerHTML = proyecto(state.filtro) ? `Se preguntará con el contexto de <b>${esc(proyecto(state.filtro).name)}</b> (instrucciones, memoria y conocimiento).` : "Sin proyecto: la IA responde sin contexto de proyecto. Pregunta desde la pestaña de un proyecto para darle su contexto.";
  $("#drawerBody .qa-list").innerHTML = `${
      lista
        .map((q) => {
          const estado =
            q.status === "respondida"
              ? `<div class="result qa-answer">${md(q.answer)}</div>`
              : q.status === "respondiendo"
                ? `<div class="qa-wait"><i class="spinner"></i> ${esc(q.worker)} está respondiendo…</div>`
                : `<div class="qa-wait">⏳ ${quien ? `En espera: la recibirá ${esc(quien)}` : "Esperando a que se conecte una IA"}</div>`;
          const p = proyecto(q.projectId);
          return `<li class="qa-item" data-q="${q.id}">
            <div class="qa-q">${esc(q.text)}</div>
            <div class="qa-meta">${p ? `<i class="tab-dot" style="--h:${tono(p.id)}"></i>${esc(p.name)} · ` : ""}${new Date(q.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${q.status === "respondida" ? ` · respondió ${esc(q.worker || "la IA")}` : ""}</div>
            ${estado}
            <div class="qa-acciones">${q.status === "respondida" ? `<button class="mini" data-copiar="${q.id}">Copiar respuesta</button>` : ""}<button class="mini" data-tarjeta="${q.id}">Convertir en tarjeta</button><button class="mini" data-borrar-q="${q.id}">Eliminar</button></div>
          </li>`;
        })
        .join("") || `<li class="empty-state">Aún no has hecho preguntas. Escribe arriba, o usa el modo 💬 Preguntar de la barra.</li>`
    }`;
  for (const b of document.querySelectorAll("[data-copiar]"))
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(state.questions.find((q) => q.id === b.dataset.copiar).answer);
        toast("Respuesta copiada ✓");
      } catch {
        toast("No se pudo copiar", true);
      }
    };
  for (const b of document.querySelectorAll("[data-tarjeta]"))
    b.onclick = async () => {
      const card = await api(`/api/questions/${b.dataset.tarjeta}/card`, {}).catch((err) => toast(err.message, true));
      if (card) {
        toast("Convertida en tarjeta (en Ideas)");
        upsert(card); // sin esperar al aviso del servidor: si no, a veces no se abría
        openDrawer(card.id);
      }
    };
  for (const b of document.querySelectorAll("[data-borrar-q]")) b.onclick = () => api(`/api/questions/${b.dataset.borrarQ}`, undefined, "DELETE").catch((err) => toast(err.message, true));
}

function openPreguntas() {
  state.openId = null;
  state.view = "preguntas";
  $("#drawerBody").innerHTML = ""; // al abrir, panel nuevo
  renderPreguntas();
  showDrawer();
  setTimeout(() => $("#qaText")?.focus(), 30); // listo para escribir, sin hacer clic
}
$("#qaBtn").onclick = openPreguntas;
document.addEventListener("keydown", (e) => {
  if (e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !dlg.open) {
    e.preventDefault();
    openPreguntas();
  }
});


// ---------------------------------------------------------------------------
// Búsqueda global (⌘K): todo lo del tablero, también lo archivado, en el navegador
// ---------------------------------------------------------------------------

const sinTildes = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Dónde se busca, por orden de importancia
function camposDe(c) {
  return [
    ["Título", c.title, 30],
    ["Descripción", c.description, 12],
    ...(c.criterios || []).map((x) => ["Criterio", x.texto, 7]),
    ["Resultado", c.result, 8],
    ...(c.versions || []).slice(0, -1).map((v) => [`Versión ${v.n}`, v.result, 3]),
    ...(c.thread || []).map((m) => [`Conversación · ${m.de === "persona" ? "tú" : m.quien || "IA"}`, m.texto, 5]),
    ...(c.attachments || []).map((a) => ["Adjunto", a.name, 6]),
    ...(c.files || []).map((f) => ["Archivo de la IA", f, 4]),
    ["En vivo", c.live, 2],
  ].filter(([, texto]) => texto);
}

let indice = null; // se rehace cuando cambia algo
const invalidarIndice = () => (indice = null);
function construirIndice() {
  indice = [];
  for (const c of state.cards.values()) indice.push({ tipo: "tarjeta", c, campos: camposDe(c).map(([d, t, peso]) => [d, String(t), sinTildes(t), peso]) });
  for (const q of state.questions || []) indice.push({ tipo: "pregunta", q, campos: [["Pregunta", q.text, sinTildes(q.text), 10], ["Respuesta", q.answer, sinTildes(q.answer), 6]].filter((x) => x[1]) });
  for (const f of state.files) if (!f.includes("/adjuntos/")) indice.push({ tipo: "archivo", f, campos: [["Entregable", f, sinTildes(f), 6]] });
}

function buscar(consulta) {
  const palabras = sinTildes(consulta).split(/\s+/).filter(Boolean);
  if (!palabras.length) return [];
  if (!indice) construirIndice();
  const resultados = [];
  for (const item of indice) {
    let puntos = 0;
    let mejor = null;
    let todas = true;
    for (const p of palabras) {
      let encontrada = false;
      for (const [donde, original, norm, peso] of item.campos) {
        const i = norm.indexOf(p);
        if (i === -1) continue;
        encontrada = true;
        puntos += peso + (i === 0 ? 3 : 0);
        if (!mejor || peso > mejor.peso) mejor = { donde, original, i, largo: p.length, peso };
      }
      if (!encontrada) {
        todas = false;
        break;
      }
    }
    if (todas) resultados.push({ ...item, puntos: puntos - (item.c?.archivedAt ? 5 : 0), mejor, palabras });
  }
  return resultados.sort((a, b) => b.puntos - a.puntos).slice(0, 60);
}

// Fragmento alrededor de la coincidencia, con las palabras resaltadas
function fragmento(texto, i, palabras) {
  const desde = Math.max(0, i - 50);
  let trozo = texto.slice(desde, desde + 160).replace(/\s+/g, " ");
  const html = resaltar(trozo, palabras);
  return (desde > 0 ? "…" : "") + html + (desde + 160 < texto.length ? "…" : "");
}
function resaltar(texto, palabras) {
  const norm = sinTildes(texto);
  const marcas = [];
  for (const p of palabras) {
    let i = norm.indexOf(p);
    while (i !== -1) {
      marcas.push([i, i + p.length]);
      i = norm.indexOf(p, i + p.length);
    }
  }
  marcas.sort((a, b) => a[0] - b[0]);
  let html = "", ultimo = 0;
  for (const [a, b] of marcas) {
    if (a < ultimo) continue;
    html += esc(texto.slice(ultimo, a)) + "<mark>" + esc(texto.slice(a, b)) + "</mark>";
    ultimo = b;
  }
  return html + esc(texto.slice(ultimo));
}

let seleccion = 0;
let encontrados = [];
function pintarBusqueda() {
  if (verAtajos) return pintarAtajos();
  const consulta = $("#buscarInput").value;
  const t0 = performance.now();
  const soloComandos = consulta.trimStart().startsWith(">");
  const cmds = buscarComandos(soloComandos ? consulta.trimStart().slice(1) : consulta, soloComandos);
  encontrados = [...cmds, ...(soloComandos ? [] : buscar(consulta))];
  const ms = performance.now() - t0;
  seleccion = Math.min(seleccion, Math.max(0, encontrados.length - 1));
  const COLUMNA = { backlog: "Ideas", doing: "En curso", review: "Para revisar", done: "Hecho" };
  $("#buscarLista").innerHTML = encontrados
    .map((r, i) => {
      if (r.tipo === "comando") {
        const titulo = i === 0 || encontrados[i - 1].tipo !== "comando" ? `<li class="b-grupo">Comandos</li>` : "";
        const fin = r.ultimo && encontrados[i + 1] ? `<li class="b-grupo">Resultados</li>` : "";
        return `${titulo}<li role="option" class="b-item b-cmd ${i === seleccion ? "on" : ""}" data-i="${i}" aria-selected="${i === seleccion}"><span class="b-ico">${r.cmd.icono}</span><span class="b-txt">${r.palabras.length ? resaltar(r.cmd.nombre, r.palabras) : esc(r.cmd.nombre)}</span>${r.cmd.atajo ? `<span class="b-atajo">${teclas(r.cmd.atajo)}</span>` : ""}</li>${fin}`;
      }
      const m = r.mejor;
      const donde = `<span class="b-donde">${esc(m.donde)}</span>`;
      const extracto = m.donde === "Título" ? "" : `<div class="b-frag">${fragmento(m.original, m.i, r.palabras)}</div>`;
      if (r.tipo === "tarjeta") {
        const p = proyecto(r.c.projectId);
        return `<li role="option" class="b-item ${i === seleccion ? "on" : ""}" data-i="${i}" aria-selected="${i === seleccion}">
          <div class="b-tit">${p ? `<i class="tab-dot" style="--h:${tono(p.id)}" title="${esc(p.name)}"></i>` : ""}<span class="b-txt">${resaltar(r.c.title, r.palabras)}</span><span class="b-col">${r.c.archivedAt ? "🗄 archivada" : COLUMNA[r.c.column]}</span></div>${donde}${extracto}</li>`;
      }
      if (r.tipo === "pregunta") return `<li role="option" class="b-item ${i === seleccion ? "on" : ""}" data-i="${i}"><div class="b-tit">💬 <span class="b-txt">${resaltar(r.q.text.slice(0, 120), r.palabras)}</span></div>${donde}${m.donde === "Pregunta" ? "" : `<div class="b-frag">${fragmento(m.original, m.i, r.palabras)}</div>`}</li>`;
      return `<li role="option" class="b-item ${i === seleccion ? "on" : ""}" data-i="${i}"><div class="b-tit">${fileIcon(r.f)} <span class="b-txt">${resaltar(r.f, r.palabras)}</span></div>${donde}</li>`;
    })
    .join("") || (consulta.trim() ? `<li class="b-vacio">Nada coincide con «${esc(consulta.trim().replace(/^>\s*/, ""))}»</li>` : `<li class="b-vacio">Escribe para buscar en todo el tablero, también en lo archivado.</li>`);
  const res = encontrados.length - cmds.length;
  $("#buscarPie").innerHTML = consulta.trim() && !soloComandos
    ? `${res >= 60 ? "60+" : res} resultado${res === 1 ? "" : "s"}${cmds.length ? ` y ${cmds.length} comando${cmds.length === 1 ? "" : "s"}` : ""} · ${ms < 1 ? "<1" : Math.round(ms)} ms · <kbd>↑</kbd><kbd>↓</kbd> elegir · <kbd>↵</kbd> abrir`
    : `<kbd>↑</kbd><kbd>↓</kbd> elegir · <kbd>↵</kbd> ejecutar · empieza con <kbd>&gt;</kbd> para ver solo comandos · <button class="b-link" id="verAtajosBtn">atajos de teclado</button>`;
  $("#verAtajosBtn")?.addEventListener("click", () => mostrarAtajos());
  for (const li of document.querySelectorAll("#buscarLista [data-i]")) li.onclick = () => abrirResultado(Number(li.dataset.i));
  $("#buscarLista .on")?.scrollIntoView({ block: "nearest" });
}

function abrirResultado(i) {
  const r = encontrados[i];
  if (!r) return;
  if (r.tipo === "comando") {
    if (r.cmd.id === "atajos") return mostrarAtajos();
    cerrarBusqueda();
    return r.cmd.hacer();
  }
  cerrarBusqueda();
  if (r.tipo === "tarjeta") {
    // Si la tarjeta es de otro proyecto, se abre su pestaña
    if (!r.c.archivedAt && !deFiltro(state.filtro, r.c)) elegirFiltro(r.c.projectId);
    openDrawer(r.c.id);
  } else if (r.tipo === "pregunta") openPreguntas();
  else openFile(r.f);
}

function abrirBusqueda() {
  $("#buscador").hidden = false;
  const i = $("#buscarInput");
  i.value = "";
  seleccion = 0;
  verAtajos = false;
  pintarBusqueda();
  i.focus();
}
function cerrarBusqueda() {
  $("#buscador").hidden = true;
  $("#buscarInput").blur();
}

let esperaBusqueda;
$("#buscarInput").oninput = () => {
  seleccion = 0;
  verAtajos = false;
  clearTimeout(esperaBusqueda);
  esperaBusqueda = setTimeout(pintarBusqueda, 40);
};
$("#buscarInput").onkeydown = (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    seleccion = Math.max(0, Math.min(encontrados.length - 1, seleccion + (e.key === "ArrowDown" ? 1 : -1)));
    for (const li of document.querySelectorAll("#buscarLista [data-i]")) li.classList.toggle("on", Number(li.dataset.i) === seleccion);
    $("#buscarLista .on")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(esperaBusqueda);
    pintarBusqueda();
    abrirResultado(seleccion);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (verAtajos) {
      verAtajos = false;
      return pintarBusqueda(); // Esc en los atajos vuelve a la paleta
    }
    cerrarBusqueda();
  }
};
$("#buscador").onclick = (e) => {
  if (e.target === $("#buscador")) cerrarBusqueda();
};
$("#searchBtn").onclick = abrirBusqueda;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#buscador").hidden ? abrirBusqueda() : cerrarBusqueda();
  }
});

// ---------------------------------------------------------------------------
// Paleta de comandos: lo mismo que con el ratón, desde ⌘K y solo con el teclado
// ---------------------------------------------------------------------------

const COLUMNAS = [["backlog", "Ideas"], ["doing", "En curso"], ["review", "Para revisar"], ["done", "Hecho"]];
const teclas = (a) => a.split(" ").map((k) => `<kbd>${esc(k)}</kbd>`).join("");

// Los comandos dependen de lo que hay delante: la tarjeta abierta, el proyecto, lo hecho…
// Tema: automático (el del sistema) → claro → oscuro. La lógica vive en tema.js, que se carga antes de pintar.
const TEMAS = { auto: ["◐", "Auto", "el del sistema"], light: ["☀", "Claro", "claro"], dark: ["☾", "Oscuro", "oscuro"] };
function pintarTema() {
  const t = window.temaOrbita?.leer() || "auto";
  $("#temaIcono").textContent = TEMAS[t][0];
  $("#temaTexto").textContent = ` ${TEMAS[t][1]}`;
  $("#temaBtn").title = `Tema: ${TEMAS[t][2]} (pulsa para cambiar)`;
}
function ponerTema(t) {
  window.temaOrbita?.poner(t);
  pintarTema();
  toast(`Tema ${TEMAS[t][2]}`);
}
$("#temaBtn").onclick = () => {
  const orden = ["auto", "light", "dark"];
  ponerTema(orden[(orden.indexOf(window.temaOrbita?.leer() || "auto") + 1) % orden.length]);
};
pintarTema();

function comandos() {
  const lista = [];
  const add = (id, icono, nombre, hacer, atajo = "", claves = "") => lista.push({ id, icono, nombre, hacer, atajo, claves });
  const c = state.openId && state.view === "card" && $("#drawer").classList.contains("on") ? state.cards.get(state.openId) : null;
  if (c && !c.archivedAt) {
    const t = corto(c.title, 40);
    for (const [col, nombre] of COLUMNAS)
      if (col !== c.column) add(`mover-${col}`, "→", `Mover «${t}» a ${nombre}`, () => move(c.id, col), "", "mover tarjeta columna");
    add("subir", "↑", `Subir «${t}» en la columna`, () => desplazar(c.id, -1), "Alt ↑", "orden arriba");
    add("bajar", "↓", `Bajar «${t}» en la columna`, () => desplazar(c.id, +1), "Alt ↓", "orden abajo");
    if (c.column === "done")
      add("archivar-esta", "🗄", `Archivar «${t}»`, async () => {
        try {
          await api("/api/archive", { ids: [c.id] });
          closeDrawer();
          toast("🗄 Tarjeta archivada", false, { texto: "Deshacer", accion: () => api(`/api/cards/${c.id}/unarchive`, {}) });
        } catch (err) {
          toast(err.message, true);
        }
      });
    if (c.result) {
      add("copiar", "⧉", "Copiar el resultado (Markdown)", () => exportar(c.id, "copiar"), "", "exportar");
      add("pagina", "↗", "Abrir el resultado como página", () => exportar(c.id, "pagina"), "", "exportar compartir");
      add("md", "⤓", "Descargar el resultado (.md)", () => exportar(c.id, "md"), "", "exportar markdown");
      add("pdf", "⎙", "Guardar el resultado como PDF", () => exportar(c.id, "pdf"), "", "exportar imprimir");
    }
    add("cerrar", "✕", "Cerrar la tarjeta", closeDrawer, "Esc");
  }
  add("nueva", "＋", "Nueva tarjeta", () => $("#addBtn").click(), "N", "crear añadir");
  for (const [t, [icono, , nombre]] of Object.entries(TEMAS)) if (t !== (window.temaOrbita?.leer() || "auto")) add(`tema-${t}`, icono, `Tema ${nombre}`, () => ponerTema(t), "", "modo claro oscuro apariencia tema");
  add("objetivo", "🎯", "Planificar un objetivo", () => {
    if (modoBarra !== "planificar") $('.modo [data-modo="planificar"]')?.click();
    $("#goalInput").focus();
  }, "/", "crear proyecto plan");
  add("pregunta", "💬", "Pregunta rápida a la IA", openPreguntas, "?", "preguntar");
  for (const pl of state.plantillas || []) add(`plantilla-${pl.id}`, pl.icono || "⧉", `Nueva desde plantilla: ${pl.nombre}`, () => abrirNueva(pl.id), "", "plantilla crear tarjeta nueva");
  if (c) add("como-plantilla", "⧉", `Guardar «${corto(c.title, 30)}» como plantilla`, () => guardarComoPlantilla(c.id, c.title.slice(0, 60)), "", "plantilla");
  const hechas = [...state.cards.values()].filter((x) => visible(x) && x.column === "done").length;
  if (hechas && state.seccion === "tablero") add("archivar-hechas", "🗄", `Archivar las ${hechas} tarjeta${hechas === 1 ? "" : "s"} hecha${hechas === 1 ? "" : "s"}`, () => $("#archiveDone").click(), "", "limpiar");
  for (const [id, nombre] of SECCIONES(state.filtro))
    if (id !== state.seccion) add(`seccion-${id}`, "▤", `Abrir ${nombre}`, () => $(`#subnav [data-s="${id}"]`)?.click(), "", id === "ajustes" ? "ajustes configuración instrucciones memoria secretos claves api" : "sección");
  for (const p of state.projects) if (p.id !== state.filtro) add(`ir-${p.id}`, "⇥", `Ir a «${p.name}»`, () => elegirFiltro(p.id), "", "proyecto pestaña cambiar");
  const actual = proyecto(state.filtro);
  if (actual && !actual.pausado) add("pausar", "⏸", `Pausar «${actual.name}»`, () => pausarProyecto(actual.id, true), "", "pausa detener parar prioridad");
  if (actual && actual.pausado) add("reanudar", "▶", `Reanudar «${actual.name}»`, () => pausarProyecto(actual.id, false), "", "play continuar seguir");
  if (actual && state.projects.some((x) => x.id !== actual.id && !x.pausado)) add("solo", "▶", `Trabajar solo en «${actual.name}» (pausar los demás)`, () => soloEste(actual.id), "", "prioridad pausa play foco");
  if (state.projects.some((x) => x.pausado)) add("reanudar-todos", "▶", "Reanudar todos los proyectos", reanudarTodos, "", "play continuar pausa");
  add("proyecto-nuevo", "＋", "Nuevo proyecto", () => setTimeout(() => $("#tabNew").click()), "", "crear pestaña");
  add("conectar", "◉", "Conectar una IA", openConnect, "", "mcp cerebro");
  add("atajos", "⌨", "Atajos de teclado", null, "", "teclado ayuda");
  add("cerrar-orbita", "⏻", "Cerrar Órbita", cerrarOrbita, "", "salir apagar detener servidor quit");
  return lista;
}

function buscarComandos(consulta, todos) {
  const palabras = sinTildes(consulta).split(/\s+/).filter(Boolean);
  const lista = comandos();
  let res;
  if (!palabras.length) res = (todos ? lista : lista.slice(0, 8)).map((cmd) => ({ tipo: "comando", cmd, palabras }));
  else
    res = lista
      .map((cmd) => {
        const nombre = sinTildes(cmd.nombre);
        const texto = nombre + " " + sinTildes(cmd.claves);
        if (!palabras.every((p) => texto.includes(p))) return null;
        const puntos = palabras.reduce((s, p) => s + (nombre.includes(p) ? 2 : 1) + (new RegExp(`(^|[\\s«])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(nombre) ? 2 : 0), 0);
        return { tipo: "comando", cmd, palabras, puntos };
      })
      .filter(Boolean)
      .sort((a, b) => b.puntos - a.puntos)
      .slice(0, todos ? 50 : 5);
  if (res.length) res[res.length - 1].ultimo = true;
  return res;
}

// Lista de atajos, dentro de la misma paleta
let verAtajos = false;
const ATAJOS = [
  ["⌘ K", "Paleta de comandos y búsqueda (Ctrl K en Windows y Linux)"],
  ["N", "Nueva tarjeta"],
  ["/", "Escribir un objetivo para planificar"],
  ["?", "Pregunta rápida a la IA"],
  ["Alt ↑", "Subir la tarjeta abierta en su columna"],
  ["Alt ↓", "Bajar la tarjeta abierta en su columna"],
  ["⌘ ↵", "Enviar el mensaje en la conversación de una tarjeta"],
  ["↑ ↓ ↵", "Elegir y ejecutar en la paleta"],
  ["> …", "En la paleta: solo comandos"],
  ["Esc", "Cerrar la paleta, la tarjeta o un aviso"],
  ["clic", "En una imagen: verla en grande (← → para pasar, C para copiarla)"],
];
function mostrarAtajos() {
  verAtajos = true;
  $("#buscarInput").value = "";
  pintarAtajos();
  $("#buscarInput").focus();
}
function pintarAtajos() {
  encontrados = [];
  $("#buscarLista").innerHTML = `<li class="b-grupo">Atajos de teclado</li>` + ATAJOS.map(([k, que]) => `<li class="b-atajo-fila"><span class="b-atajo">${teclas(k)}</span><span>${esc(que)}</span></li>`).join("");
  $("#buscarPie").innerHTML = "<kbd>Esc</kbd> volver a la paleta · escribe para buscar";
}


// ---------------------------------------------------------------------------
// Copiar, descargar .md, abrir como página y PDF (de la versión que se está viendo)
// ---------------------------------------------------------------------------

// Los criterios de la versión que se exporta (o los actuales), como lista de comprobación
function criteriosMd(c, v) {
  const cr = v.criterios || (v.n == null || v.n === c.versions?.at(-1)?.n ? c.criterios : null) || [];
  if (!cr.length) return "";
  return `**Terminado cuando…** (${cr.filter((x) => x.estado === "cumple").length}/${cr.length} ✓)\n\n${cr.map((x) => `- ${x.estado === "cumple" ? "✅" : x.estado === "no" ? "❌" : "⬜"} ${x.texto}${x.evidencia ? ` — ${x.evidencia.replace(/\n+/g, " ")}` : ""}`).join("\n")}\n\n---\n\n`;
}

function versionVista(c) {
  const vs = c.versions || [];
  const i = state.verVersion == null ? vs.length - 1 : Math.min(state.verVersion, vs.length - 1);
  return i >= 0 ? vs[i] : { n: null, result: c.result, t: c.updatedAt, quien: c.worker };
}
const nombreArchivo = (t) => sinTildes(t).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "resultado";
const fechaLarga = (t) => new Date(t).toLocaleString([], { dateStyle: "long", timeStyle: "short" });

// Las imágenes de Órbita (/files/…) se meten dentro del .md como datos, para que se vean en cualquier sitio
async function incrustarImagenes(markdown) {
  const rutas = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\((\/files\/[^)\s]+)\)/g)].map((m) => m[1]))];
  for (const ruta of rutas) {
    try {
      const blob = await (await fetch(ruta)).blob();
      const datos = await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.readAsDataURL(blob);
      });
      markdown = markdown.split(`(${ruta})`).join(`(${datos})`);
    } catch {}
  }
  return markdown;
}

function paginaHTML(c, v) {
  const p = proyecto(c.projectId);
  const cuerpo = md(criteriosMd(c, v) + v.result).replace(/(src|href)="\/files\//g, `$1="${location.origin}/files/`); // rutas completas: la página vive fuera de Órbita
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>
  body { margin: 0; background: #f6f6f9; color: #1d1d27; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 64px; background: #fff; min-height: 100vh; box-sizing: border-box; }
  header { border-bottom: 1px solid #e6e6ee; padding-bottom: 18px; margin-bottom: 26px; }
  header h1 { font-size: 28px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -.01em; }
  .meta { color: #6b6b80; font-size: 13.5px; }
  h1, h2, h3 { line-height: 1.3; } h2 { font-size: 21px; margin-top: 30px; } h3 { font-size: 17px; }
  a { color: #5b4bdb; } img { max-width: 100%; height: auto; border-radius: 10px; border: 1px solid #e6e6ee; }
  pre { background: #f3f3f8; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 13.5px; }
  code { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; } th, td { border: 1px solid #dcdce6; padding: 7px 10px; text-align: left; } th { background: #f3f3f8; }
  blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid #c4b5fd; color: #4b4b5c; }
  footer { margin-top: 40px; color: #9a9aac; font-size: 12px; }
  @media print { body { background: #fff; } main { padding: 0; min-height: 0; } a { color: inherit; } }
</style></head><body><main>
<header><h1>${esc(c.title)}</h1><div class="meta">${p ? `${esc(p.name)} · ` : ""}${v.n ? `Versión ${v.n} · ` : ""}${esc(v.quien || "")}${v.quien ? " · " : ""}${fechaLarga(v.t || Date.now())}</div></header>
${cuerpo}
<footer>Exportado desde Órbita</footer>
</main></body></html>`;
}

async function exportar(id, como) {
  const c = state.cards.get(id);
  if (!c) return;
  const v = versionVista(c);
  try {
    if (como === "copiar") {
      await navigator.clipboard.writeText(v.result);
      return toast(`Resultado${v.n ? ` (versión ${v.n})` : ""} copiado en Markdown ✓`);
    }
    if (como === "md") {
      const texto = `# ${c.title}\n\n_${v.n ? `Versión ${v.n} · ` : ""}${fechaLarga(v.t || Date.now())}_\n\n${criteriosMd(c, v)}${await incrustarImagenes(v.result)}\n`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([texto], { type: "text/markdown;charset=utf-8" }));
      a.download = `${nombreArchivo(c.title)}${v.n ? `-v${v.n}` : ""}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return toast(`Descargado ${a.download}`);
    }
    // Página (y PDF: la misma página, con el diálogo de imprimir para «Guardar como PDF»)
    const url = URL.createObjectURL(new Blob([paginaHTML(c, v)], { type: "text/html;charset=utf-8" }));
    const w = window.open(url, "_blank");
    if (!w) toast("El navegador bloqueó la ventana nueva: permite las ventanas emergentes de Órbita", true);
    else if (como === "pdf") {
      // Se imprime desde aquí: la página hereda la política de seguridad de Órbita, que no deja ejecutar scripts dentro de ella
      w.addEventListener("load", () => setTimeout(() => w.print(), 400));
      toast("En el diálogo de imprimir, elige «Guardar como PDF»");
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (err) {
    toast(err.message || "No se pudo exportar", true);
  }
}


// ---------------------------------------------------------------------------
// Visor de imágenes: tocar una imagen la amplía, con copiar, descargar y ← →
// ---------------------------------------------------------------------------

const visor = { lista: [], i: 0 };
const ZONAS_IMG = ".result, .file-view, .msg .txt, #page";

function abrirVisor(img) {
  const zona = img.closest(".d-section, #page") || document.body;
  visor.lista = [...zona.querySelectorAll("img")].filter((x) => x.closest(ZONAS_IMG) && !x.closest("button, a.btn"));
  visor.i = Math.max(0, visor.lista.indexOf(img));
  $("#visor").hidden = false;
  pintarVisor();
}
function pintarVisor() {
  const img = visor.lista[visor.i];
  if (!img) return cerrarVisor();
  const url = img.currentSrc || img.src;
  const nombre = img.alt || decodeURIComponent(url.split("/").pop().split("?")[0]) || "imagen";
  $("#visorImg").style.width = $("#visorImg").style.height = "";
  $("#visorImg").src = url;
  $("#visorImg").alt = nombre;
  $("#visorLienzo").classList.remove("real");
  $("#visorNombre").textContent = nombre;
  const varias = visor.lista.length > 1;
  $("#visorCuenta").textContent = varias ? `${visor.i + 1} de ${visor.lista.length}` : "";
  $("#visorAnt").hidden = $("#visorSig").hidden = !varias;
  $("#visorAnt").disabled = visor.i === 0;
  $("#visorSig").disabled = visor.i === visor.lista.length - 1;
  $("#visorBajar").href = url;
  $("#visorBajar").download = /^data:/.test(url) ? "imagen.png" : decodeURIComponent(url.split("/").pop().split("?")[0]);
  $("#visorOriginal").href = url;
}
function cerrarVisor() {
  $("#visor").hidden = true;
  $("#visorImg").removeAttribute("src");
}
const pasarVisor = (paso) => {
  const j = visor.i + paso;
  if (j >= 0 && j < visor.lista.length) (visor.i = j), pintarVisor();
};

// El portapapeles solo acepta PNG: las demás se convierten
async function comoPNG(url) {
  const blob = await (await fetch(url)).blob();
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const lienzo = document.createElement("canvas");
  lienzo.width = bmp.width;
  lienzo.height = bmp.height;
  lienzo.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo convertir la imagen"))), "image/png"));
}
async function copiarImagen() {
  const url = $("#visorImg").src;
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("sin soporte");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": comoPNG(url) })]); // la promesa directa: así funciona también en Safari
    toast("Imagen copiada ✓ Pégala donde quieras");
  } catch {
    try {
      await navigator.clipboard.writeText(new URL(url, location.href).href);
      toast("Este navegador no deja copiar imágenes: copié el enlace", true);
    } catch {
      toast("No se pudo copiar la imagen. Usa «Descargar»", true);
    }
  }
}

document.addEventListener("click", (e) => {
  const img = e.target.closest?.("img");
  if (!img || !$("#visor").hidden || img.closest("#visor, button, a.btn") || !img.closest(ZONAS_IMG)) return;
  e.preventDefault(); // dentro de un enlace, ampliar en vez de navegar
  abrirVisor(img);
});
$("#visorCerrar").onclick = cerrarVisor;
$("#visorCopiar").onclick = copiarImagen;
$("#visorAnt").onclick = () => pasarVisor(-1);
$("#visorSig").onclick = () => pasarVisor(+1);
$("#visorImg").onclick = (e) => {
  e.stopPropagation();
  $("#visorLienzo").classList.toggle("real"); // tamaño real ↔ ajustada a la pantalla
  ajustarVisor();
};
// Ajustada: lo más grande que quepa en la pantalla (también agranda las pequeñas, hasta 3×)
function ajustarVisor() {
  const img = $("#visorImg");
  const lienzo = $("#visorLienzo");
  if (!img.naturalWidth) return;
  if (lienzo.classList.contains("real")) return (img.style.width = img.style.height = "");
  const cs = getComputedStyle(lienzo);
  const anchoLibre = lienzo.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const altoLibre = lienzo.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const escala = Math.min(anchoLibre / img.naturalWidth, altoLibre / img.naturalHeight, 3);
  img.style.width = Math.floor(img.naturalWidth * escala) + "px";
  img.style.height = Math.floor(img.naturalHeight * escala) + "px";
}
$("#visorImg").onload = ajustarVisor;
addEventListener("resize", () => !$("#visor").hidden && ajustarVisor());
$("#visor").onclick = (e) => {
  if (e.target === $("#visor") || e.target === $("#visorLienzo")) cerrarVisor(); // sin devolver false: los enlaces (Descargar, Original) deben funcionar
};
document.addEventListener(
  "keydown",
  (e) => {
    if ($("#visor").hidden) return;
    const k = { Escape: cerrarVisor, ArrowLeft: () => pasarVisor(-1), ArrowRight: () => pasarVisor(+1), c: copiarImagen, C: copiarImagen }[e.key];
    if (!k || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation(); // que Esc no cierre también la tarjeta de debajo
    k();
  },
  true,
);


// ---------------------------------------------------------------------------
// Play / pausa por proyecto
// ---------------------------------------------------------------------------

async function pausarProyecto(id, si, silencioso = false) {
  const p = proyecto(id);
  if (!p) return;
  try {
    const nuevo = await api(`/api/projects/${id}/pausa`, { pausado: si });
    state.projects = state.projects.map((x) => (x.id === id ? { ...x, ...nuevo } : x)); // sin esperar al aviso del servidor
    renderAll();
    if (!silencioso)
      toast(si ? `⏸ «${p.name}» en pausa: la IA no tomará sus tarjetas` : `▶ «${p.name}» reanudado`, false, { texto: "Deshacer", accion: () => pausarProyecto(id, !si, true) });
  } catch (err) {
    toast(err.message, true);
  }
}
async function soloEste(id) {
  const otras = state.projects.filter((x) => x.id !== id && !x.pausado).map((x) => x.id);
  if (proyecto(id)?.pausado) await pausarProyecto(id, false, true);
  for (const o of otras) await pausarProyecto(o, true, true);
  toast(`▶ La IA trabaja solo en «${proyecto(id)?.name}» (${otras.length} en pausa)`, false, { texto: "Deshacer", accion: async () => { for (const o of otras) await pausarProyecto(o, false, true); } });
}
async function reanudarTodos() {
  const pausados = state.projects.filter((x) => x.pausado).map((x) => x.id);
  for (const o of pausados) await pausarProyecto(o, false, true);
  toast(`▶ ${pausados.length} proyecto${pausados.length === 1 ? "" : "s"} reanudado${pausados.length === 1 ? "" : "s"}`);
}


// ---------------------------------------------------------------------------
// Criterios de aceptación («Terminado cuando…») y la autorrevisión de la IA
// ---------------------------------------------------------------------------

async function guardarCriterios(id, textos) {
  try {
    upsert(await api(`/api/cards/${id}/edit`, { criterios: textos }));
  } catch (err) {
    toast(err.message, true);
  }
}

function pintarCriterios(c) {
  const cr = c.criterios || [];
  const revisados = cr.filter((x) => x.estado);
  const si = cr.filter((x) => x.estado === "cumple").length;
  $("#dCritRes").innerHTML = !cr.length ? "" : revisados.length ? `<b class="${si === cr.length ? "bien" : "medio"}">${si}/${cr.length} cumplidos</b> según ${esc(c.worker || "la IA")}` : `${cr.length} por revisar`;
  const enRevision = c.column === "review" || c.column === "done";
  $("#dCritList").innerHTML =
    cr
      .map((x) => {
        const icono = x.falla ? "✗" : x.estado === "cumple" ? "✓" : x.estado === "no" ? "✗" : "○";
        const clase = x.falla ? "mal persona" : x.estado === "cumple" ? "bien" : x.estado === "no" ? "mal" : "";
        return `<li class="crit ${clase}" data-cid="${x.id}">
          <span class="crit-ico" aria-hidden="true">${icono}</span>
          <div class="crit-cuerpo"><span class="crit-texto" title="Doble clic para editar">${esc(x.texto)}</span>
            ${x.evidencia ? `<div class="crit-evid result">${md(x.evidencia)}</div>` : ""}
            ${x.falla ? `<div class="crit-nota">Marcaste que no se cumple: la IA lo sabrá al devolverla</div>` : ""}</div>
          <span class="crit-acc">${enRevision && x.estado ? `<button class="mini" data-falla="${x.id}" title="${x.falla ? "Quitar la marca" : "Marcar que no se cumple (se le dirá a la IA al devolverla)"}">${x.falla ? "↶ Sí se cumple" : "✗ No se cumple"}</button>` : ""}<button class="icon-btn" data-quitar-crit="${x.id}" title="Quitar criterio" aria-label="Quitar criterio">✕</button></span>
        </li>`;
      })
      .join("");
  // Sin criterios, solo el campo para añadirlos (su texto de ayuda explica para qué sirven)
  $("#dCrit").classList.toggle("vacia", !cr.length);
  for (const b of document.querySelectorAll("#dCritList [data-quitar-crit]"))
    b.onclick = () => guardarCriterios(c.id, cr.filter((x) => x.id !== b.dataset.quitarCrit).map((x) => x.texto));
  for (const b of document.querySelectorAll("#dCritList [data-falla]"))
    b.onclick = async () => {
      const x = cr.find((y) => y.id === b.dataset.falla);
      try {
        upsert(await api(`/api/cards/${c.id}/criterio`, { id: x.id, falla: !x.falla }));
      } catch (err) {
        toast(err.message, true);
      }
    };
  // Doble clic: editar el texto en su sitio
  for (const t of document.querySelectorAll("#dCritList .crit-texto"))
    t.ondblclick = () => {
      const li = t.closest("li");
      const x = cr.find((y) => y.id === li.dataset.cid);
      const input = document.createElement("input");
      input.className = "crit-edit";
      input.value = x.texto;
      t.replaceWith(input);
      input.focus();
      input.select();
      let hecho = false;
      const terminar = (guardar) => {
        if (hecho) return;
        hecho = true;
        if (guardar && input.value.trim() && input.value.trim() !== x.texto) guardarCriterios(c.id, cr.map((y) => (y.id === x.id ? input.value.trim() : y.texto)));
        else pintarCriterios(state.cards.get(c.id));
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter") terminar(true);
        else if (e.key === "Escape") {
          e.stopPropagation();
          terminar(false);
        }
      };
      input.onblur = () => terminar(true);
    };
}


// ---------------------------------------------------------------------------
// Una IA por proyecto: así dos proyectos avanzan en paralelo
// ---------------------------------------------------------------------------

let iaProyecto = null;
function openIAProyecto(id) {
  iaProyecto = id;
  state.openId = null;
  state.view = "ia";
  $("#drawerBody").innerHTML = "";
  pintarIAProyecto(true);
  showDrawer();
}
function instruccionIA(p, nombre) {
  return `Sé la IA del proyecto «${p.name}» en mi tablero Órbita. Usa el servidor MCP "orbita" con worker "${nombre}" y llama a wait_for_work con project "${p.id}" una y otra vez: trabaja cada tarjeta que te llegue (report_progress cada 2-3 minutos, submit_result con criteria si los trae) y vuelve a esperar, sin pedirme confirmación entre tarjetas. Lo que necesites de mí, pregúntamelo en Órbita (ask_human o en el resultado), no en este chat.`;
}
function pintarIAProyecto(forzar = false) {
  const p = proyecto(iaProyecto);
  if (!p) return closeDrawer();
  const sugerido = p.ia || `Claude · ${corto(p.name, 24)}`;
  const b = p.ia && state.brains.find((x) => x.name === p.ia);
  const otras = state.brains.filter((x) => x.name !== p.ia);
  const estado = !p.ia
    ? `<div class="brain-now">Ahora la trabaja cualquier IA conectada${otras.length ? ` (${otras.map((x) => esc(x.name)).join(", ")})` : ""}, de una tarjeta en una y junto con los demás proyectos.</div>`
    : b
      ? `<div class="brain-now on"><i class="ia-dot ${b.listening ? "on" : "trab"}"></i> <b>${esc(p.ia)}</b> ${b.listening ? "está conectada y escuchando" : b.tarjeta ? `está trabajando en «${esc(b.tarjeta)}»` : "está conectada"}</div>`
      : `<div class="brain-now warn"><i class="ia-dot off"></i> <b>${esc(p.ia)}</b> no está conectada: las tarjetas de este proyecto esperarán a que la lances (paso 2).</div>`;
  // Si ya está abierto, solo se actualiza el estado (no se pierde lo que estés escribiendo)
  if (!forzar && $("#iaForm") && $("#drawerBody").dataset.ia === p.id) return void ($("#iaEstado").innerHTML = estado);
  const cuerpo = `
    <div class="d-head"><div class="t">🧠 La IA de «${esc(p.name)}»</div><button class="icon-btn" id="dClose">✕</button></div>
    <p class="sub" style="margin:6px 0 10px;font-size:13px">Con su propia IA, este proyecto <b>avanza en paralelo</b> a los demás: esa IA solo trabaja aquí, y las demás IAs no tocan sus tarjetas ni sus preguntas.</p>
    <div id="iaEstado">${estado}</div>
    <div class="d-section"><h4>1 · Su nombre</h4>
      <form class="ia-form" id="iaForm"><input id="iaNombre" value="${esc(sugerido)}" maxlength="60" autocomplete="off" /><button class="btn primary">${p.ia ? "Guardar" : "Asignar"}</button>${p.ia ? `<button type="button" class="btn" id="iaQuitar">Quitar (volver a compartida)</button>` : ""}</form>
    </div>
    <div class="d-section"><h4>2 · Lánzala en otra sesión de Claude</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">Abre una <b>sesión nueva</b> de Claude Code (o de cualquier IA con el MCP «orbita») y pégale esto. Cada proyecto, en su sesión: así trabajan a la vez.</p>
      <div class="snippet"><pre id="iaInstruccion">${esc(instruccionIA(p, sugerido))}</pre><button class="btn" id="iaCopiar">Copiar</button></div>
      <p class="sub" style="margin:10px 0 0;font-size:12.5px">En Claude Code también vale el comando <code>/mcp__orbita__trabajar</code> con nombre <code>${esc(sugerido)}</code> y proyecto <code>${esc(p.id)}</code>.</p>
    </div>`;
  $("#drawerBody").innerHTML = cuerpo;
  $("#drawerBody").dataset.ia = p.id;
  $("#dClose").onclick = closeDrawer;
  $("#iaNombre").oninput = () => ($("#iaInstruccion").textContent = instruccionIA(p, $("#iaNombre").value.trim() || sugerido));
  $("#iaForm").onsubmit = async (e) => {
    e.preventDefault();
    const nombre = $("#iaNombre").value.trim();
    if (!nombre) return;
    try {
      const nuevo = await api(`/api/projects/${p.id}/ia`, { ia: nombre });
      state.projects = state.projects.map((x) => (x.id === p.id ? { ...x, ...nuevo } : x));
      renderAll();
      pintarIAProyecto(true);
      toast(`🧠 «${nombre}» es ahora la IA de «${p.name}»`);
    } catch (err) {
      toast(err.message, true);
    }
  };
  if ($("#iaQuitar"))
    $("#iaQuitar").onclick = async () => {
      try {
        const nuevo = await api(`/api/projects/${p.id}/ia`, { ia: null });
        state.projects = state.projects.map((x) => (x.id === p.id ? { ...x, ...nuevo } : x));
        renderAll();
        pintarIAProyecto(true);
        toast("El proyecto vuelve a ser de cualquier IA");
      } catch (err) {
        toast(err.message, true);
      }
    };
  $("#iaCopiar").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#iaInstruccion").textContent);
      toast("Copiado ✓ Pégalo en una sesión nueva de Claude");
    } catch {
      toast("No se pudo copiar; selecciónalo a mano", true);
    }
  };
}


// ---------------------------------------------------------------------------
// La IA de preguntas: una instancia aparte que solo responde preguntas rápidas
// ---------------------------------------------------------------------------

function instruccionPreguntas(nombre) {
  return `Sé la IA de preguntas rápidas de mi tablero Órbita. Usa el servidor MCP "orbita" con worker "${nombre}" y llama a wait_for_work con solo: "preguntas" una y otra vez: responde cada pregunta al momento con answer_question (breve, en Markdown; si trae proyecto, usa su contexto) y vuelve a esperar, sin pedirme confirmación.`;
}
function pintarIAPreguntas() {
  const caja = $("#qaIA");
  if (!caja) return;
  const ia = state.preguntasIA;
  const b = ia && state.brains.find((x) => x.name === ia);
  const abierto = caja.querySelector("details")?.open;
  const nombreEscrito = $("#qaIANombre")?.value;
  const escribiendo = document.activeElement?.id === "qaIANombre";
  const estado = !ia
    ? `<span class="ia-dot off"></span>Sin IA propia: las responde la IA que esté libre, entre tarjeta y tarjeta.`
    : b
      ? (() => {
          const respondiendo = (state.questions || []).some((q) => q.status === "respondiendo" && q.worker === ia);
          return `<span class="ia-dot ${b.listening ? "on" : "trab"}"></span><b>${esc(ia)}</b> ${b.listening ? "está escuchando: responde al momento" : respondiendo ? "está respondiendo" : "está conectada"}`;
        })()
      : `<span class="ia-dot off"></span><b>${esc(ia)}</b> no está conectada: mientras tanto las responde otra IA`;
  // Si estás escribiendo el nombre, solo se actualiza la línea de estado
  if (escribiendo && caja.querySelector(".qa-ia-estado")) return void (caja.querySelector(".qa-ia-estado").innerHTML = estado);
  const nombre = nombreEscrito || ia || "Claude · Preguntas";
  caja.innerHTML = `
    <div class="qa-ia-estado">${estado}</div>
    <details${abierto ? " open" : ""}><summary>${ia ? "Cambiar o lanzar la IA de preguntas" : "🧠 Darles su propia IA (responde al momento, sin parar a las demás)"}</summary>
      <form class="ia-form" id="qaIAForm"><input id="qaIANombre" value="${esc(nombre)}" maxlength="60" autocomplete="off" /><button class="btn primary">${ia ? "Guardar" : "Asignar"}</button>${ia ? `<button type="button" class="btn" id="qaIAQuitar">Quitar</button>` : ""}</form>
      <p class="sub" style="margin:8px 0 6px;font-size:12.5px">Lánzala en una <b>sesión nueva</b> de Claude pegando esto:</p>
      <div class="snippet"><pre id="qaIAInstr">${esc(instruccionPreguntas(nombre))}</pre><button class="btn" type="button" id="qaIACopiar">Copiar</button></div>
    </details>`;
  $("#qaIANombre").oninput = () => ($("#qaIAInstr").textContent = instruccionPreguntas($("#qaIANombre").value.trim() || "Claude · Preguntas"));
  const guardar = async (valor) => {
    try {
      const r = await api("/api/preguntas/ia", { ia: valor });
      state.preguntasIA = r.preguntasIA;
      $("#qaIA").innerHTML = "";
      pintarIAPreguntas();
      toast(valor ? `🧠 «${valor}» es la IA de preguntas` : "Las preguntas vuelven a responderlas las IAs libres");
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#qaIAForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("#qaIANombre").value.trim();
    if (v) guardar(v);
  };
  if ($("#qaIAQuitar")) $("#qaIAQuitar").onclick = () => guardar(null);
  $("#qaIACopiar").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#qaIAInstr").textContent);
      toast("Copiado ✓ Pégalo en una sesión nueva de Claude");
    } catch {
      toast("No se pudo copiar; selecciónalo a mano", true);
    }
  };
}


// ---------------------------------------------------------------------------
// Tareas programadas y recurrentes
// ---------------------------------------------------------------------------

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const fechaProg = (t) => (t ? new Date(t).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "");
function resumenPrograma(pg) {
  const hora = pg.hora.replace(/^0/, "");
  if (pg.tipo === "una") return `${new Date(pg.proxima).toLocaleDateString([], { day: "numeric", month: "short" })} ${hora}`;
  if (pg.tipo === "diaria") return `cada día ${hora}`;
  if (pg.tipo === "semanal") return `${pg.dias.length === 7 ? "cada día" : pg.dias.length === 5 && !pg.dias.includes(0) && !pg.dias.includes(6) ? "lun a vie" : [1, 2, 3, 4, 5, 6, 0].filter((d) => pg.dias.includes(d)).map((d) => DIAS[d]).join(", ")} ${hora}`;
  return `día ${pg.diaMes} ${hora}`;
}

function leerPrograma() {
  const tipo = $("#dProgTipo").value;
  if (!tipo) return null;
  const pg = { tipo, hora: $("#dProgHora").value || "09:00" };
  if (tipo === "una") pg.fecha = $("#dProgFecha").value;
  if (tipo === "semanal") pg.dias = [...document.querySelectorAll('#dProgDias .dia[aria-pressed="true"]')].map((b) => Number(b.dataset.dia));
  if (tipo === "mensual") pg.diaMes = Number($("#dProgDiaMes").value) || 1;
  return pg;
}
function mostrarCamposPrograma(tipo) {
  $("#dProgFecha").hidden = tipo !== "una";
  $("#dProgDias").hidden = tipo !== "semanal";
  $("#dProgDiaMesL").hidden = tipo !== "mensual";
  $("#dProgHoraL").hidden = !tipo;
}
async function guardarPrograma(id) {
  const pg = leerPrograma();
  mostrarCamposPrograma(pg?.tipo || "");
  // Valores por defecto razonables al elegir un tipo nuevo
  if (pg?.tipo === "una" && !pg.fecha) {
    const manana = new Date(Date.now() + 86_400_000);
    $("#dProgFecha").value = `${manana.getFullYear()}-${String(manana.getMonth() + 1).padStart(2, "0")}-${String(manana.getDate()).padStart(2, "0")}`;
    pg.fecha = $("#dProgFecha").value;
  }
  if (pg?.tipo === "semanal" && !pg.dias.length) {
    const hoy = new Date().getDay();
    document.querySelector(`#dProgDias .dia[data-dia="${hoy}"]`)?.setAttribute("aria-pressed", "true");
    pg.dias = [hoy];
  }
  try {
    const card = await api(`/api/cards/${id}/programa`, { programa: pg });
    upsert(card);
    if (card.programa) toast(`${card.programa.tipo === "una" ? "⏰ Programada" : "🔁 Se repetirá"}: próxima, ${fechaProg(card.programa.proxima)}`);
  } catch (err) {
    toast(err.message, true);
    pintarPrograma(state.cards.get(id), true);
  }
}
function pintarPrograma(c, forzar = false) {
  if (!$("#dProg")) return;
  const pg = c.programa;
  $("#dProgProx").innerHTML = pg
    ? `· próxima: <b>${esc(fechaProg(pg.proxima))}</b>${pg.ultima ? ` · última: ${esc(new Date(pg.ultima).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}` : ""}`
    : c.origin === "programada"
      ? "· esta tarjeta la creó una tarea programada"
      : "";
  // No pisar lo que estás tocando
  if (!forzar && document.activeElement?.closest?.("#dProg")) return;
  $("#dProgTipo").value = pg?.tipo || "";
  if (pg) {
    $("#dProgHora").value = pg.hora.padStart(5, "0");
    if (pg.fecha) $("#dProgFecha").value = pg.fecha;
    if (pg.diaMes) $("#dProgDiaMes").value = pg.diaMes;
    for (const b of document.querySelectorAll("#dProgDias .dia")) b.setAttribute("aria-pressed", String((pg.dias || []).includes(Number(b.dataset.dia))));
  }
  mostrarCamposPrograma(pg?.tipo || "");
}


// ---------------------------------------------------------------------------
// Plantillas de tarjetas: {campos} para rellenar, de serie y las tuyas
// ---------------------------------------------------------------------------

const camposDePlantilla = (p) => [...new Set([p.titulo, p.descripcion, ...(p.criterios || [])].join("\n").match(/\{[^{}\n]{1,40}\}/g) || [])].map((x) => x.slice(1, -1));
function pintarPlantillas() {
  const lista = state.plantillas || [];
  $("#newPlantillas").innerHTML = lista.length
    ? `<span class="pl-titulo">Desde plantilla:</span>${lista
        .map((p) => `<span class="pl ${dlg.dataset.plantilla === p.id ? "on" : ""}"><button type="button" class="pl-usar" data-pl="${p.id}" title="${esc(p.titulo)}">${p.icono || "⧉"} ${esc(p.nombre)}</button>${p.serie ? "" : `<button type="button" class="pl-borrar" data-pl-borrar="${p.id}" title="Borrar plantilla" aria-label="Borrar plantilla ${esc(p.nombre)}">✕</button>`}</span>`)
        .join("")}`
    : "";
  for (const b of document.querySelectorAll("[data-pl]")) b.onclick = () => aplicarPlantilla(b.dataset.pl);
  for (const b of document.querySelectorAll("[data-pl-borrar]"))
    b.onclick = async () => {
      try {
        await api(`/api/plantillas/${b.dataset.plBorrar}`, undefined, "DELETE");
        state.plantillas = state.plantillas.filter((x) => x.id !== b.dataset.plBorrar);
        pintarPlantillas();
        toast("Plantilla borrada");
      } catch (err) {
        toast(err.message, true);
      }
    };
}
function aplicarPlantilla(id) {
  const p = (state.plantillas || []).find((x) => x.id === id);
  if (!p) return;
  dlg.dataset.plantilla = id;
  pintarPlantillas();
  const f = $("#newForm");
  const campos = camposDePlantilla(p);
  $("#newCampos").hidden = !campos.length;
  $("#newCampos").innerHTML = campos.map((c) => `<label class="campo">${esc(c)} <input data-campo="${esc(c)}" autocomplete="off" placeholder="${esc(c)}…" /></label>`).join("");
  const rellenar = () => {
    const valores = Object.fromEntries([...document.querySelectorAll("#newCampos input")].map((i) => [i.dataset.campo, i.value.trim()]));
    const poner = (t) => String(t || "").replace(/\{([^{}\n]{1,40})\}/g, (m, c) => valores[c] || m);
    f.title.value = poner(p.titulo);
    f.description.value = poner(p.descripcion);
    f.criterios.value = (p.criterios || []).map(poner).join("\n");
  };
  for (const i of document.querySelectorAll("#newCampos input")) i.oninput = rellenar;
  rellenar();
  if (p.projectId && proyecto(p.projectId)) $("#newProject").value = p.projectId;
  (document.querySelector("#newCampos input") || $('#newForm button[value="ok"]')).focus();
}
async function guardarComoPlantilla(id, nombre) {
  try {
    const p = await api("/api/plantillas", { desde: id, nombre });
    state.plantillas = [...(state.plantillas || []).filter((x) => x.id !== p.id), p];
    toast(`⧉ Plantilla «${p.nombre}» guardada: la tienes en «＋ Nueva tarjeta» y en ⌘K`);
  } catch (err) {
    toast(err.message, true);
  }
}
