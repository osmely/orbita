// Órbita — un Trello con cerebro externo. El tablero funciona a mano, y
// cualquier IA conectada por MCP (Claude Code, Cursor, Claude Desktop…) toma
// las tarjetas que pongas en "En curso", informa su progreso y te entrega el
// resultado para revisar. No usa ninguna API key propia.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createMcpHandler } from "./mcp.mjs";
// Argumentos, carpeta de datos (la del usuario, no la del programa) e interfaz: ver entorno.mjs
import { PORT, DATOS, ABRIR_NAVEGADOR, VERSION_APP, leerPublico, abrirNavegador, salir } from "./entorno.mjs";
// Cada proyecto se guarda en <su carpeta de trabajo>/orbita/ (ver almacen.mjs)
import { cargar, guardar, slug, normalizarCarpeta, comprobarCarpeta, leerTablero, tableroDe, baseDe, rutaReal, listarArchivos, moverCarpetaOrbita, CARPETA } from "./almacen.mjs";
import { elegirCarpeta } from "./carpetas.mjs";

// ---------------------------------------------------------------------------
// Estado del tablero
// ---------------------------------------------------------------------------
//
// Estados de una tarjeta:
//   idle      en Ideas o movida a mano
//   queued    en "En curso", esperando a que una IA la tome
//   running   una IA la está trabajando
//   waiting   la IA te hizo una pregunta
//   returned  le devolviste el trabajo a la IA con comentarios
//   ready     la IA entregó, falta tu revisión
//   done      aprobada

const COLUMNS = ["backlog", "doing", "review", "done"];
let cargado;
try {
  cargado = cargar();
} catch (err) {
  salir(`No se pudo abrir el tablero: ${err.message}`);
}
const board = cargado.board;
// Proyectos cuya carpeta de trabajo no se encuentra: siguen en la lista hasta que la persona los ubique o los quite
let faltantes = cargado.faltantes;
board.projects ??= [];
board.cards ??= [];
for (const p of board.projects) {
  p.instructions ??= ""; // reglas fijas para la IA en todas las tarjetas del proyecto
  p.memory ??= ""; // lo que la IA va aprendiendo (la persona también puede editarla)
  p.memoryAt ??= null;
}
board.questions ??= []; // preguntas rápidas: { id, text, projectId, t, status, worker, answer, answeredAt }
board.notices ??= []; // avisos para las IAs: tarjetas que la persona les quitó
board.preguntasIA ??= null; // la IA dedicada solo a las preguntas rápidas (si la hay)
// Plantillas de tarjetas: { id, nombre, icono, titulo, descripcion, criterios: [], projectId, serie }
// Los {campos} entre llaves se rellenan al usarla. Las de serie se añaden una vez (si las borras de board.json, vuelven).
board.plantillas ??= [];
board.papelera ??= []; // tarjetas borradas por una IA: { card, borradaEn, por, motivo } (se pueden restaurar 30 días)
board.papelera = board.papelera.filter((x) => Date.now() - x.borradaEn < 30 * 86_400_000);
const PLANTILLAS_DE_SERIE = [
  { id: "investigacion", nombre: "Investigación", icono: "🔎", titulo: "Investigar {tema}", descripcion: "Investiga {tema} y resume lo importante: las opciones que hay, sus pros y contras, y una recomendación clara. Cita las fuentes.", criterios: ["Compara al menos 3 opciones", "Termina con una recomendación clara y su porqué", "Cita las fuentes con enlace"] },
  { id: "informe", nombre: "Informe", icono: "📊", titulo: "Informe de {asunto}", descripcion: "Prepara un informe de {asunto}: un resumen al principio, los datos clave y las conclusiones.", criterios: ["Empieza con un resumen de 3 líneas", "Incluye datos o gráficas que lo respalden", "Termina con conclusiones y próximos pasos"] },
  { id: "revision-codigo", nombre: "Revisión de código", icono: "🧪", titulo: "Revisar el código de {qué}", descripcion: "Revisa {qué}: fallos, seguridad, legibilidad y pruebas. Propón cambios concretos.", criterios: ["Lista los problemas ordenados por gravedad", "Cada problema trae una propuesta concreta", "Comprueba que las pruebas pasan"] },
  { id: "fallo", nombre: "Corregir un fallo", icono: "🐞", titulo: "Corregir: {fallo}", descripcion: "Hay un fallo: {fallo}. Reprodúcelo, encuentra la causa, corrígelo y evita que vuelva.", criterios: ["Se reproduce el fallo antes de corregirlo", "Hay una prueba que falla antes y pasa después", "Explica la causa"] },
];
for (const p of PLANTILLAS_DE_SERIE) if (!board.plantillas.some((x) => x.id === p.id)) board.plantillas.push({ ...p, projectId: null, serie: true });
board.deleted ??= {}; // tarjetas eliminadas mientras una IA las trabajaba: id -> { title, worker, motivo }

// ---------------------------------------------------------------------------
// Proyectos: cada uno tiene su carpeta de trabajo, y dentro, orbita/ con su tablero y sus archivos
// ---------------------------------------------------------------------------

const findProject = (id) => board.projects.find((p) => p.id === id);
const carpetaPara = (nombre) => slug(nombre, new Set(board.projects.map((p) => p.folder)));

// Proyecto en una carpeta de trabajo. Si la carpeta ya tiene orbita/tablero.json (un proyecto que
// viene de otra máquina, de un repositorio clonado o que se quitó de la lista), se abre ese.
// Devuelve { project, abierto } (abierto = ya existía en la carpeta).
function newProject(nombre, dir) {
  dir = normalizarCarpeta(dir);
  const yaEs = board.projects.find((p) => p.dir === dir);
  if (yaEs) return { project: yaEs, abierto: true };
  comprobarCarpeta(dir, board.projects);
  if (fs.existsSync(tableroDe(dir))) {
    const { proyecto, tarjetas } = leerTablero(dir);
    if (findProject(proyecto.id)) throw new Error(`Esa carpeta tiene una copia de «${findProject(proyecto.id).name}», que ya está abierto`);
    const project = { ...proyecto, dir, folder: board.projects.some((p) => p.folder === proyecto.folder) || !proyecto.folder ? carpetaPara(proyecto.name) : proyecto.folder };
    const ids = new Set(board.cards.map((c) => c.id));
    board.projects.push(project);
    board.cards.push(...tarjetas.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, projectId: project.id })));
    faltantes = faltantes.filter((f) => f.id !== project.id);
    return { project, abierto: true };
  }
  const project = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(nombre || path.basename(dir)).trim().slice(0, 80) || "Proyecto",
    folder: carpetaPara(nombre || path.basename(dir)),
    instructions: "",
    memory: "",
    memoryAt: null,
    createdAt: Date.now(),
    dir,
  };
  fs.mkdirSync(baseDe(project), { recursive: true });
  board.projects.push(project);
  guardarAhora(); // su tablero.json existe desde el primer momento
  return { project, abierto: false };
}

// Para lo que llega sin proyecto (una pregunta rápida hecha desde «Todos», p. ej.): «General», en la carpeta de datos
function proyectoGeneral() {
  const dir = path.join(DATOS, "general");
  const ya = board.projects.find((p) => p.dir === dir);
  if (ya) return ya;
  fs.mkdirSync(dir, { recursive: true });
  const { project } = newProject("General", dir);
  broadcastProjects();
  return project;
}

// Cambia la carpeta de trabajo de un proyecto: su carpeta orbita/ se va con él
function moverProyecto(project, dir) {
  dir = normalizarCarpeta(dir);
  if (dir === project.dir) return project;
  comprobarCarpeta(dir, board.projects, project);
  moverCarpetaOrbita(project, dir);
  project.dir = dir;
  guardarAhora();
  broadcastProjects();
  broadcast({ type: "files", files: listFiles() });
  return project;
}

