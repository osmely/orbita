// Órbita · Columnas y tarjetas, pestañas de proyecto y sus secciones.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, LIVE, STATUS, api, crearProyecto, elegirCarpeta, esc, guardarFiltro, load, proyecto, state, toast, tono, visible } from "./nucleo.js";
import { paginaAjustes, paginaArchivo, paginaEntidades, paginaEntregables, renderCounts } from "./paginas.js";
import { linea, marcarCallada, openDrawer, quitarLinea, updateDrawer } from "./panel.js";
import { openConnect } from "./detalle.js";
import { actualizarPendientes, avisar } from "./acciones.js";
import { pausarProyecto } from "./exportar.js";
import { fechaProg, openIAProyecto, resumenPrograma } from "./extras.js";

// ---------------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------------

export function renderAll() {
  for (const col of document.querySelectorAll(".col")) $(".drop", col).innerHTML = "";
  for (const card of [...state.cards.values()].sort((a, b) => a.order - b.order)) placeCard(card);
  renderTabs();
  renderSubnav();
  renderSeccion();
  renderCounts();
  if (state.openId && state.cards.has(state.openId)) updateDrawer(state.cards.get(state.openId));
}

export function upsert(card) {
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
  if (["archivo", "ajustes", "entregables"].includes(state.seccion)) renderSeccion();
  renderCounts();
  if (state.openId === card.id && state.view === "card") updateDrawer(card);
}

export function placeCard(card) {
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
  el.className = `card ${card.status}${esperaDe(card) ? " te-espera" : ""}`;
  el.innerHTML = cardHTML(card);
  ajustarEtiquetas(el);
}

// Si una etiqueta no cabe, se quitan palabras enteras (nunca se corta a mitad de palabra)
export function ajustarEtiquetas(raiz) {
  for (const chip of raiz.querySelectorAll("[data-completo]")) {
    const palabras = chip.dataset.completo.split(/\s+/);
    let n = palabras.length;
    const icono = chip.textContent.trim().charAt(0) + " ";
    chip.textContent = icono + chip.dataset.completo;
    while (chip.scrollWidth > chip.clientWidth && n > 1) chip.textContent = icono + palabras.slice(0, --n).join(" ").replace(/[,.;:–-]+$/, "") + "…";
  }
}
export let esperaAjuste;

// Corta un texto por palabra completa: "planifica una app tipo calculadora…"
export function corto(texto, max = 26) {
  if (texto.length <= max) return texto;
  const recorte = texto.slice(0, max + 1);
  const espacio = recorte.lastIndexOf(" ");
  return (espacio > max * 0.5 ? recorte.slice(0, espacio) : texto.slice(0, max)).replace(/[\s,.;:–-]+$/, "") + "…";
}

// "lleva 3 min" / "hace 12 s"
// ¿Te está esperando la IA fuera de Órbita? Con los hooks de Claude Code se sabe (espera un permiso, lleva un rato
// esperando tu respuesta en su chat, o terminó su turno sin entregar). Sin ellos se sospecha: lleva más de 2 minutos
// sin hablar con Órbita (ni informa ni escucha) con la tarjeta en curso.
export const TEXTO_ESPERA = {
  permiso: "Claude espera tu permiso en su terminal",
  chat: "Claude espera tu respuesta en su chat",
  parado: "Claude paró sin entregar: mira su chat",
  silencio: "Sin noticias de la IA: puede estar esperándote en su chat",
};
export function esperaDe(c) {
  if (!["running", "returned"].includes(c.status) || c.archivedAt) return null;
  if (c.claude?.espera) return c.claude.espera;
  if (!c.worker || state.brains.some((b) => b.name === c.worker)) return null; // conectada hace menos de 2 min
  const senal = Math.max(c.liveAt || 0, c.claude?.ultimo || 0, c.startedAt || 0, ...(c.log || []).filter((l) => l.kind !== "you").map((l) => l.t));
  if (Date.now() - senal < 120_000) return null;
  return { tipo: "silencio", texto: `${c.worker} lleva un rato sin hablar con Órbita. Puede estar esperándote en su chat de Claude: una pregunta o un permiso.`, t: senal };
}
// Se mira cada pocos segundos: si una tarjeta empieza a esperarte, se repinta y te avisa (una vez por espera)
const esperasAvisadas = new Map(); // id → clave de la espera avisada
export function revisarEsperas() {
  for (const c of state.cards.values()) {
    const e = esperaDe(c);
    const clave = e ? `${e.tipo}:${e.t}` : "";
    if ((esperasAvisadas.get(c.id) || "") === clave) continue;
    esperasAvisadas.set(c.id, clave);
    placeCard(c);
    if (state.openId === c.id && state.view === "card") updateDrawer(c);
    if (e) avisar({ ...c, question: TEXTO_ESPERA[e.tipo] }, "pregunta");
  }
}

