// Órbita · Paleta de comandos (⌘K): todo lo que se hace con el ratón, también con el teclado.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, api, cerrarOrbita, esc, proyecto, state, toast, visible } from "./nucleo.js";
import { SECCIONES, corto, elegirFiltro, irASeccion } from "./tablero.js";
import { closeDrawer, desplazar, move } from "./panel.js";
import { openConnect } from "./detalle.js";
import { abrirNueva } from "./acciones.js";
import { exportar, pausarProyecto, reanudarTodos } from "./exportar.js";
import { guardarComoPlantilla } from "./extras.js";

export function sinTildes(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function resaltar(texto, palabras) {
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

export let seleccion = 0;
export let encontrados = [];
export function pintarBusqueda() {
  if (verAtajos) return pintarAtajos();
  const consulta = $("#buscarInput").value.trimStart().replace(/^>\s*/, ""); // «>» era para ver solo comandos: ya no hace falta
  encontrados = buscarComandos(consulta, true);
  seleccion = Math.min(seleccion, Math.max(0, encontrados.length - 1));
  $("#buscarLista").innerHTML =
    encontrados
      .map((r, i) => `<li role="option" class="b-item b-cmd ${i === seleccion ? "on" : ""}" data-i="${i}" aria-selected="${i === seleccion}"><span class="b-ico">${r.cmd.icono}</span><span class="b-txt">${r.palabras.length ? resaltar(r.cmd.nombre, r.palabras) : esc(r.cmd.nombre)}</span>${r.cmd.atajo ? `<span class="b-atajo">${teclas(r.cmd.atajo)}</span>` : ""}</li>`)
      .join("") || `<li class="b-vacio">Ningún comando coincide con «${esc(consulta.trim())}»</li>`;
  $("#buscarPie").innerHTML = `<kbd>↑</kbd><kbd>↓</kbd> elegir · <kbd>↵</kbd> ejecutar · <button class="b-link" id="verAtajosBtn">atajos de teclado</button>`;
  $("#verAtajosBtn")?.addEventListener("click", () => mostrarAtajos());
  for (const li of document.querySelectorAll("#buscarLista [data-i]")) li.onclick = () => abrirResultado(Number(li.dataset.i));
  $("#buscarLista .on")?.scrollIntoView({ block: "nearest" });
}

export function abrirResultado(i) {
  const r = encontrados[i];
  if (!r) return;
  if (r.cmd.id === "atajos") return mostrarAtajos();
  cerrarBusqueda();
  r.cmd.hacer();
}

export function abrirBusqueda() {
  $("#buscador").hidden = false;
  const i = $("#buscarInput");
  i.value = "";
  seleccion = 0;
  verAtajos = false;
  pintarBusqueda();
  i.focus();
}
export function cerrarBusqueda() {
  $("#buscador").hidden = true;
  $("#buscarInput").blur();
}

export let esperaBusqueda;





// ---------------------------------------------------------------------------
// Paleta de comandos: lo mismo que con el ratón, desde ⌘K y solo con el teclado
// ---------------------------------------------------------------------------

export const COLUMNAS = [["backlog", "Ideas"], ["doing", "En curso"], ["review", "Para revisar"], ["done", "Hecho"]];
export function teclas(a) {
  return a.split(" ").map((k) => `<kbd>${esc(k)}</kbd>`).join("");
}

// Los comandos dependen de lo que hay delante: la tarjeta abierta, el proyecto, lo hecho…
// Tema: automático (el del sistema) → claro → oscuro. La lógica vive en tema.js, que se carga antes de pintar.
export const TEMAS = { auto: ["◐", "Auto", "el del sistema"], light: ["☀", "Claro", "claro"], dark: ["☾", "Oscuro", "oscuro"] };
export function pintarTema() {
  const t = window.temaOrbita?.leer() || "auto";
  $("#temaIcono").textContent = TEMAS[t][0];
  $("#temaTexto").textContent = ` ${TEMAS[t][1]}`;
  $("#temaBtn").title = `Tema: ${TEMAS[t][2]} (pulsa para cambiar)`;
}
export function ponerTema(t) {
  window.temaOrbita?.poner(t);
  pintarTema();
  toast(`Tema ${TEMAS[t][2]}`);
}


export function comandos() {
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
  add("objetivo", "🎯", "Planificar un objetivo", () => $("#goalInput").focus(), "/", "crear proyecto plan");
  for (const pl of state.plantillas || []) add(`plantilla-${pl.id}`, pl.icono || "⧉", `Nueva desde plantilla: ${pl.nombre}`, () => abrirNueva(pl.id), "", "plantilla crear tarjeta nueva");
  if (c) add("como-plantilla", "⧉", `Guardar «${corto(c.title, 30)}» como plantilla`, () => guardarComoPlantilla(c.id, c.title.slice(0, 60)), "", "plantilla");
  const hechas = [...state.cards.values()].filter((x) => visible(x) && x.column === "done").length;
  if (hechas && state.seccion === "tablero") add("archivar-hechas", "🗄", `Archivar las ${hechas} tarjeta${hechas === 1 ? "" : "s"} hecha${hechas === 1 ? "" : "s"}`, () => $("#archiveDone").click(), "", "limpiar");
  for (const [id, nombre] of SECCIONES(state.filtro))
    if (id !== state.seccion) add(`seccion-${id}`, "▤", `Abrir ${nombre}`, () => irASeccion(id), "", id === "ajustes" ? "ajustes configuración instrucciones memoria conocimiento secretos claves api contexto" : "sección");
  // Lo que antes eran secciones: siguen a mano desde la paleta
  if (proyecto(state.filtro)) add("seccion-conocimiento", "📚", "Abrir Conocimiento (en Contexto para la IA)", () => irASeccion("conocimiento"), "", "sección archivos referencia documentos");
  if (state.seccion !== "archivo") add("seccion-archivo", "🗄", "Abrir Archivo y papelera", () => irASeccion("archivo"), "", "sección archivadas papelera borradas restaurar");
  for (const p of state.projects) if (p.id !== state.filtro) add(`ir-${p.id}`, "⇥", `Ir a «${p.name}»`, () => elegirFiltro(p.id), "", "proyecto pestaña cambiar");
  const actual = proyecto(state.filtro);
  if (actual && !actual.pausado) add("pausar", "⏸", `Pausar «${actual.name}»`, () => pausarProyecto(actual.id, true), "", "pausa detener parar prioridad");
  if (actual && actual.pausado) add("reanudar", "▶", `Reanudar «${actual.name}»`, () => pausarProyecto(actual.id, false), "", "play continuar seguir");
  if (state.projects.some((x) => x.pausado)) add("reanudar-todos", "▶", "Reanudar todos los proyectos", reanudarTodos, "", "play continuar pausa");
  add("proyecto-nuevo", "＋", "Nuevo proyecto", () => setTimeout(() => $("#tabNew").click()), "", "crear pestaña");
  add("conectar", "◉", "Conectar una IA", openConnect, "", "mcp cerebro");
  add("atajos", "⌨", "Atajos de teclado", null, "", "teclado ayuda");
  add("cerrar-orbita", "⏻", "Cerrar Órbita", cerrarOrbita, "", "salir apagar detener servidor quit");
  return lista;
}

export function buscarComandos(consulta, todos) {
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
  return res;
}

// Lista de atajos, dentro de la misma paleta
export let verAtajos = false;
export const ATAJOS = [
  ["⌘ K", "Paleta de comandos (Ctrl K en Windows y Linux)"],
  ["N", "Nueva tarjeta"],
  ["/", "Escribir un objetivo para planificar"],
  ["Alt ↑", "Subir la tarjeta abierta en su columna"],
  ["Alt ↓", "Bajar la tarjeta abierta en su columna"],
  ["⌘ ↵", "Enviar el mensaje en la conversación de una tarjeta"],
  ["↑ ↓ ↵", "Elegir y ejecutar en la paleta"],
  ["Esc", "Cerrar la paleta, la tarjeta o un aviso"],
  ["clic", "En una imagen: verla en grande (← → para pasar, C para copiarla)"],
];
export function mostrarAtajos() {
  verAtajos = true;
  $("#buscarInput").value = "";
  pintarAtajos();
  $("#buscarInput").focus();
}
export function pintarAtajos() {
  encontrados = [];
  $("#buscarLista").innerHTML = `<li class="b-grupo">Atajos de teclado</li>` + ATAJOS.map(([k, que]) => `<li class="b-atajo-fila"><span class="b-atajo">${teclas(k)}</span><span>${esc(que)}</span></li>`).join("");
  $("#buscarPie").innerHTML = "<kbd>Esc</kbd> volver a la paleta · escribe para buscar un comando";
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
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
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#buscador").hidden ? abrirBusqueda() : cerrarBusqueda();
    }
  });
  $("#temaBtn").onclick = () => {
    const orden = ["auto", "light", "dark"];
    ponerTema(orden[(orden.indexOf(window.temaOrbita?.leer() || "auto") + 1) % orden.length]);
  };
  pintarTema();
}