// El nombre de un objetivo, con mayúscula y sin "Planificar:"
const nombreDeObjetivo = (texto) => {
  const t = String(texto).replace(/^Planificar:\s*/, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Instrucciones para la IA en las tarjetas de objetivo: no se muestran a la persona.
const PLAN_INSTRUCCIONES =
  "Divide este objetivo en 3-7 tarjetas con un entregable claro, créalas con create_card (parent_id = esta tarjeta) y entrega como resultado un resumen del plan. Si una tarjeta necesita que otra esté hecha antes, indícalo con depends_on (ids de tarjetas ya creadas): no se le dará a nadie hasta que estén aprobadas. Da a cada tarjeta 2-4 criterios de aceptación comprobables (criteria).";

for (const card of board.cards) {
  // Si se borraron entregables a mano, las tarjetas dejan de mencionarlos.
  card.files = (card.files || []).filter(existeArchivo);
  // Tarjetas de objetivo antiguas: la descripción llevaba las instrucciones para la IA.
  if (card.kind === "plan") card.description = card.description.replace(/^Objetivo:\s*/, "").replace(/\s*Divide este objetivo en 3-7 tarjetas[\s\S]*$/, "");
  card.live ??= ""; // avance intermedio que la IA va publicando (Markdown)
}
// Etiquetas de proyecto antiguas se guardaban cortadas a 40 letras: se rehacen del objetivo completo.
for (const card of board.cards) {
  const padre = card.parentId && board.cards.find((c) => c.id === card.parentId);
  if (padre?.kind === "plan") card.tag = padre.title.replace(/^Planificar:\s*/, "");
}
const raizDe = (card, vistos = new Set()) => {
  if (card.projectId || !card.parentId || vistos.has(card.id)) return card.projectId || null;
  vistos.add(card.id);
  const padre = board.cards.find((c) => c.id === card.parentId);
  return padre ? raizDe(padre, vistos) : null;
};
for (const card of board.cards) {
  card.projectId = card.projectId && findProject(card.projectId) ? card.projectId : raizDe(card);
  card.archivedAt ??= null;
  card.dependsOn ??= [];
  card.order ??= card.createdAt; // posición dentro de su columna (antes se ordenaban por fecha)
  card.attachments ??= []; // archivos que adjuntó la persona: { name, path, size }
  card.criterios ??= []; // «Terminado cuando…»: { id, texto, estado: null | "cumple" | "no", evidencia, falla }
  card.programa ??= null; // repetición o fecha programada (ver «Tareas programadas»)
  card.attachments = card.attachments.filter((a) => existeArchivo(a.path));
  // Versiones del resultado: el de antes pasa a ser la versión 1
  card.versions ??= card.result ? [{ n: 1, t: card.updatedAt, quien: card.worker || "—", result: card.result }] : [];
  // Conversación: tarjetas de antes la tenían repartida en la actividad
  if (!card.thread) {
    card.thread = (card.log || [])
      .filter((l) => l.kind === "you" || l.kind === "ask")
      .map((l, i, todos) =>
        l.kind === "you"
          ? { t: l.t, de: "persona", tipo: todos[i - 1]?.kind === "ask" ? "respuesta" : "comentario", texto: l.text } // lo que sigue a una pregunta es su respuesta
          : { t: l.t, de: "ia", quien: card.worker || "La IA", tipo: "pregunta", texto: l.text },
      );
  }
}


let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(guardarAhora, 250);
}
function guardarAhora() {
  clearTimeout(saveTimer);
  saveTimer = null;
  guardar(board, faltantes); // orbita.json + el tablero.json de cada proyecto (solo los que cambiaron)
}
// Al cerrar (Ctrl+C, cerrar la terminal, apagar el equipo) se guarda lo pendiente: nada se pierde
for (const senal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(senal, () => {
    try {
      if (saveTimer) guardarAhora();
    } finally {
      process.exit(0);
    }
  });
}

const findCard = (id) => board.cards.find((c) => c.id === id);

function newCard({ title, description = "", column = "backlog", origin = "tú", parentId = null, tag = null, kind = "task", projectId = null, criterios = [] }) {
  const card = {
    id: crypto.randomUUID().slice(0, 8),
    title: String(title).slice(0, 200),
    description: String(description).slice(0, 8000),
    kind, // "task" o "plan" (dividir un objetivo en tarjetas)
    column,
    status: "idle",
    origin,
    parentId,
    tag,
    projectId: projectId && findProject(projectId) ? projectId : proyectoGeneral().id, // toda tarjeta es de un proyecto
    archivedAt: null, // archivada: oculta del tablero, se puede restaurar
    dependsOn: [], // tarjetas que tienen que estar hechas antes que esta
    order: Date.now(), // posición dentro de su columna: las nuevas, al final
    thread: [], // conversación: { t, de: "persona" | "ia", quien, tipo, texto }
    attachments: [], // archivos que adjunta la persona: { name, path, size }
    versions: [], // cada resultado entregado: { n, t, quien, result, criterios }
    criterios: [], // «Terminado cuando…»: { id, texto, estado: null | "cumple" | "no", evidencia, falla }
    programa: null, // repetición o fecha programada
    worker: null, // nombre de la IA que la trabaja
    inbox: [], // tus mensajes pendientes para la IA
    progress: 0,
    step: "",
    live: "", // avance intermedio que la IA va publicando (Markdown)
    liveAt: null,
    startedAt: null, // cuándo la tomó la IA, para mostrar cuánto lleva
    log: [],
    result: "",
    question: "",
    files: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (criterios?.length) ponerCriterios(card, criterios);
  board.cards.push(card);
  return card;
}

// Añade un mensaje a la conversación de la tarjeta
function hilo(card, mensaje) {
  card.thread.push({ t: Date.now(), ...mensaje, texto: String(mensaje.texto).slice(0, 20_000) });
  if (card.thread.length > 300) card.thread.splice(0, card.thread.length - 300);
}

// Guarda el resultado como versión nueva (si no es igual al último)
// Criterios de aceptación. Al cambiar la lista se conserva lo evaluado de los que no cambian de texto.
function ponerCriterios(card, textos) {
  const antes = new Map(card.criterios.map((c) => [c.texto, c]));
  card.criterios = [...new Set((Array.isArray(textos) ? textos : []).map((t) => String(t).replace(/^\s*[-*•\d.)\]\[ x✓✗]+\s*/i, "").trim().slice(0, 300)).filter(Boolean))]
    .slice(0, 20)
    .map((texto) => antes.get(texto) || { id: crypto.randomUUID().slice(0, 6), texto, estado: null, evidencia: "", falla: false });
}
// La IA revisa cada criterio al entregar: todos, con evidencia
function evaluarCriterios(card, evaluacion) {
  if (!card.criterios.length) return;
  const porId = new Map((evaluacion || []).map((e) => [String(e.id), e]));
  const faltan = card.criterios.filter((c) => !porId.has(c.id));
  if (faltan.length)
    throw new Error(
      `Esta tarjeta tiene criterios de aceptación y no se puede entregar sin revisarlos todos. Falta${faltan.length > 1 ? "n" : ""}: ${faltan.map((c) => `{ id: "${c.id}", texto: «${c.texto}» }`).join(", ")}. ` +
        `Pasa criteria: [{ id, met: true|false, evidence: "captura (/files/…), prueba o enlace que lo demuestre" }] con uno por criterio. Marca met: false lo que no cumples y explica por qué.`,
    );
  const sinEvidencia = card.criterios.filter((c) => porId.get(c.id).met && !String(porId.get(c.id).evidence || "").trim());
  if (sinEvidencia.length) throw new Error(`Falta la evidencia de: ${sinEvidencia.map((c) => `«${c.texto}»`).join(", ")}. Cada criterio cumplido necesita una prueba, captura o enlace en evidence.`);
  for (const c of card.criterios) {
    const e = porId.get(c.id);
    c.estado = e.met ? "cumple" : "no";
    c.evidencia = String(e.evidence || "").slice(0, 2000);
    c.falla = false; // la entrega nueva sustituye a lo que marcó la persona
  }
}

function nuevaVersion(card, result, quien) {
  card.result = result;
  if (card.versions.at(-1)?.result === result) return;
  card.versions.push({ n: (card.versions.at(-1)?.n || 0) + 1, t: Date.now(), quien, result, criterios: card.criterios.length ? card.criterios.map(({ texto, estado, evidencia }) => ({ texto, estado, evidencia })) : undefined });
  if (card.versions.length > 50) card.versions.splice(0, card.versions.length - 50);
}

function log(card, kind, text) {
  card.log.push({ t: Date.now(), kind, text: String(text).slice(0, 2000) });
  if (card.log.length > 300) card.log.splice(0, card.log.length - 300);
}

// ---------------------------------------------------------------------------
// Eventos en vivo
// ---------------------------------------------------------------------------

const subscribers = new Set();
const changes = new EventEmitter(); // avisa a las IAs que esperan trabajo
changes.setMaxListeners(100);

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(data);
}
function touch(card) {
  card.updatedAt = Date.now();
  broadcast({ type: "card", card });
  changes.emit("change");
  save();
}
// ---------------------------------------------------------------------------
// Conocimiento: archivos de referencia del proyecto, en <carpeta de trabajo>/orbita/conocimiento/
// ---------------------------------------------------------------------------

