// Órbita · Arrastrar y soltar, y el panel de la tarjeta.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, LIVE, LOG_ICON, STATUS, api, esc, fileIcon, hasBrain, md, state, toast, visible } from "./nucleo.js";
import { duracion, textoCola } from "./tablero.js";
import { adjuntar, tamano } from "./paginas.js";
import { llenarProyectos, openFile, pintarDependencias, pintarHilo, pintarVersiones } from "./detalle.js";
import { exportar } from "./exportar.js";
import { guardarComoPlantilla, guardarCriterios, guardarPrograma, pintarCriterios, pintarPrograma } from "./extras.js";

// Arrastrar y soltar entre columnas
// Línea que marca dónde caerá la tarjeta
export const linea = document.createElement("div");

export function quitarLinea() {
  return linea.remove();
}



// Arrastrar archivos desde el ordenador: se adjuntan a la tarjeta sobre la que se sueltan
export function arrastraArchivos(e) {
  return [...(e.dataTransfer?.types || [])].includes("Files");
}
export function marcarParaAdjuntar(card) {
  for (const c of document.querySelectorAll(".card.adjuntar")) if (c !== card) c.classList.remove("adjuntar");
  card?.classList.add("adjuntar");
}



// La tarjeta antes de la que caería, según la altura del ratón (null = al final)
export function tarjetaDebajo(drop, y) {
  return [...drop.querySelectorAll(".card:not(.dragging)")].find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) || null;
}


// Subir o bajar una posición (desde el panel: sirve en el móvil y con el teclado)
export function desplazar(id, paso) {
  const c = state.cards.get(id);
  const lista = [...state.cards.values()].filter((x) => x.column === c.column && visible(x)).sort((a, b) => a.order - b.order);
  const i = lista.findIndex((x) => x.id === id);
  const destino = i + paso;
  if (destino < 0 || destino >= lista.length) return;
  const beforeId = paso < 0 ? lista[destino].id : lista[destino + 1]?.id || null;
  move(id, c.column, beforeId);
}

export async function move(id, column, beforeId) {
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

export function openDrawer(id) {
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
      <div class="vivo-estado" id="dVivoEstado"></div>
      <div class="d-section live-box" id="dLiveWrap">
        <h4><i class="live-dot"></i>En vivo <span class="live-at" id="dLiveAt"></span></h4>
        <div class="result" id="dLive"></div>
      </div>
      <div class="d-section" id="dVivoPasosWrap"><h4>Pasos <span class="live-at" id="dVivoPasosN"></span></h4><ol class="vivo-pasos" id="dVivoPasos"></ol></div>
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

export function autosize(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

export function updateDrawer(c) {
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

  pintarEnVivo(c);
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

// «En vivo», más allá de lo que escriba la IA: su paso y su progreso, hace cuánto dio señales de vida (si se calla
// más de 3 minutos se avisa) y la historia de pasos de esta vuelta, que sale del registro de la tarjeta.
const CALLADA = 3 * 60_000;
function pintarEnVivo(c) {
  const desde = c.startedAt || 0;
  const pasos = (c.log || []).filter((l) => l.t >= desde && l.kind !== "you");
  const senal = Math.max(c.liveAt || 0, ...pasos.map((l) => l.t), 0);
  const trabajando = ["running", "returned", "waiting"].includes(c.status);
  const archivos = (c.files || []).length;
  $("#dVivoEstado").hidden = !trabajando;
  if (trabajando)
    $("#dVivoEstado").innerHTML = `
      <div class="vivo-paso">${c.status === "waiting" ? "❓ Esperando tu respuesta" : esc(c.step || "Empezando…")}</div>
      <div class="vivo-barra" role="progressbar" aria-valuenow="${c.progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(2, c.progress)}%"></i></div>
      <div class="vivo-datos">
        <span><b>${c.progress} %</b></span>
        ${c.startedAt ? `<span>lleva <b data-since="${c.startedAt}">${duracion(c.startedAt)}</b></span>` : ""}
        ${senal ? `<span class="vivo-senal" data-senal="${senal}">última señal hace <b data-since="${senal}">${duracion(senal)}</b></span>` : ""}
        <span>${pasos.length} paso${pasos.length === 1 ? "" : "s"}</span>
        ${archivos ? `<span>✎ ${archivos} archivo${archivos === 1 ? "" : "s"}</span>` : ""}
      </div>`;
  marcarCallada();
  const lista = pasos.slice(-25).reverse();
  $("#dVivoPasosWrap").hidden = !lista.length;
  $("#dVivoPasosN").textContent = pasos.length > 25 ? `los 25 últimos de ${pasos.length}` : "";
  $("#dVivoPasos").innerHTML = lista
    .map((l, i) => `<li class="paso-${l.kind}${i === 0 && trabajando ? " actual" : ""}"><span class="k">${LOG_ICON[l.kind] || "·"}</span><span class="x">${esc(l.text)}</span><time>hace <span data-since="${l.t}">${duracion(l.t)}</span></time></li>`)
    .join("");
}
// La «última señal» se pone en ámbar si la IA lleva más de 3 minutos sin dar noticias (se mira cada segundo)
export function marcarCallada() {
  for (const el of document.querySelectorAll("[data-senal]")) {
    const callada = Date.now() - Number(el.dataset.senal) > CALLADA;
    el.classList.toggle("callada", callada);
    const pre = el.firstChild;
    if (pre?.nodeType === 3) pre.textContent = callada ? "sin noticias hace " : "última señal hace ";
  }
}

// Pestañas del panel. Al abrirlo (o si cambia el estado y no has elegido tú) se muestra la que toca:
// trabajando → En vivo; te pregunta → Conversación; entregada → Resultado; si no, la Tarea.
export function pestanaQueToca(c) {
  if (c.status === "waiting") return "chat";
  if (["running", "returned"].includes(c.status)) return "vivo";
  if (c.result && ["review", "done"].includes(c.column)) return "resultado";
  return "tarea";
}
export function pintarPestanas(c) {
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
export function mostrarPestana(cual, elegida = false) {
  const panel = $("#drawerBody");
  panel.dataset.pestana = cual;
  if (elegida) panel.dataset.elegida = "1";
  for (const b of document.querySelectorAll("#dTabs [data-tab]")) {
    b.classList.toggle("on", b.dataset.tab === cual);
    b.setAttribute("aria-selected", String(b.dataset.tab === cual));
  }
  for (const p of document.querySelectorAll("#drawerBody [data-panel]")) p.hidden = p.dataset.panel !== cual;
}

export async function action(id, a) {
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

export async function feedback(id, text, isAnswer = false) {
  try {
    await api(`/api/cards/${id}/feedback`, { text });
    const ta = $("#dFeedbackText");
    if (ta) ta.value = "";
    toast(isAnswer ? "Respuesta enviada a la IA" : "Enviado a la IA: sigue con esta tarjeta");
  } catch (err) {
    toast(err.message, true);
  }
}

export function closeDrawer() {
  if ($("#drawer").contains(document.activeElement)) document.activeElement.blur(); // si no, los atajos creen que sigues escribiendo
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  state.openId = null;
  state.view = "card";
  $("#drawer").classList.remove("on");
  $("#scrim").classList.remove("on");
}

export function showDrawer() {
  $("#drawer").classList.add("on");
  $("#scrim").classList.add("on");
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
  linea.className = "drop-line";
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
}
