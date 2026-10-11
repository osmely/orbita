// Órbita · Objetivo, nueva tarjeta, atajos, avisos y preguntas rápidas.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, api, connect, elegirCarpeta, esc, hasBrain, load, md, modoBarra, proyecto, state, toast, tono } from "./nucleo.js";
import { corto, elegirFiltro, upsert } from "./tablero.js";
import { closeDrawer, desplazar, openDrawer, showDrawer } from "./panel.js";
import { llenarProyectos, openConnect } from "./detalle.js";
import { aplicarPlantilla, pintarIAPreguntas, pintarPlantillas } from "./extras.js";

export const dlg = $("#newDialog");

// Nueva tarjeta, opcionalmente desde una plantilla
export function abrirNueva(plantillaId = null) {
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






// ---------------------------------------------------------------------------
// Avisos: contador en la pestaña, aviso del navegador y sonido
// ---------------------------------------------------------------------------

export const avisos = leerAvisos();
export function leerAvisos() {
  try {
    return { navegador: false, sonido: false, ...JSON.parse(localStorage.getItem("orbita.avisos") || "{}") };
  } catch {
    return { navegador: false, sonido: false };
  }
}
export function guardarAvisos() {
  try {
    localStorage.setItem("orbita.avisos", JSON.stringify(avisos));
  } catch {}
}

export function noMirando() {
  return document.hidden || !document.hasFocus();
}

export function avisar(card, tipo) {
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
export let audio;
export function sonar(tipo) {
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
export const ICONO_BASE = $("#favicon").href;
export let ultimoN = -1;
export function actualizarPendientes() {
  const n = [...state.cards.values()].filter((c) => !c.archivedAt && (c.status === "ready" || c.status === "waiting")).length;
  if (n === ultimoN) return;
  ultimoN = n;
  document.title = n ? `(${n}) Órbita` : "Órbita";
  $("#favicon").href = n ? iconoConNumero(n) : ICONO_BASE;
}
export function iconoConNumero(n) {
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
export function pintarAvisos() {
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






// ---------------------------------------------------------------------------
// Preguntas rápidas: la IA responde sin crear tarjeta
// ---------------------------------------------------------------------------

export async function preguntar(texto) {
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

export function pintarContadorPreguntas() {
  const n = (state.questions || []).filter((q) => q.status !== "respondida").length;
  $("#qaCount").hidden = !n;
  $("#qaCount").textContent = n;
}

export function avisarRespuesta(q) {
  if (!noMirando() || state.view === "preguntas") return;
  if (avisos.sonido) sonar("entrega");
  if (avisos.navegador && "Notification" in window && Notification.permission === "granted") {
    const n = new Notification(`💬 ${q.worker || "La IA"} respondió`, { body: q.text.slice(0, 140), tag: `orbita-q-${q.id}`, icon: ICONO_BASE });
    n.onclick = () => (window.focus(), openPreguntas(), n.close());
  }
}

export function renderPreguntas() {
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

export function openPreguntas() {
  state.openId = null;
  state.view = "preguntas";
  $("#drawerBody").innerHTML = ""; // al abrir, panel nuevo
  renderPreguntas();
  showDrawer();
  setTimeout(() => $("#qaText")?.focus(), 30); // listo para escribir, sin hacer clic
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
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
  $("#addBtn").onclick = () => abrirNueva();
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
  $("#qaBtn").onclick = openPreguntas;
  document.addEventListener("keydown", (e) => {
    if (e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !dlg.open) {
      e.preventDefault();
      openPreguntas();
    }
  });
}