const MAX_CONOCIMIENTO = 10 * 1024 * 1024; // 10 MB por archivo
const carpetaConocimiento = (project) => path.join(baseDe(project), "conocimiento");

function conocimiento(project) {
  const dir = carpetaConocimiento(project);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, path: `${project.folder}/conocimiento/${e.name}`, size: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Nombre de archivo seguro: sin rutas ni caracteres raros
function nombreSeguro(nombre) {
  const limpio = path.basename(String(nombre || "")).replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim().slice(0, 120);
  if (!limpio) throw new Error("Nombre de archivo no válido");
  return limpio;
}

const proyectosPublicos = () => board.projects.map((p) => ({ ...p, knowledge: conocimiento(p) }));

function broadcastQuestions() {
  broadcast({ type: "questions", questions: board.questions });
  changes.emit("change"); // despierta a la IA que espera trabajo
  save();
}

function broadcastProjects() {
  broadcast({ type: "projects", projects: proyectosPublicos(), faltantes });
  save();
}
// ---------------------------------------------------------------------------
// Dependencias: «esta tarjeta espera a…»
// ---------------------------------------------------------------------------

// Las que faltan (una dependencia cuenta como cumplida cuando está en Hecho, aunque se archive)
const dependenciasPendientes = (card) => (card.dependsOn || []).map(findCard).filter((d) => d && d.column !== "done");

function ponerDependencias(card, ids) {
  if (!Array.isArray(ids)) throw new Error("Las dependencias deben ser una lista de ids");
  const limpias = [...new Set(ids.map(String))];
  for (const id of limpias) {
    if (id === card.id) throw new Error("Una tarjeta no puede esperarse a sí misma");
    if (!findCard(id)) throw new Error(`No existe la tarjeta ${id}`);
  }
  // Sin ciclos: ninguna de ellas puede esperar (directa o indirectamente) a esta
  const pila = [...limpias];
  const vistas = new Set();
  while (pila.length) {
    const id = pila.pop();
    if (id === card.id) throw new Error("Eso crearía un ciclo: esas tarjetas ya esperan a esta");
    if (vistas.has(id)) continue;
    vistas.add(id);
    pila.push(...(findCard(id)?.dependsOn || []));
  }
  const antes = card.dependsOn.join();
  card.dependsOn = limpias;
  if (antes !== limpias.join()) {
    const titulos = limpias.map((id) => `«${findCard(id).title}»`).join(", ");
    log(card, "step", limpias.length ? `Espera a ${titulos}` : "Ya no espera a ninguna tarjeta");
  }
}

// Al terminar (o eliminar) una tarjeta, las que la esperaban pueden quedar libres
function liberarDependientes(id) {
  for (const c of board.cards) {
    if (!c.dependsOn?.includes(id)) continue;
    if (dependenciasPendientes(c).length === 0) log(c, "start", "Desbloqueada: ya están hechas las tarjetas a las que esperaba");
    touch(c);
  }
}

// La persona le quita la tarjeta a la IA que la trabaja: se guarda un aviso para
// que su siguiente llamada sobre ella reciba «DETENTE» (y wait_for_work lo cuente).
const TRABAJANDO = ["running", "returned", "waiting"];
function revocar(card, motivo) {
  if (!card.worker || !TRABAJANDO.includes(card.status)) return;
  const at = Date.now();
  card.revocada = { worker: card.worker, motivo, at };
  board.notices.push({ worker: card.worker, cardId: card.id, title: card.title, motivo, at, delivered: false });
  if (board.notices.length > 200) board.notices.splice(0, board.notices.length - 200);
  log(card, "stop", `Se avisará a ${card.worker} para que se detenga (${motivo})`);
}

// A la papelera (lo que borra una IA): se guarda entera para poder restaurarla
function aLaPapelera(card, por, motivo) {
  const copia = JSON.parse(JSON.stringify(card));
  removeCard(card.id, `${por} la borró${motivo ? `: ${motivo}` : ""}`);
  board.papelera.unshift({ card: copia, borradaEn: Date.now(), por, motivo: motivo || "" });
  if (board.papelera.length > 300) board.papelera.length = 300;
  broadcast({ type: "papelera", papelera: papeleraPublica(), borrada: { id: copia.id, title: copia.title, por } });
  save();
}
const papeleraPublica = () => board.papelera.map((x) => ({ id: x.card.id, title: x.card.title, projectId: x.card.projectId, column: x.card.column, borradaEn: x.borradaEn, por: x.por, motivo: x.motivo }));
function restaurarDePapelera(id) {
  const i = board.papelera.findIndex((x) => x.card.id === id);
  if (i === -1) throw new Error(`No está en la papelera: ${id}`);
  const [{ card }] = board.papelera.splice(i, 1);
  if (findCard(card.id)) card.id = crypto.randomUUID().slice(0, 8); // por si acaso, sin chocar
  if (!findProject(card.projectId)) card.projectId = proyectoGeneral().id;
  card.dependsOn = (card.dependsOn || []).filter((d) => findCard(d));
  // Si estaba trabajándose, vuelve a la cola (la IA que la tenía ya recibió «DETENTE»)
  if (["running", "returned"].includes(card.status)) card.status = "queued";
  card.revocada = null;
  delete board.deleted[card.id];
  log(card, "start", "Restaurada de la papelera");
  board.cards.push(card);
  broadcast({ type: "papelera", papelera: papeleraPublica() });
  touch(card);
  return card;
}

function removeCard(id, motivo = "la persona eliminó la tarjeta") {
  const card = findCard(id);
  if (card) {
    revocar(card, motivo);
    if (card.revocada) {
      board.deleted[id] = { title: card.title, worker: card.revocada.worker, motivo: card.revocada.motivo, at: Date.now() };
      const ids = Object.keys(board.deleted);
      if (ids.length > 200) delete board.deleted[ids[0]];
    }
  }
  board.cards = board.cards.filter((c) => c.id !== id);
  for (const c of board.cards) {
    if (c.dependsOn?.includes(id)) {
      c.dependsOn = c.dependsOn.filter((x) => x !== id);
      log(c, "step", "Una de las tarjetas a las que esperaba se eliminó");
    }
  }
  liberarDependientes(id);
  broadcast({ type: "remove", id });
  save();
}

// IAs conectadas: nombre -> { lastSeen, listening }
const brains = new Map();
function seen(name, listening) {
  if (!name) return;
  const b = brains.get(name) || { name, listening: 0 };
  b.lastSeen = Date.now();
  if (listening != null) b.listening = Math.max(0, b.listening + listening);
  brains.set(name, b);
  broadcastBrains();
}
// ¿Está conectada esta IA? (escuchando ahora, o se la vio hace menos de 2 minutos)
function conectada(name) {
  const b = name && brains.get(name);
  return !!b && (b.listening > 0 || Date.now() - b.lastSeen < 120_000);
}
// La IA de preguntas: solo responde preguntas rápidas; mientras esté conectada, las demás no las toman
function preguntasIA(ia) {
  board.preguntasIA = String(ia || "").trim().slice(0, 60) || null;
  broadcast({ type: "preguntasIA", ia: board.preguntasIA });
  changes.emit("change");
  save();
}
function brainList() {
  const now = Date.now();
  return [...brains.values()]
    .filter((b) => b.listening > 0 || now - b.lastSeen < 120_000)
    .map((b) => ({
      name: b.name,
      listening: b.listening > 0,
      proyectos: board.projects.filter((p) => p.ia === b.name).map((p) => p.id),
      tarjeta: board.cards.find((c) => c.worker === b.name && c.status === "running" && !c.archivedAt)?.title || null,
      preguntas: b.name === board.preguntasIA,
    }));
}
let lastBrains = "";
function broadcastBrains() {
  const list = brainList();
  const key = JSON.stringify(list);
  if (key === lastBrains) return;
  lastBrains = key;
  broadcast({ type: "brains", brains: list });
  changes.emit("change"); // si se desconecta la IA de preguntas, las demás vuelven a mirar si les toca alguna
}
setInterval(broadcastBrains, 10_000);

// ---------------------------------------------------------------------------
// Acciones del tablero (las usan la web y el MCP)
// ---------------------------------------------------------------------------

// Archivos de todos los proyectos, como rutas «<folder>/…» (ver almacen.mjs)
const listFiles = () => listarArchivos(board.projects);

function safePath(rel) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("Ruta vacía");
  return rutaReal(rel, board.projects);
}
function existeArchivo(rel) {
  try {
    return fs.existsSync(safePath(rel));
  } catch {
    return false;
  }
}

