// Órbita · Criterios, IA por proyecto, tareas programadas y plantillas.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, api, esc, md, proyecto, state, toast } from "./nucleo.js";
import { corto, renderAll, upsert } from "./tablero.js";
import { closeDrawer, showDrawer } from "./panel.js";
import { dlg, resumirOpciones } from "./acciones.js";

// ---------------------------------------------------------------------------
// Criterios de aceptación («Terminado cuando…») y la autorrevisión de la IA
// ---------------------------------------------------------------------------

export async function guardarCriterios(id, textos) {
  try {
    upsert(await api(`/api/cards/${id}/edit`, { criterios: textos }));
  } catch (err) {
    toast(err.message, true);
  }
}

export function pintarCriterios(c) {
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

export let iaProyecto = null;
export function openIAProyecto(id) {
  iaProyecto = id;
  state.openId = null;
  state.view = "ia";
  $("#drawerBody").innerHTML = "";
  pintarIAProyecto(true);
  showDrawer();
}
export function instruccionIA(p, nombre) {
  return `Sé la IA del proyecto «${p.name}» en mi tablero Órbita. Usa el servidor MCP "orbita" con worker "${nombre}" y llama a wait_for_work con project "${p.id}" una y otra vez: trabaja cada tarjeta que te llegue (report_progress en cada paso y al menos cada 30 segundos, con detalle; submit_result con criteria si los trae) y vuelve a esperar, sin pedirme confirmación entre tarjetas. Lo que necesites de mí, pregúntamelo en Órbita (ask_human o en el resultado), no en este chat.`;
}
export function pintarIAProyecto(forzar = false) {
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
    <div class="d-head"><div class="t">🧠 La IA de «${esc(p.name)}»</div><button class="icon-btn" id="dClose" title="Cerrar (Esc)" aria-label="Cerrar">✕</button></div>
    <p class="sub" style="margin:6px 0 10px;font-size:13px">Con su propia IA, este proyecto <b>avanza en paralelo</b> a los demás: esa IA solo trabaja aquí, y las demás IAs no tocan sus tarjetas ni sus preguntas.</p>
    <div id="iaEstado">${estado}</div>
    <div class="d-section"><h4>1 · Su nombre</h4>
      <form class="ia-form" id="iaForm"><input id="iaNombre" value="${esc(sugerido)}" maxlength="60" autocomplete="off" /><button class="btn primary">${p.ia ? "Guardar" : "Asignar"}</button>${p.ia ? `<button type="button" class="btn" id="iaQuitar">Quitar (volver a compartida)</button>` : ""}</form>
    </div>
    <div class="d-section"><h4>2 · Lánzala en otra sesión de Claude</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">Abre una <b>sesión nueva</b> de Claude Code (o de cualquier IA con el MCP «orbita») y pégale esto. Cada proyecto, en su sesión: así trabajan a la vez.</p>
      <div class="snippet"><pre id="iaInstruccion">${esc(instruccionIA(p, sugerido))}</pre><button class="btn" id="iaCopiar">Copiar</button></div>
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
// Tareas programadas y recurrentes
// ---------------------------------------------------------------------------

export const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export function fechaProg(t) {
  return t ? new Date(t).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
}
export function resumenPrograma(pg) {
  const hora = pg.hora.replace(/^0/, "");
  if (pg.tipo === "una") return `${new Date(pg.proxima).toLocaleDateString([], { day: "numeric", month: "short" })} ${hora}`;
  if (pg.tipo === "diaria") return `cada día ${hora}`;
  if (pg.tipo === "semanal") return `${pg.dias.length === 7 ? "cada día" : pg.dias.length === 5 && !pg.dias.includes(0) && !pg.dias.includes(6) ? "lun a vie" : [1, 2, 3, 4, 5, 6, 0].filter((d) => pg.dias.includes(d)).map((d) => DIAS[d]).join(", ")} ${hora}`;
  return `día ${pg.diaMes} ${hora}`;
}

export function leerPrograma() {
  const tipo = $("#dProgTipo").value;
  if (!tipo) return null;
  const pg = { tipo, hora: $("#dProgHora").value || "09:00" };
  if (tipo === "una") pg.fecha = $("#dProgFecha").value;
  if (tipo === "semanal") pg.dias = [...document.querySelectorAll('#dProgDias .dia[aria-pressed="true"]')].map((b) => Number(b.dataset.dia));
  if (tipo === "mensual") pg.diaMes = Number($("#dProgDiaMes").value) || 1;
  return pg;
}
export function mostrarCamposPrograma(tipo) {
  $("#dProgFecha").hidden = tipo !== "una";
  $("#dProgDias").hidden = tipo !== "semanal";
  $("#dProgDiaMesL").hidden = tipo !== "mensual";
  $("#dProgHoraL").hidden = !tipo;
}
export async function guardarPrograma(id) {
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
export function pintarPrograma(c, forzar = false) {
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

export function camposDePlantilla(p) {
  return [...new Set([p.titulo, p.descripcion, ...(p.criterios || [])].join("\n").match(/\{[^{}\n]{1,40}\}/g) || [])].map((x) => x.slice(1, -1));
}
export function pintarPlantillas() {
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
export function aplicarPlantilla(id) {
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
  if ((p.criterios || []).length) $("#newMas").open = true; // lo que rellena la plantilla, a la vista
  resumirOpciones();
  (document.querySelector("#newCampos input") || $('#newForm button[value="ia"]')).focus();
}
export async function guardarComoPlantilla(id, nombre) {
  try {
    const p = await api("/api/plantillas", { desde: id, nombre });
    state.plantillas = [...(state.plantillas || []).filter((x) => x.id !== p.id), p];
    toast(`⧉ Plantilla «${p.nombre}» guardada: la tienes en «＋ Nueva tarjeta» y en ⌘K`);
  } catch (err) {
    toast(err.message, true);
  }
}
