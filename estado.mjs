// Órbita · el tablero y sus operaciones: cargarlo y guardarlo, tarjetas, proyectos, dependencias, papelera,
// IAs conectadas, colas y pausas. Lo usan server.mjs (la API para la interfaz) y mcp.mjs (las herramientas de la IA).
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { baseDe, cargar, comprobarCarpeta, guardar, leerTablero, listarArchivos, moverCarpetaOrbita, normalizarCarpeta, rutaReal, slug, tableroDe } from "./almacen.mjs";
import { DATOS, salir } from "./entorno.mjs";
import { nombresSecretos } from "./secretos.mjs";
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

export const COLUMNS = ["backlog", "doing", "review", "done"];
export let cargado;
try {
  cargado = cargar();
} catch (err) {
  salir(`No se pudo abrir el tablero: ${err.message}`);
}
export const board = cargado.board;
// Proyectos cuya carpeta de trabajo no se encuentra: siguen en la lista hasta que la persona los ubique o los quite
export let faltantes = cargado.faltantes;
// Quitar uno de la lista (la persona lo descarta): quien importa «faltantes» no puede reasignarla
export function quitarFaltante(f) {
  faltantes = faltantes.filter((x) => x !== f);
}
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
export const PLANTILLAS_DE_SERIE = [
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

export const findProject = (id) => board.projects.find((p) => p.id === id);
export const carpetaPara = (nombre) => slug(nombre, new Set(board.projects.map((p) => p.folder)));

// Proyecto en una carpeta de trabajo. Si la carpeta ya tiene orbita/tablero.json (un proyecto que
// viene de otra máquina, de un repositorio clonado o que se quitó de la lista), se abre ese.
// Devuelve { project, abierto } (abierto = ya existía en la carpeta).
export function newProject(nombre, dir) {
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
export function proyectoGeneral() {
  const dir = path.join(DATOS, "general");
  const ya = board.projects.find((p) => p.dir === dir);
  if (ya) return ya;
  fs.mkdirSync(dir, { recursive: true });
  const { project } = newProject("General", dir);
  broadcastProjects();
  return project;
}

// Cambia la carpeta de trabajo de un proyecto: su carpeta orbita/ se va con él
export function moverProyecto(project, dir) {
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
export const nombreDeObjetivo = (texto) => {
  const t = String(texto).replace(/^Planificar:\s*/, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Instrucciones para la IA en las tarjetas de objetivo: no se muestran a la persona.
export const PLAN_INSTRUCCIONES =
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
export const raizDe = (card, vistos = new Set()) => {
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


// Qué guardar: save(card) solo el tablero.json del proyecto de esa tarjeta (lo frecuente: touch, report_progress…);
// save() sin argumentos, todo, también orbita.json. Ante la duda, save(): guardar de más nunca pierde nada.
export let saveTimer = null;
export let porGuardar = new Set(); // ids de proyecto; null = todo
export function save(card) {
  if (!card) porGuardar = null;
  else porGuardar?.add(card.projectId);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(guardarAhora, 250);
}
export function guardarAhora() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const solo = porGuardar;
  porGuardar = new Set();
  guardar(board, faltantes, solo); // orbita.json + los tablero.json (y de ellos, solo se escribe lo que cambió)
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

// Un error que nadie esperaba se anota (una vez por motivo, para no llenar la consola si se repite)
export const fallosAnotados = new Set();
export function anotarFallo(donde, err) {
  const clave = `${donde}: ${err?.message ?? err}`;
  if (fallosAnotados.has(clave)) return;
  fallosAnotados.add(clave);
  console.error(`  ⚠ Error en ${donde}: ${err?.stack ?? err}`);
}
// Para los temporizadores: si una vuelta falla, se anota y la siguiente se ejecuta igual
export const protegido = (donde, fn) => () => {
  try {
    fn();
  } catch (err) {
    anotarFallo(donde, err);
  }
};
// Último recurso: se anota, se guarda lo pendiente y Órbita sigue en marcha. El tablero son datos simples
// en memoria, y cerrarse cortaría a todas las IAs conectadas en mitad de su trabajo.
for (const evento of ["uncaughtException", "unhandledRejection"]) {
  process.on(evento, (err) => {
    anotarFallo("Órbita (error no capturado)", err);
    try {
      if (saveTimer) guardarAhora();
    } catch {}
  });
}

export const findCard = (id) => board.cards.find((c) => c.id === id);

export function newCard({ title, description = "", column = "backlog", origin = "tú", parentId = null, tag = null, kind = "task", projectId = null, criterios = [] }) {
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
export function hilo(card, mensaje) {
  card.thread.push({ t: Date.now(), ...mensaje, texto: String(mensaje.texto).slice(0, 20_000) });
  if (card.thread.length > 300) card.thread.splice(0, card.thread.length - 300);
}

// Guarda el resultado como versión nueva (si no es igual al último)
// Criterios de aceptación. Al cambiar la lista se conserva lo evaluado de los que no cambian de texto.
export function ponerCriterios(card, textos) {
  const antes = new Map(card.criterios.map((c) => [c.texto, c]));
  card.criterios = [...new Set((Array.isArray(textos) ? textos : []).map((t) => String(t).replace(/^\s*[-*•\d.)\]\[ x✓✗]+\s*/i, "").trim().slice(0, 300)).filter(Boolean))]
    .slice(0, 20)
    .map((texto) => antes.get(texto) || { id: crypto.randomUUID().slice(0, 6), texto, estado: null, evidencia: "", falla: false });
}
// La IA revisa cada criterio al entregar: todos, con evidencia
export function evaluarCriterios(card, evaluacion) {
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

export function nuevaVersion(card, result, quien) {
  card.result = result;
  if (card.versions.at(-1)?.result === result) return;
  card.versions.push({ n: (card.versions.at(-1)?.n || 0) + 1, t: Date.now(), quien, result, criterios: card.criterios.length ? card.criterios.map(({ texto, estado, evidencia }) => ({ texto, estado, evidencia })) : undefined });
  if (card.versions.length > 50) card.versions.splice(0, card.versions.length - 50);
}

export function log(card, kind, text) {
  card.log.push({ t: Date.now(), kind, text: String(text).slice(0, 2000) });
  if (card.log.length > 300) card.log.splice(0, card.log.length - 300);
}

// ---------------------------------------------------------------------------
// Eventos en vivo
// ---------------------------------------------------------------------------

export const subscribers = new Set();
export const changes = new EventEmitter(); // avisa a las IAs que esperan trabajo
changes.setMaxListeners(100);

export function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(data);
}
// Una tarjeta cambió: se guarda solo el tablero de su proyecto. Si además cambia algo global
// (avisos, papelera, preguntas…), quien lo cambia llama a save() sin argumentos.
export function touch(card) {
  card.updatedAt = Date.now();
  broadcast({ type: "card", card });
  changes.emit("change");
  save(card);
}
// ---------------------------------------------------------------------------
// Conocimiento: archivos de referencia del proyecto, en <carpeta de trabajo>/orbita/conocimiento/
// ---------------------------------------------------------------------------

export const MAX_CONOCIMIENTO = 10 * 1024 * 1024; // 10 MB por archivo
export const carpetaConocimiento = (project) => path.join(baseDe(project), "conocimiento");

export function conocimiento(project) {
  const dir = carpetaConocimiento(project);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, path: `${project.folder}/conocimiento/${e.name}`, size: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Nombre de archivo seguro: sin rutas ni caracteres raros
export function nombreSeguro(nombre) {
  const limpio = path.basename(String(nombre || "")).replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim().slice(0, 120);
  if (!limpio) throw new Error("Nombre de archivo no válido");
  return limpio;
}

export const proyectosPublicos = () => board.projects.map((p) => ({ ...p, knowledge: conocimiento(p), secretos: nombresSecretos(p.id) }));

export function broadcastQuestions() {
  broadcast({ type: "questions", questions: board.questions });
  changes.emit("change"); // despierta a la IA que espera trabajo
  save();
}

export function broadcastProjects() {
  broadcast({ type: "projects", projects: proyectosPublicos(), faltantes });
  save();
}
// ---------------------------------------------------------------------------
// Dependencias: «esta tarjeta espera a…»
// ---------------------------------------------------------------------------

// Las que faltan (una dependencia cuenta como cumplida cuando está en Hecho, aunque se archive)
export const dependenciasPendientes = (card) => (card.dependsOn || []).map(findCard).filter((d) => d && d.column !== "done");

export function ponerDependencias(card, ids) {
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
export function liberarDependientes(id) {
  for (const c of board.cards) {
    if (!c.dependsOn?.includes(id)) continue;
    if (dependenciasPendientes(c).length === 0) log(c, "start", "Desbloqueada: ya están hechas las tarjetas a las que esperaba");
    touch(c);
  }
}

// La persona le quita la tarjeta a la IA que la trabaja: se guarda un aviso para
// que su siguiente llamada sobre ella reciba «DETENTE» (y wait_for_work lo cuente).
export const TRABAJANDO = ["running", "returned", "waiting"];
export function revocar(card, motivo) {
  if (!card.worker || !TRABAJANDO.includes(card.status)) return;
  const at = Date.now();
  card.revocada = { worker: card.worker, motivo, at };
  board.notices.push({ worker: card.worker, cardId: card.id, title: card.title, motivo, at, delivered: false });
  if (board.notices.length > 200) board.notices.splice(0, board.notices.length - 200);
  log(card, "stop", `Se avisará a ${card.worker} para que se detenga (${motivo})`);
  save(); // los avisos van en orbita.json
}

// A la papelera (lo que borra una IA): se guarda entera para poder restaurarla
export function aLaPapelera(card, por, motivo) {
  const copia = JSON.parse(JSON.stringify(card));
  removeCard(card.id, `${por} la borró${motivo ? `: ${motivo}` : ""}`);
  board.papelera.unshift({ card: copia, borradaEn: Date.now(), por, motivo: motivo || "" });
  if (board.papelera.length > 300) board.papelera.length = 300;
  broadcast({ type: "papelera", papelera: papeleraPublica(), borrada: { id: copia.id, title: copia.title, por } });
  save();
}
export const papeleraPublica = () => board.papelera.map((x) => ({ id: x.card.id, title: x.card.title, projectId: x.card.projectId, column: x.card.column, borradaEn: x.borradaEn, por: x.por, motivo: x.motivo }));
export function restaurarDePapelera(id) {
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
  save(); // la papelera va en orbita.json
  return card;
}

export function removeCard(id, motivo = "la persona eliminó la tarjeta") {
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
export const brains = new Map();
export function seen(name, listening) {
  if (!name) return;
  const b = brains.get(name) || { name, listening: 0 };
  b.lastSeen = Date.now();
  if (listening != null) b.listening = Math.max(0, b.listening + listening);
  brains.set(name, b);
  broadcastBrains();
}
// ¿Está conectada esta IA? (escuchando ahora, o se la vio hace menos de 2 minutos)
export function conectada(name) {
  const b = name && brains.get(name);
  return !!b && (b.listening > 0 || Date.now() - b.lastSeen < 120_000);
}
// La IA de preguntas: solo responde preguntas rápidas; mientras esté conectada, las demás no las toman
export function preguntasIA(ia) {
  board.preguntasIA = String(ia || "").trim().slice(0, 60) || null;
  broadcast({ type: "preguntasIA", ia: board.preguntasIA });
  changes.emit("change");
  save();
}
export function brainList() {
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
export let lastBrains = "";
export function broadcastBrains() {
  const list = brainList();
  const key = JSON.stringify(list);
  if (key === lastBrains) return;
  lastBrains = key;
  broadcast({ type: "brains", brains: list });
  changes.emit("change"); // si se desconecta la IA de preguntas, las demás vuelven a mirar si les toca alguna
}
setInterval(protegido("el aviso de IAs conectadas", broadcastBrains), 10_000);

// ---------------------------------------------------------------------------
// Acciones del tablero (las usan la web y el MCP)
// ---------------------------------------------------------------------------

// Archivos de todos los proyectos, como rutas «<folder>/…» (ver almacen.mjs)
export const listFiles = () => listarArchivos(board.projects);

export function safePath(rel) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("Ruta vacía");
  return rutaReal(rel, board.projects);
}
export function existeArchivo(rel) {
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

export const enColumna = (column, sinId) => board.cards.filter((c) => c.column === column && c.id !== sinId && !c.archivedAt).sort((a, b) => a.order - b.order);

// Coloca la tarjeta en su columna justo antes de `antesDe` (id), o al final si no se indica
export function colocar(card, antesDe) {
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

export function requestAI(card, note) {
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

export function moveCard(card, column) {
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
export const enPausa = (card) => !!findProject(card.projectId)?.pausado;

// Una IA por proyecto: si un proyecto tiene su IA (project.ia), solo ella toma sus tarjetas y preguntas,
// y esa IA solo trabaja en su(s) proyecto(s). Así dos proyectos avanzan en paralelo sin pisarse.
export function elegible(projectId, worker) {
  const mios = board.projects.filter((p) => p.ia === worker).map((p) => p.id);
  if (mios.length) return mios.includes(projectId);
  return !findProject(projectId)?.ia;
}
export function iaDeProyecto(project, ia) {
  project.ia = String(ia || "").trim().slice(0, 60) || null;
  broadcastProjects();
  changes.emit("change"); // las IAs que esperan vuelven a mirar qué les toca
  save();
}
export function pausarProyecto(project, pausado) {
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

export function claim(card, worker) {
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