// Pone la tarjeta en "En curso" para que una IA la trabaje.
// ---------------------------------------------------------------------------
// Orden: cada tarjeta tiene su posición dentro de la columna
// ---------------------------------------------------------------------------

const enColumna = (column, sinId) => board.cards.filter((c) => c.column === column && c.id !== sinId && !c.archivedAt).sort((a, b) => a.order - b.order);

// Coloca la tarjeta en su columna justo antes de `antesDe` (id), o al final si no se indica
function colocar(card, antesDe) {
  const lista = enColumna(card.column, card.id);
  const i = antesDe ? lista.findIndex((c) => c.id === antesDe) : -1;
  if (i === -1) {
    card.order = (lista.at(-1)?.order ?? 0) + 1000;
    return;
  }
  const anterior = lista[i - 1];
  card.order = anterior ? (anterior.order + lista[i].order) / 2 : lista[i].order - 1000;
  // Si a fuerza de partir huecos quedan demasiado juntas, se renumera la columna
  if (anterior && lista[i].order - anterior.order < 1e-6) {
    const todas = [...lista.slice(0, i), card, ...lista.slice(i)];
    todas.forEach((c, j) => (c.order = (j + 1) * 1000));
    for (const c of todas) if (c !== card) touch(c);
  }
}

function requestAI(card, note) {
  note = String(note || "").trim();
  if (note) {
    const tipo = card.status === "waiting" ? "respuesta" : "comentario";
    card.inbox.push({ t: Date.now(), text: note, kind: tipo });
    hilo(card, { de: "persona", tipo, texto: note });
  }
  else if (card.worker && card.result) card.inbox.push({ t: Date.now(), text: "Te la devolví sin comentarios: revisa tu trabajo y mejóralo donde puedas.", kind: "comentario" });
  if (note) log(card, "you", note);
  const fallan = (card.criterios || []).filter((c) => c.falla);
  if (fallan.length) {
    const texto = `Según la persona, no se cumple${fallan.length > 1 ? "n" : ""}: ${fallan.map((c) => `«${c.texto}»`).join(", ")}. Corrígelo y vuelve a revisar todos los criterios al entregar.`;
    card.inbox.push({ t: Date.now(), text: texto, kind: "criterios" });
    hilo(card, { de: "persona", tipo: "comentario", texto });
  }
  card.question = "";
  if (card.column !== "doing") {
    card.column = "doing";
    colocar(card); // entra al final de la cola
  }
  if (card.worker) {
    card.status = "returned";
    card.step = `Devuelta a ${card.worker}`;
  } else {
    card.status = "queued";
    card.step = "Esperando a una IA…";
    if (card.progress >= 100) card.progress = 0;
  }
  touch(card);
}

function moveCard(card, column) {
  if (!COLUMNS.includes(column)) throw new Error("Columna inválida");
  if (column === "doing") return requestAI(card);
  revocar(card, { backlog: "la persona la devolvió a Ideas", done: "la persona ya la dio por hecha", review: "la persona la pasó a revisión" }[column]);
  if (card.worker && column === "backlog") {
    log(card, "stop", `Se la quitaste a ${card.worker}`);
    card.worker = null;
    card.inbox = [];
  }
  if (card.column !== column) {
    card.column = column;
    colocar(card); // al final de su nueva columna
  }
  if (column === "done") {
    card.status = "done";
    card.progress = 100;
    log(card, "done", "Aprobada");
    setImmediate(() => liberarDependientes(card.id));
  } else if (column === "backlog") {
    card.status = "idle";
    card.step = "";
  } else if (column === "review" && !["ready", "waiting"].includes(card.status)) {
    card.status = "ready";
  }
  touch(card);
}

// Play / pausa por proyecto: un proyecto en pausa no entrega tarjetas a la IA
const enPausa = (card) => !!findProject(card.projectId)?.pausado;