// Lo último que hace Claude en la tarjeta (de sus hooks), si es de hace menos de 2 minutos: «$ npm test …»
function lineaClaude(c) {
  const a = [...(c.claude?.actividad || [])].reverse().find((x) => x.tipo === "herramienta" || x.tipo === "permiso");
  if (!a || Date.now() - a.t > 120_000) return "";
  if (a.tipo === "permiso") return `<div class="meta-claude permiso">⚠ ${esc(corto(a.texto, 70))}</div>`;
  return `<div class="meta-claude${a.estado === "corriendo" ? " corriendo" : ""}"><span>${esc(a.icono || "·")}</span><code>${esc(corto(a.texto, 60))}</code></div>`;
}

export function duracion(desde) {
  const s = Math.max(0, Math.round((Date.now() - desde) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// Posición en la cola, en el mismo orden en que wait_for_work entrega las tarjetas
// Tarjetas a las que todavía espera (las que no están en Hecho)
// Tokens que ha gastado la IA en la tarjeta (de los registros de Claude Code; ver tokens.mjs)
export const cifra = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)).replace(".", ",");
export function chipTokens(t, largo = false) {
  const titulo = `Tokens de la IA en esta tarjeta: ${t.entrada.toLocaleString()} de entrada (${t.cacheLeida.toLocaleString()} leídos de caché) y ${t.salida.toLocaleString()} de salida, en ${t.mensajes} respuesta${t.mensajes === 1 ? "" : "s"} de Claude`;
  return `<span class="chip tokens" title="${titulo}">${largo ? "Tokens: " : ""}⇣ ${cifra(t.entrada)} · ⇡ ${cifra(t.salida)}</span>`;
}

export function pendientesDe(c) {
  return (c.dependsOn || []).map((id) => state.cards.get(id)).filter((d) => d && d.column !== "done");
}

export function pausado(c) {
  return !!proyecto(c.projectId)?.pausado;
}
export function enCola(c) {
  const cola = [...state.cards.values()].filter((x) => (x.status === "queued" || x.status === "returned") && !x.archivedAt && !pausado(x) && (x.status === "returned" || !pendientesDe(x).length)).sort((a, b) => a.order - b.order); // el orden de la columna es la prioridad
  return { pos: cola.findIndex((x) => x.id === c.id) + 1, total: cola.length };
}
// Las IAs que pueden tomar las tarjetas de un proyecto (lo mismo que decide el servidor en elegible):
// la suya si tiene; si no, las que no están dedicadas a otro proyecto
export function iasPara(projectId) {
  const suya = proyecto(projectId)?.ia;
  return state.brains.filter((b) => (suya ? b.name === suya : !b.proyectos?.length));
}

// Por qué nadie va a tomar una tarjeta en cola, con la acción que lo arregla (null si alguna IA la tomará)
export function sinIA(c) {
  if (c.status !== "queued" || c.archivedAt || pendientesDe(c).length) return null;
  const p = proyecto(c.projectId);
  if (!p) return null;
  if (p.pausado) return { tipo: "pausa", texto: "Proyecto en pausa: la IA no toma sus tarjetas", accion: "▶ Reanudar" };
  if (iasPara(p.id).length) return null;
  if (p.ia) return { tipo: "ia", texto: `${p.ia}, la IA de este proyecto, no está conectada`, accion: "Lanzarla" };
  const otras = state.brains.map((b) => b.name);
  return { tipo: "ia", texto: otras.length ? `Ninguna IA escucha este proyecto (${otras.join(", ")} ${otras.length > 1 ? "trabajan" : "trabaja"} solo en el suyo)` : "Ninguna IA conectada", accion: "Conectar una IA" };
}
export function avisoSinIA(c, clase = "sin-ia") {
  const s = sinIA(c);
  return s ? `<div class="${clase}"><span>⚠ ${esc(s.texto)}</span><button type="button" class="mini" data-sin-ia="${esc(c.projectId)}" data-tipo="${s.tipo}">${esc(s.accion)}</button></div>` : "";
}
function resolverSinIA(projectId, tipo) {
  if (tipo === "pausa") pausarProyecto(projectId, false);
  else openIAProyecto(projectId); // con la instrucción para copiar en una sesión nueva
}

export function textoCola(c) {
  const faltan = pendientesDe(c);
  if (faltan.length) return `🔒 Espera a ${faltan.map((d) => `«${d.title}»`).join(" y ")}`;
  if (pausado(c)) {
    // ¿La IA que la tenía ya se enteró? Solo se entera en su siguiente llamada a Órbita
    if (c.revocada && !c.revocada.avisada) return `⏸ Avisando a ${c.revocada.worker}: parará en su próxima acción`;
    if (c.pausada && c.revocada?.avisada) return `⏸ En pausa · ${c.revocada.worker} se detuvo ✓`;
    return "⏸ En pausa · proyecto pausado";
  }
  const { pos, total } = enCola(c);
  if (sinIA(c)) return `En cola · ${pos}.ª de ${total}`; // el porqué y su acción van en el aviso de debajo
  const suya = proyecto(c.projectId)?.ia;
  if (suya) {
    const b = state.brains.find((x) => x.name === suya);
    return `En cola · ${b?.listening ? `la tomará ${suya}` : b ? `${suya} está con otra tarjeta` : `esperando a ${suya} (no está conectada)`}`;
  }
  const pueden = iasPara(c.projectId);
  const escuchando = pueden.filter((b) => b.listening).map((b) => b.name);
  const quien = escuchando.length ? `la tomará ${escuchando.join(" o ")}` : pueden.length ? `${pueden[0].name} está con otra tarjeta` : "ninguna IA escucha este proyecto";
  return `En cola · ${pos}.ª de ${total} · ${quien}`;
}

// Estados que la columna ya explica: no hace falta etiqueta
export const OBVIO = { backlog: ["idle"], doing: ["queued", "running", "returned"], review: ["ready", "waiting"], done: ["done"] };
export const PASOS = ["step", "file", "web", "spawn", "ask", "you"];

export function cardHTML(c) {
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
  if (c.entregable) chips.push(`<span class="chip entregable" title="Entregable: al aprobarla, su resultado pasa a «Entregables»">📦</span>`);
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
  if (c.tokens) chips.push(chipTokens(c.tokens));
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
      ${trabajando ? lineaClaude(c) : ""}
      ${trabajando && pausado(c) ? `<div class="meta-pausa">⏸ Proyecto en pausa: terminará esta y parará</div>` : ""}
      ${avisoSinIA(c)}
      ${esperaDe(c) ? `<div class="meta-espera">⚠ ${esc(TEXTO_ESPERA[esperaDe(c).tipo] || "Te espera fuera de Órbita")}</div>` : ""}
      ${pasos.length > 1 ? `<ol class="mini-pasos">${pasos.slice(0, -1).reverse().map((p) => `<li>${esc(p.text)}</li>`).join("")}</ol>` : ""}
    </div>`;
  }
  const question = c.status === "waiting" ? `<div class="question">❓ ${esc(c.question)}</div>` : "";
  const preview = c.status === "ready" && c.result ? `<div class="preview">${esc(c.result.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[#*_`>|-]/g, "").slice(0, 260))}</div>` : "";
  const desc = c.description && !preview && !question && !live ? `<div class="desc">${esc(c.description)}</div>` : "";

  return `<h3>${esc(c.title)}</h3>${desc}${live}${question}${preview}${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}`;
}


// La posición en la cola cambia cuando se mueve cualquier otra tarjeta
export function refrescarCola() {
  for (const c of state.cards.values()) if (c.status === "queued" || c.dependsOn?.length) placeCard(c); // también las que esperan a otras
}

// ---------------------------------------------------------------------------
// Pestañas de proyecto (como en el navegador) y lo que hay dentro de cada una
// ---------------------------------------------------------------------------

// Pestañas cerradas (cerrar no borra el proyecto: se reabre con ＋)
export const cerradas = new Set(leerLista("orbita.pestanasCerradas"));
export function leerLista(clave) {
  try {
    return JSON.parse(localStorage.getItem(clave) || "[]");
  } catch {
    return [];
  }
}
export function guardarCerradas() {
  try {
    localStorage.setItem("orbita.pestanasCerradas", JSON.stringify([...cerradas]));
  } catch {}
}

export function deFiltro(f, c) {
  return f === "todos" ? true : f === "sin" ? !c.projectId : c.projectId === f;
}

export function renderTabs() {
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

export function renombrarEnPestana(t) {
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
export function proyectoPorDefecto(excepto = null) {
  const otros = state.projects.filter((p) => p.id !== excepto);
  return (otros.find((p) => !cerradas.has(p.id)) || otros[0])?.id || "";
}

export function cerrarPestana(id) {
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

export function elegirFiltro(f) {
  state.filtro = f;
  if (cerradas.delete(f)) guardarCerradas(); // abrir un proyecto reabre su pestaña
  if (!["tablero", "archivo"].includes(state.seccion) && !SECCIONES(f).some((x) => x[0] === state.seccion)) state.seccion = "tablero";
  guardarFiltro();
  renderAll();
}



// Secciones dentro de la pestaña. El archivo (y la papelera) se abre desde el tablero, no es una sección más;
// el conocimiento vive dentro de «Contexto para la IA». Los nombres antiguos siguen llevando a su sitio (ver irASeccion).
export function SECCIONES(f) {
  return proyecto(f)
    ? [["tablero", "Tablero"], ["ajustes", "Contexto para la IA", "Contexto"], ["entidades", "Entidades"], ["entregables", "Entregables"]]
    : [["tablero", "Tablero"], ["entregables", "Entregables"]];
}
// La pestaña que se marca: el archivo es parte del tablero
const pestanaDe = (s) => (s === "archivo" ? "tablero" : s);
export function irASeccion(s) {
  if (s === "conocimiento") {
    state.seccion = "ajustes";
    renderSubnav();
    renderSeccion();
    return document.querySelector("#page [data-conocimiento]")?.scrollIntoView({ block: "start" });
  }
  state.seccion = s;
  renderSubnav();
  renderSeccion();
}

export function archivosDe(f) {
  const p = proyecto(f);
  if (!p) return f === "todos" ? state.files : [];
  return state.files.filter((x) => x.startsWith(p.folder + "/") && !x.startsWith(p.folder + "/conocimiento/") && !x.startsWith(p.folder + "/entidades/"));
}

export function renderSubnav() {
  const f = state.filtro;
  const p = proyecto(f);
  const n = {
    conocimiento: p?.knowledge?.length || 0,
    entidades: p?.entidades?.length || 0,
    entregables: [...state.cards.values()].filter((c) => c.entregable && c.projectId === f && !c.archivedAt).length,
    archivo: [...state.cards.values()].filter((c) => c.archivedAt && deFiltro(f, c)).length + (state.papelera || []).filter((x) => f === "todos" || (f === "sin" ? !x.projectId : x.projectId === f)).length,
    ajustes: p && (p.instructions || p.memory) ? "●" : 0,
  };
  // Un solo control para la IA del proyecto: quién es (y si está conectada) y si trabaja o está en pausa
  const estadoIA = (nombre) => {
    const b = state.brains.find((x) => x.name === nombre);
    return !b ? ["off", "no conectada"] : b.listening ? ["on", "escuchando"] : ["trab", b.tarjeta ? `trabajando: ${b.tarjeta}` : "conectada"];
  };
  let pp = "";
  if (p) {
    const conectadas = iasPara(p.id);
    const [punto, estado] = p.ia ? estadoIA(p.ia) : conectadas.length ? [conectadas.some((b) => b.listening) ? "on" : "trab", `la trabaja cualquier IA conectada (${conectadas.map((b) => b.name).join(", ")})`] : ["off", "ninguna IA conectada"];
    const terminando = p.pausado && [...state.cards.values()].some((c) => c.projectId === p.id && c.status === "running" && !c.archivedAt);
    const botonIA = `<button class="pp-btn ic-ia" data-pp="ia" title="${esc(p.ia ? `La IA de este proyecto: ${estado}` : `Sin IA propia: ${estado}. Pulsa para darle la suya`)}"><i class="ia-dot ${punto}"></i>🧠 ${esc(p.ia ? corto(p.ia, 28) : "Cualquier IA")}</button>`;
    const botonEstado = p.pausado
      ? `<button class="pp-btn ic-estado pausado" data-pp="reanudar" title="Pulsa para reanudar: la IA vuelve a tomar sus tarjetas">${terminando ? "⏸ Termina y para" : "⏸ En pausa"}</button>`
      : `<button class="pp-btn ic-estado" data-pp="pausar" title="Pulsa para pausar: la IA termina la tarjeta que tiene y no toma más">▶ Trabajando</button>`;
    pp = `<span class="pp"><span class="ia-control" role="group" aria-label="La IA del proyecto">${botonIA}${botonEstado}</span></span>`;
  }
  // El archivo y la papelera se abren desde la columna «Hecho»
  $("#verArchivo").textContent = n.archivo ? `🗄 Archivo · ${n.archivo}` : "🗄 Archivo";
  $("#verArchivo").hidden = !p;
  $("#verArchivo").onclick = () => irASeccion("archivo");
  $("#subnav").innerHTML =
    (p ? SECCIONES(f) : [])
      .map(([id, nombre, corto]) => `<button class="sub ${pestanaDe(state.seccion) === id ? "on" : ""}" data-s="${id}">${corto ? `<span class="s-largo">${nombre}</span><span class="s-corto">${corto}</span>` : nombre}${n[id] ? ` <b>${n[id]}</b>` : ""}</button>`)
      .join("") + pp;
  for (const b of document.querySelectorAll("#subnav [data-pp]"))
    b.onclick = () => ({ pausar: () => pausarProyecto(f, true), reanudar: () => pausarProyecto(f, false), ia: () => openIAProyecto(f) })[b.dataset.pp]();
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
    const enMarcha = delProyecto.filter((c) => c.status === "running");
    const esperan = delProyecto.length - enMarcha.length;
    banda.innerHTML = `<span>⏸ <b>${esc(p.name)}</b> está en pausa: la IA no toma más tarjetas${esperan ? ` (${esperan} ${esperan === 1 ? "espera" : "esperan"} en «En curso»)` : ""}.${
      enMarcha.length ? ` <b class="avisando">${enMarcha.map((c) => `${esc(c.worker || "La IA")} termina «${esc(corto(c.title, 40))}»`).join(" y ")} y para.</b>` : ""
    }</span><button class="btn mini-btn" id="pausaReanudar">▶ Reanudar</button>`;
    $("#pausaReanudar").onclick = () => pausarProyecto(p.id, false);
  }
  // Aviso sobre el tablero: tarjetas en curso que ninguna IA puede tomar (la pausa ya tiene su banda)
  let sinIABanda = $("#sinIABanda");
  if (!sinIABanda) {
    sinIABanda = document.createElement("div");
    sinIABanda.id = "sinIABanda";
    sinIABanda.className = "pausa-banda sin-ia-banda";
    banda.after(sinIABanda);
  }
  const esperan = p && !p.pausado ? [...state.cards.values()].filter((c) => c.projectId === p.id && sinIA(c)) : [];
  sinIABanda.hidden = !esperan.length;
  if (esperan.length) {
    const s = sinIA(esperan[0]);
    sinIABanda.innerHTML = `<span>⚠ ${esperan.length === 1 ? "1 tarjeta en «En curso» espera" : `${esperan.length} tarjetas en «En curso» esperan`}: <b>${esc(s.texto)}</b>.</span><button class="btn mini-btn" data-sin-ia="${esc(p.id)}" data-tipo="${s.tipo}">${esc(s.accion)}</button>`;
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
    b.onclick = () => irASeccion(b.dataset.s);
}

export function renderSeccion() {
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
  ({ ajustes: paginaAjustes, entidades: paginaEntidades, entregables: paginaEntregables, archivo: paginaArchivo })[state.seccion]?.(pagina);
}

// Sin ningún proyecto todavía: lo primero es crear uno (con su carpeta de trabajo)
export function bienvenida() {
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

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
  // Los botones «Reanudar» / «Conectar una IA» de los avisos (en la tarjeta no la abren: solo hacen lo suyo)
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest?.("[data-sin-ia]");
      if (!b) return;
      e.stopPropagation();
      resolverSinIA(b.dataset.sinIa, b.dataset.tipo);
    },
    true,
  );
  addEventListener("resize", () => {
    clearTimeout(esperaAjuste);
    esperaAjuste = setTimeout(() => ajustarEtiquetas(document), 120);
  });
  // El tiempo que lleva cada tarjeta avanza solo
  setInterval(() => {
    for (const el of document.querySelectorAll("[data-since]")) el.textContent = duracion(Number(el.dataset.since));
    marcarCallada();
    revisarEsperas();
  }, 1000);
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
}