// Una IA por proyecto: si un proyecto tiene su IA (project.ia), solo ella toma sus tarjetas y preguntas,
// y esa IA solo trabaja en su(s) proyecto(s). Así dos proyectos avanzan en paralelo sin pisarse.
function elegible(projectId, worker) {
  const mios = board.projects.filter((p) => p.ia === worker).map((p) => p.id);
  if (mios.length) return mios.includes(projectId);
  return !findProject(projectId)?.ia;
}
function iaDeProyecto(project, ia) {
  project.ia = String(ia || "").trim().slice(0, 60) || null;
  broadcastProjects();
  changes.emit("change"); // las IAs que esperan vuelven a mirar qué les toca
  save();
}
function pausarProyecto(project, pausado) {
  project.pausado = !!pausado;
  project.pausadoAt = pausado ? Date.now() : null;
  for (const c of board.cards) {
    if (c.projectId !== project.id || c.archivedAt) continue;
    if (pausado && c.column === "doing" && (c.status === "running" || c.status === "returned")) {
      // La IA que la tenía recibe «detente»; la tarjeta vuelve a la cola sin perder nada (avance, conversación, archivos)
      revocar(c, `la persona pausó el proyecto «${project.name}». La tarjeta seguirá cuando lo reanude`);
      c.status = "queued";
      c.pausada = true;
      c.step = "⏸ En pausa (el proyecto está pausado)";
      log(c, "stop", "En pausa con su proyecto");
      touch(c);
    } else if (!pausado && c.pausada) {
      c.pausada = false;
      if (c.revocada && !c.revocada.avisada && c.worker === c.revocada.worker) {
        // La IA ni se enteró de la pausa: sigue trabajando como si nada (se retira el aviso pendiente)
        for (const n of board.notices) if (n.cardId === c.id && n.worker === c.worker) n.delivered = true;
        c.revocada = null;
        c.status = "running";
        c.step = `${c.worker} sigue (la pausa se deshizo antes de que se enterara)`;
      } else {
        // Ya se había detenido: vuelve a la cola y la retomará con lo que llevaba
        c.revocada = null;
        c.step = "Esperando a una IA…";
        if (c.worker) c.inbox.push({ t: Date.now(), text: "El proyecto estuvo en pausa y ya se reanudó: sigue donde lo dejaste (tu avance en vivo sigue ahí).", kind: "comentario" });
      }
      log(c, "start", "Reanudada con su proyecto");
      touch(c);
    }
  }
  broadcastProjects();
  changes.emit("change"); // despierta a la IA que espera trabajo
  save();
}

function claim(card, worker) {
  if (card.column === "done") throw new Error("Esa tarjeta ya está aprobada.");
  if (enPausa(card)) throw new Error(`El proyecto «${findProject(card.projectId).name}» está en pausa: sus tarjetas no se trabajan hasta que la persona lo reanude.`);
  if (worker && worker === board.preguntasIA) throw new Error(`Eres la IA de preguntas: solo respondes preguntas rápidas, no tomas tarjetas.`);
  if (!elegible(card.projectId, worker)) {
    const p = findProject(card.projectId);
    throw new Error(p?.ia ? `El proyecto «${p.name}» tiene su propia IA («${p.ia}»): solo ella toma sus tarjetas.` : `Eres la IA de otro proyecto: solo tomas tarjetas de ${board.projects.filter((x) => x.ia === worker).map((x) => `«${x.name}»`).join(", ")}.`);
  }
  const faltan = dependenciasPendientes(card);
  if (faltan.length) throw new Error(`Esta tarjeta espera a ${faltan.map((d) => `«${d.title}» (${d.id})`).join(", ")}: no se puede trabajar hasta que estén hechas.`);
  if (card.worker && card.worker !== worker && ["running", "waiting", "returned"].includes(card.status)) {
    throw new Error(`Ya la tiene «${card.worker}».`);
  }
  const resumed = card.worker === worker;
  card.worker = worker;
  if (card.column !== "doing") {
    card.column = "doing";
    colocar(card);
  }
  card.status = "running";
  card.question = "";
  card.step = resumed ? `${worker} la retomó` : `${worker} la tomó`;
  card.startedAt = Date.now();
  card.revocada = null; // quien la toma ahora empieza limpio
  card.pausada = false;
  if (!resumed) {
    card.live = "";
    card.liveAt = null;
  }
  if (card.progress >= 100) card.progress = 5;
  log(card, "start", card.step);
  touch(card);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Imágenes que puede producir la IA (capturas, diagramas). SVG no: puede llevar scripts.
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
};

// Vista previa de entregables (/vista/…): se sirven con su tipo real para que funcionen (páginas, juegos…),
// pero con la cabecera «sandbox»: el navegador los ejecuta en un origen aislado, sin acceso al tablero ni a su API,
// aunque se abran en una pestaña aparte.
const VISTA_MIME = {
  ...MIME,
  ...IMAGE_MIME,
  ".htm": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups allow-downloads";
function serveVista(res, rel) {
  let file;
  try {
    file = safePath(rel);
  } catch {
    return send(res, 403, { error: "prohibido" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "no encontrado" });
    const ext = path.extname(file).toLowerCase();
    const cabeceras = {
      "content-type": VISTA_MIME[ext] || "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*", // para que la página aislada pueda leer sus propios archivos (JSON, módulos…)
    };
    if (ext !== ".pdf") cabeceras["content-security-policy"] = SANDBOX; // el visor de PDF del navegador no funciona en sandbox (y no ejecuta la página)
    res.writeHead(200, cabeceras);
    res.end(data);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req, max = 5e6) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw new Error("Cuerpo demasiado grande");
  }
  return raw ? JSON.parse(raw) : {};
}

function serveFile(res, rel) {
  let file;
  try {
    file = safePath(rel);
  } catch {
    return send(res, 403, { error: "prohibido" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "no encontrado" });
    // Los entregables los escribe una IA: se sirven como imagen o como texto plano, nunca como algo que se ejecute.
    const ext = path.extname(file).toLowerCase();
    const type = IMAGE_MIME[ext] || "text/plain; charset=utf-8";
    res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-cache" }); // siempre la última versión
    res.end(data);
  });
}

// La interfaz de Órbita: de public/ o, en el ejecutable, de dentro del binario (ver entorno.mjs)
function servirPublico(res, rel) {
  const data = leerPublico(rel);
  if (!data) return send(res, 404, { error: "no encontrado" });
  const cabeceras = { "content-type": MIME[path.extname(rel).toLowerCase()] || "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-cache" };
  // La página del tablero solo carga lo suyo, y ninguna otra web puede incrustarla (clickjacking)
  if (rel === "index.html") {
    cabeceras["content-security-policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    cabeceras["referrer-policy"] = "no-referrer";
  }
  res.writeHead(200, cabeceras);
  res.end(data);
}

// Versión de la interfaz: si cambia al reiniciar, las páginas abiertas se recargan solas
const VERSION = crypto
  .createHash("sha1")
  .update([VERSION_APP, ...["index.html", "app.js", "styles.css"].map((f) => leerPublico(f)?.toString("utf8") ?? "")].join("\n"))
  .digest("hex")
  .slice(0, 10);

const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const handleMcp = createMcpHandler({
  board, findCard, findProject, newCard, touch, log, requestAI, moveCard, claim, seen, brainList, changes, listFiles, safePath, broadcast, save, PLAN_INSTRUCCIONES, dependenciasPendientes, ponerDependencias, hilo, conocimiento, broadcastProjects, nuevaVersion, broadcastQuestions, enPausa, ponerCriterios, evaluarCriterios, elegible, iaDeProyecto, conectada, preguntasIA, aLaPapelera, restaurarDePapelera, papeleraPublica, newProject, moverProyecto,
});

const server = http.createServer(async (req, res) => {
  // Solo se acepta tráfico local: evita que una web cualquiera use el tablero
  // desde tu navegador (DNS rebinding o peticiones cruzadas).
  const origin = req.headers.origin;
  // La vista previa aislada pide sus propios archivos con «Origin: null»: solo para leer /vista/
  if (req.method === "GET" && ALLOWED_HOSTS.includes(req.headers.host) && req.url.startsWith("/vista/") && (!origin || origin === "null" || ALLOWED_HOSTS.some((h) => origin === `http://${h}`))) {
    return serveVista(res, decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/vista/".length)));
  }
  if (!ALLOWED_HOSTS.includes(req.headers.host) || (origin && !ALLOWED_HOSTS.some((h) => origin === `http://${h}`))) {
    return send(res, 403, { error: "Solo se aceptan conexiones desde localhost" });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      return await handleMcp(req, res, body, ALLOWED_HOSTS);
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", version: VERSION })}\n\n`);
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }

    if (url.pathname === "/api/board" && req.method === "GET") {
      return send(res, 200, { cards: board.cards, projects: proyectosPublicos(), faltantes, questions: board.questions, preguntasIA: board.preguntasIA, plantillas: board.plantillas, papelera: papeleraPublica(), files: listFiles(), brains: brainList(), version: VERSION, mcpUrl: `http://localhost:${PORT}/mcp` });
    }

    if (url.pathname === "/api/cards" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.title?.trim()) return send(res, 400, { error: "Falta el título" });
      const card = newCard({ title: body.title.trim(), description: body.description || "", projectId: body.projectId, criterios: body.criterios });
      if (body.run) requestAI(card);
      else touch(card);
      return send(res, 200, card);
    }

    // Pregunta rápida: la responde la IA conectada sin crear una tarjeta
    if (url.pathname === "/api/questions" && req.method === "POST") {
      const { text, projectId } = await readJson(req);
      const pregunta = String(text || "").trim().slice(0, 5000);
      if (!pregunta) return send(res, 400, { error: "Escribe tu pregunta" });
      const q = { id: crypto.randomUUID().slice(0, 8), text: pregunta, projectId: projectId && findProject(projectId) ? projectId : null, t: Date.now(), status: "pendiente", worker: null, answer: "", answeredAt: null };
      board.questions.push(q);
      if (board.questions.length > 100) board.questions.splice(0, board.questions.length - 100);
      broadcastQuestions();
      return send(res, 200, q);
    }
    if (parts[0] === "api" && parts[1] === "questions" && parts[2]) {
      const q = board.questions.find((x) => x.id === parts[2]);
      if (!q) return send(res, 404, { error: "Pregunta no encontrada" });
      if (req.method === "DELETE" && !parts[3]) {
        board.questions = board.questions.filter((x) => x !== q);
        broadcastQuestions();
        return send(res, 200, { ok: true });
      }
      // Convertirla en tarjeta: la pregunta y la respuesta quedan como contexto
      if (parts[3] === "card" && req.method === "POST") {
        const titulo = q.text.replace(/\s+/g, " ").slice(0, 120) + (q.text.length > 120 ? "…" : "");
        const card = newCard({
          title: titulo,
          description: q.answer ? `${q.text}\n\n---\nRespuesta rápida de ${q.worker || "la IA"}:\n\n${q.answer}` : q.text,
          projectId: q.projectId,
        });
        touch(card);
        return send(res, 200, card);
      }
    }

    // Un objetivo grande se convierte en una tarjeta de planificación para la IA.
    if (url.pathname === "/api/goal" && req.method === "POST") {
      const { goal, name, dir, projectId } = await readJson(req);
      if (!goal?.trim()) return send(res, 400, { error: "Escribe un objetivo" });
      // En el proyecto indicado; si no se indica ninguno, se crea uno nuevo en la carpeta elegida
      let project = projectId && findProject(projectId);
      if (projectId && !project) return send(res, 404, { error: "Proyecto no encontrado" });
      if (!project) {
        project = newProject(String(name || "").trim() || nombreDeObjetivo(goal).slice(0, 60), dir).project;
        broadcastProjects();
      }
      const card = newCard({
        title: `Planificar: ${goal.trim().slice(0, 150)}`,
        description: goal.trim(),
        kind: "plan",
        tag: "objetivo",
        projectId: project.id,
      });
      requestAI(card);
      return send(res, 200, card);
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const { name, dir } = await readJson(req);
      const { project, abierto } = newProject(name, dir);
      broadcastProjects();
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, { ...project, abierto });
    }

    // Selector de carpetas del sistema (Finder, Explorador…): devuelve la ruta elegida, o null si se cancela
    if (url.pathname === "/api/carpeta/elegir" && req.method === "POST") {
      const { titulo } = await readJson(req);
      return send(res, 200, await elegirCarpeta(titulo || "Elige la carpeta de trabajo del proyecto"));
    }

    // Proyectos cuya carpeta no aparece: quitarlos de la lista o decir dónde están ahora
    if (parts[0] === "api" && parts[1] === "faltantes" && parts[2] && req.method === "POST") {
      const f = faltantes.find((x) => x.id === parts[2]);
      if (!f) return send(res, 404, { error: "Ese proyecto ya no está en la lista" });
      if (parts[3] === "quitar") faltantes = faltantes.filter((x) => x !== f);
      else if (parts[3] === "ubicar") {
        const { dir } = await readJson(req);
        const { project } = newProject(f.name, dir);
        if (project.id !== f.id) return send(res, 400, { error: `En esa carpeta hay otro proyecto («${project.name}»): se ha abierto también` });
      } else return send(res, 404, { error: "no encontrado" });
      guardarAhora();
      broadcastProjects();
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, { ok: true });
    }

    // Cambiar la carpeta de trabajo de un proyecto (su carpeta orbita/ se mueve con él)
    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "carpeta" && req.method === "POST") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { dir } = await readJson(req);
      return send(res, 200, moverProyecto(project, dir));
    }

    // Abrir la carpeta de trabajo (o su orbita/) en el Finder / Explorador
    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "mostrar" && req.method === "POST") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { orbita } = await readJson(req);
      abrirNavegador(orbita ? baseDe(project) : project.dir); // abre cualquier ruta con la app del sistema
      return send(res, 200, { ok: true });
    }

    // Solo en copias de prueba: fijar la hora del servidor para probar las programadas
    if (url.pathname === "/api/_reloj" && req.method === "POST" && process.env.ORBITA_PRUEBAS) {
      const { fijar } = await readJson(req);
      desfase = Number(fijar) - Date.now();
      revisarProgramadas();
      return send(res, 200, { ahora: ahora() });
    }

    // Papelera: restaurar o borrar del todo
    if (parts[0] === "api" && parts[1] === "papelera" && parts[2] && parts[3] === "restaurar" && req.method === "POST") {
      try {
        return send(res, 200, restaurarDePapelera(parts[2]));
      } catch (err) {
        return send(res, 404, { error: err.message });
      }
    }
    if (parts[0] === "api" && parts[1] === "papelera" && parts[2] && req.method === "DELETE") {
      const antes = board.papelera.length;
      board.papelera = board.papelera.filter((x) => x.card.id !== parts[2]);
      if (board.papelera.length === antes) return send(res, 404, { error: "No está en la papelera" });
      broadcast({ type: "papelera", papelera: papeleraPublica() });
      save();
      return send(res, 200, { ok: true });
    }

    // Guardar una tarjeta como plantilla
    if (url.pathname === "/api/plantillas" && req.method === "POST") {
      const { desde, nombre } = await readJson(req);
      const card = findCard(desde);
      if (!card) return send(res, 404, { error: "Tarjeta no encontrada" });
      const p = {
        id: crypto.randomUUID().slice(0, 8),
        nombre: String(nombre || card.title).trim().slice(0, 60) || card.title.slice(0, 60),
        icono: "⧉",
        titulo: card.title,
        descripcion: card.description,
        criterios: card.criterios.map((c) => c.texto),
        projectId: card.projectId,
        serie: false,
      };
      board.plantillas.push(p);
      broadcast({ type: "plantillas", plantillas: board.plantillas });
      save();
      return send(res, 200, p);
    }
    if (parts[0] === "api" && parts[1] === "plantillas" && parts[2] && req.method === "DELETE") {
      const p = board.plantillas.find((x) => x.id === parts[2]);
      if (!p) return send(res, 404, { error: "Esa plantilla no existe" });
      if (p.serie) return send(res, 400, { error: "Las plantillas de serie no se borran" });
      board.plantillas = board.plantillas.filter((x) => x !== p);
      broadcast({ type: "plantillas", plantillas: board.plantillas });
      save();
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/preguntas/ia" && req.method === "POST") {
      const { ia } = await readJson(req);
      preguntasIA(ia);
      return send(res, 200, { preguntasIA: board.preguntasIA });
    }

    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "ia" && req.method === "POST") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { ia } = await readJson(req);
      iaDeProyecto(project, ia);
      return send(res, 200, project);
    }

    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "pausa" && req.method === "POST") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { pausado } = await readJson(req);
      pausarProyecto(project, !!pausado);
      return send(res, 200, project);
    }

    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "edit") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { name, instructions, memory } = await readJson(req);
      if (typeof instructions === "string") project.instructions = instructions.slice(0, 20_000);
      if (typeof memory === "string") {
        project.memory = memory.slice(0, 20_000);
        project.memoryAt = Date.now();
      }
      if (String(name || "").trim()) project.name = String(name).trim().slice(0, 80); // el prefijo de sus archivos (folder) no cambia: así no se rompen enlaces
      broadcastProjects();
      return send(res, 200, project);
    }

    // Adjuntar un archivo a una tarjeta (JSON con el contenido en base64)
    if (parts[0] === "api" && parts[1] === "cards" && parts[2] && parts[3] === "attachments" && req.method === "POST") {
      const card = findCard(parts[2]);
      if (!card) return send(res, 404, { error: "Tarjeta no encontrada" });
      const { name, data } = await readJson(req, 15e6);
      const nombre = nombreSeguro(name);
      const contenido = Buffer.from(String(data || ""), "base64");
      if (!contenido.length) return send(res, 400, { error: "El archivo está vacío" });
      if (contenido.length > MAX_CONOCIMIENTO) return send(res, 413, { error: "El archivo pasa de 10 MB" });
      const rel = `${findProject(card.projectId).folder}/adjuntos/${card.id}/${nombre}`;
      fs.mkdirSync(path.dirname(safePath(rel)), { recursive: true });
      fs.writeFileSync(safePath(rel), contenido);
      card.attachments = [...card.attachments.filter((a) => a.name !== nombre), { name: nombre, path: rel, size: contenido.length }];
      log(card, "file", `Adjuntaste ${nombre}`);
      if (card.worker && ["running", "returned"].includes(card.status)) card.inbox.push({ t: Date.now(), text: `Te adjunté un archivo: ${rel} (léelo con read_file)`, kind: "comentario" });
      touch(card);
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, card);
    }

    if (parts[0] === "api" && parts[1] === "cards" && parts[2] && parts[3] === "attachments" && parts[4] && req.method === "DELETE") {
      const card = findCard(parts[2]);
      if (!card) return send(res, 404, { error: "Tarjeta no encontrada" });
      const nombre = nombreSeguro(decodeURIComponent(parts[4]));
      const adj = card.attachments.find((a) => a.name === nombre);
      if (!adj) return send(res, 404, { error: "Ese adjunto no existe" });
      if (existeArchivo(adj.path)) fs.rmSync(safePath(adj.path), { force: true }); // la persona lo quita desde el panel de la tarjeta
      card.attachments = card.attachments.filter((a) => a !== adj);
      log(card, "file", `Quitaste el adjunto ${nombre}`);
      touch(card);
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, card);
    }

    // Subir un archivo de conocimiento (JSON con el contenido en base64)
    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "knowledge" && req.method === "POST") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const { name, data } = await readJson(req, 15e6);
      const nombre = nombreSeguro(name);
      const contenido = Buffer.from(String(data || ""), "base64");
      if (!contenido.length) return send(res, 400, { error: "El archivo está vacío" });
      if (contenido.length > MAX_CONOCIMIENTO) return send(res, 413, { error: "El archivo pasa de 10 MB" });
      fs.mkdirSync(carpetaConocimiento(project), { recursive: true });
      fs.writeFileSync(path.join(carpetaConocimiento(project), nombre), contenido);
      broadcastProjects();
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, { knowledge: conocimiento(project) });
    }

    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "knowledge" && parts[4] && req.method === "DELETE") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      const archivo = path.join(carpetaConocimiento(project), nombreSeguro(decodeURIComponent(parts[4])));
      if (!fs.existsSync(archivo)) return send(res, 404, { error: "Ese archivo no existe" });
      fs.rmSync(archivo); // la persona lo quita desde el panel del proyecto
      broadcastProjects();
      broadcast({ type: "files", files: listFiles() });
      return send(res, 200, { knowledge: conocimiento(project) });
    }

    // Solo se eliminan proyectos sin tarjetas (ni archivadas). Se quita de la lista; su carpeta (y su orbita/) no se toca:
// si se vuelve a elegir esa carpeta, el proyecto se abre otra vez
    if (parts[0] === "api" && parts[1] === "projects" && parts[2] && !parts[3] && req.method === "DELETE") {
      const project = findProject(parts[2]);
      if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
      if (board.cards.some((c) => c.projectId === project.id)) return send(res, 400, { error: "El proyecto tiene tarjetas: muévelas a otro proyecto antes de eliminarlo" });
      board.projects = board.projects.filter((p) => p.id !== project.id);
      broadcastProjects();
      return send(res, 200, { ok: true });
    }

    // Archivar varias tarjetas a la vez (p. ej. todo «Hecho» del proyecto visible)
    if (url.pathname === "/api/archive" && req.method === "POST") {
      const { ids } = await readJson(req);
      const cards = (Array.isArray(ids) ? ids : []).map(findCard).filter((c) => c && !c.archivedAt && c.column === "done");
      for (const c of cards) {
        c.archivedAt = Date.now();
        log(c, "stop", "Archivada");
        touch(c);
      }
      return send(res, 200, { archived: cards.length });
    }

    if (parts[0] === "api" && parts[1] === "cards" && parts[2]) {
      const card = findCard(parts[2]);
      if (!card) return send(res, 404, { error: "Tarjeta no encontrada" });
      const action = parts[3];

      if (req.method === "DELETE" && !action) {
        removeCard(card.id);
        return send(res, 200, { ok: true });
      }

      const body = await readJson(req);

      if (action === "edit") {
        if (typeof body.title === "string" && body.title.trim()) card.title = body.title.trim().slice(0, 200);
        if (typeof body.description === "string") card.description = body.description.slice(0, 8000);
        if (typeof body.result === "string") nuevaVersion(card, body.result.slice(0, 200_000), "Tú, a mano");
        if (body.projectId !== undefined) {
          if (!findProject(body.projectId)) return send(res, 400, { error: "Elige un proyecto: toda tarjeta pertenece a uno" });
          card.projectId = body.projectId;
        }
        if (body.dependsOn !== undefined) ponerDependencias(card, body.dependsOn);
        if (body.criterios !== undefined) ponerCriterios(card, body.criterios);
        touch(card);
        return send(res, 200, card);
      }

      if (action === "programa") {
        programar(card, body.programa || null);
        touch(card);
        return send(res, 200, card);
      }

      // La persona marca (o desmarca) que un criterio no se cumple, antes de devolver la tarjeta
      if (action === "criterio") {
        const cr = card.criterios.find((c) => c.id === body.id);
        if (!cr) return send(res, 404, { error: "Ese criterio no existe" });
        cr.falla = !!body.falla;
        touch(card);
        return send(res, 200, card);
      }

      if (action === "move") {
        // Soltar en su misma columna solo cambia el orden; en otra, la mueve y la deja donde se soltó
        if (body.column === card.column) {
          colocar(card, body.beforeId);
          touch(card);
          return send(res, 200, card);
        }
        moveCard(card, body.column);
        if (body.beforeId) {
          colocar(card, body.beforeId);
          touch(card);
        }
        return send(res, 200, card);
      }

      // Escribir a la IA sin mover la tarjeta (p. ej. mientras trabaja): lo recibe en su siguiente llamada
      if (action === "comment") {
        const text = String(body.text || "").trim();
        if (!text) return send(res, 400, { error: "Escribe tu mensaje" });
        card.inbox.push({ t: Date.now(), text, kind: "comentario" });
        hilo(card, { de: "persona", tipo: "comentario", texto: text });
        log(card, "you", text);
        touch(card);
        return send(res, 200, card);
      }

      if (action === "feedback") {
        if (!String(body.text || "").trim()) return send(res, 400, { error: "Escribe tu comentario" });
        requestAI(card, body.text);
        return send(res, 200, card);
      }

      if (action === "unarchive") {
        card.archivedAt = null;
        log(card, "start", "Restaurada del archivo");
        touch(card);
        return send(res, 200, card);
      }

      if (action === "reset") {
        revocar(card, "la persona la reinició (empezar de cero)");
        Object.assign(card, { worker: null, inbox: [], log: [], result: "", versions: [], question: "", progress: 0, step: "", status: "idle", column: "backlog", files: [] });
        touch(card);
        return send(res, 200, card);
      }
    }

    if (parts[0] === "files" && req.method === "GET") {
      return serveFile(res, decodeURIComponent(parts.slice(1).join("/")));
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return servirPublico(res, rel);
    }

    send(res, 404, { error: "no encontrado" });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message || String(err) });
    else res.end();
  }
});

// Mantiene vivas las conexiones SSE.
setInterval(() => broadcast({ type: "ping" }), 25_000);

// ---------------------------------------------------------------------------
// Tareas programadas y recurrentes
// programa = { tipo: "una" | "diaria" | "semanal" | "mensual", hora: "HH:MM", fecha?: "AAAA-MM-DD",
//              dias?: [0-6] (0 = domingo), diaMes?: 1-31, proxima, ultima }
// ---------------------------------------------------------------------------

// Reloj: en las copias de prueba (ORBITA_PRUEBAS=1) se puede adelantar para probar sin esperar días
let desfase = 0;
const ahora = () => Date.now() + desfase;

function proximaVez(pg, desde) {
  const [h, m] = String(pg.hora || "09:00").split(":").map(Number);
  const en = (d) => (d.setHours(h || 0, m || 0, 0, 0), d);
  if (pg.tipo === "una") {
    const [a, mes, dia] = String(pg.fecha || "").split("-").map(Number);
    const t = new Date(a, (mes || 1) - 1, dia || 1, h || 0, m || 0).getTime();
    return t > desde ? t : null; // ya pasó: no se repite
  }
  const d = new Date(desde);
  for (let i = 0; i < 400; i++) {
    const c = en(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i));
    if (c.getTime() <= desde) continue;
    if (pg.tipo === "diaria") return c.getTime();
    if (pg.tipo === "semanal" && (pg.dias?.length ? pg.dias : [1]).includes(c.getDay())) return c.getTime();
    if (pg.tipo === "mensual") {
      const ultimoDia = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
      if (c.getDate() === Math.min(pg.diaMes || 1, ultimoDia)) return c.getTime(); // el 31 en meses cortos = último día
    }
  }
  return null;
}

function programar(card, pg) {
  if (!pg) {
    if (card.programa) log(card, "step", "Ya no se repite");
    card.programa = null;
    return;
  }
  const tipo = ["una", "diaria", "semanal", "mensual"].includes(pg.tipo) ? pg.tipo : null;
  if (!tipo) throw new Error("Tipo de repetición no válido");
  if (!/^\d{1,2}:\d{2}$/.test(String(pg.hora || ""))) throw new Error("Hora no válida (HH:MM)");
  if (tipo === "una" && !/^\d{4}-\d{2}-\d{2}$/.test(String(pg.fecha || ""))) throw new Error("Falta la fecha");
  const programa = { tipo, hora: pg.hora, ultima: card.programa?.ultima || null };
  if (tipo === "una") programa.fecha = pg.fecha;
  if (tipo === "semanal") programa.dias = [...new Set((pg.dias || []).map(Number).filter((n) => n >= 0 && n <= 6))].sort();
  if (tipo === "semanal" && !programa.dias.length) throw new Error("Elige al menos un día de la semana");
  if (tipo === "mensual") programa.diaMes = Math.min(31, Math.max(1, Number(pg.diaMes) || 1));
  programa.proxima = proximaVez(programa, ahora());
  if (!programa.proxima) throw new Error("Esa fecha ya pasó");
  card.programa = programa;
  log(card, "step", `Programada: próxima, ${new Date(programa.proxima).toLocaleString("es", { dateStyle: "full", timeStyle: "short" })}`);
}

// Llega la hora: la de una vez pasa ella misma a «En curso»; las repetidas crean una tarjeta nueva (plantilla)
function ejecutarProgramada(card) {
  const pg = card.programa;
  const t = ahora();
  pg.ultima = t;
  if (pg.tipo === "una") {
    card.programa = null;
    log(card, "start", "Llegó su hora programada");
    requestAI(card);
    return card;
  }
  const fecha = new Date(t).toLocaleDateString("es", { day: "numeric", month: "short" });
  const nueva = newCard({
    title: `${card.title} · ${fecha}`,
    description: card.description,
    origin: "programada",
    parentId: card.id,
    projectId: card.projectId,
    criterios: (card.criterios || []).map((c) => c.texto),
  });
  log(nueva, "start", `Creada por la programación de «${card.title}»`);
  requestAI(nueva); // a la cola; si el proyecto está en pausa, espera ahí
  pg.proxima = proximaVez(pg, t);
  log(card, "spawn", `Creó «${nueva.title}» (próxima: ${new Date(pg.proxima).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })})`);
  touch(card);
  return nueva;
}

function revisarProgramadas() {
  const t = ahora();
  let hubo = false;
  for (const card of [...board.cards]) {
    const pg = card.programa;
    if (!pg || card.archivedAt || !pg.proxima || pg.proxima > t) continue;
    ejecutarProgramada(card); // aunque se perdieran varias (Órbita apagada), se crea una sola
    if (pg.tipo !== "una" && pg.proxima && pg.proxima <= t) pg.proxima = proximaVez(pg, t);
    hubo = true;
  }
  if (hubo) {
    changes.emit("change");
    save();
  }
}
setInterval(revisarProgramadas, process.env.ORBITA_PRUEBAS ? 200 : 15_000);
setTimeout(revisarProgramadas, 1500); // al arrancar, por si se perdió alguna con Órbita apagada

// Solo en 127.0.0.1: desde otros equipos de la red no se puede entrar.
server.on("error", async (err) => {
  if (err.code !== "EADDRINUSE") salir(`No se pudo arrancar Órbita: ${err.message}`);
  // ¿Es otra Órbita ya abierta? Entonces basta con abrir el navegador.
  const otra = await fetch(`http://127.0.0.1:${PORT}/api/board`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json())
    .catch(() => null);
  if (otra?.version) {
    console.log(`\n  ◉ Órbita ya está abierta en http://localhost:${PORT}\n`);
    if (ABRIR_NAVEGADOR) abrirNavegador(`http://localhost:${PORT}`);
    process.exit(0);
  }
  salir(`El puerto ${PORT} lo está usando otro programa. Arranca Órbita en otro, por ejemplo:  orbita --port ${PORT + 1}\n(Recuerda cambiar también la dirección MCP en tu IA.)`);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ◉ Órbita ${VERSION_APP} está en http://localhost:${PORT}`);
  console.log(`    Conecta tu IA por MCP: http://localhost:${PORT}/mcp`);
  console.log(`    Tus datos: ${DATOS}`);
  console.log(`    Para cerrarla: Ctrl+C\n`);
  if (ABRIR_NAVEGADOR) abrirNavegador(`http://localhost:${PORT}`);
});
