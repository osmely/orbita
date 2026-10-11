// Dónde se guarda el tablero. Cada proyecto vive en su carpeta de trabajo:
//
//   <carpeta de trabajo>/orbita/tablero.json   el proyecto y sus tarjetas
//   <carpeta de trabajo>/orbita/…              lo que escribe la IA, adjuntos/ y conocimiento/
//
// En la carpeta de datos de Órbita solo queda orbita.json: la lista de proyectos (con su carpeta)
// y lo que no es de ningún proyecto (preguntas rápidas, plantillas, papelera, avisos para las IAs).
//
// Las rutas de archivos son «virtuales»: «<proyecto.folder>/<resto>» (así se enlazan en los
// resultados como /files/<proyecto.folder>/…) y se resuelven a <carpeta de trabajo>/orbita/<resto>.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DATOS } from "./entorno.mjs";

export const CARPETA = "orbita"; // la carpeta de Órbita dentro de cada carpeta de trabajo
export const TABLERO = "tablero.json";
const GLOBAL = path.join(DATOS, "orbita.json");
const LEGADO = path.join(DATOS, "data", "board.json"); // formato 1: todo en un único JSON
const ENTREGABLES_LEGADO = path.join(DATOS, "entregables");
const FORMATO = 2;

export const baseDe = (p) => path.join(p.dir, CARPETA);
export const tableroDe = (dir) => path.join(dir, CARPETA, TABLERO);
const nuevoId = () => crypto.randomUUID().slice(0, 8);
const ultimoProyecto = new Map(); // id de tarjeta -> proyecto en cuyo tablero.json está guardada (ver guardar)

// Lo que se guarda del proyecto en su tablero.json (dir y knowledge se calculan al cargar)
const datosDelProyecto = ({ dir, knowledge, ...resto }) => resto;

// "Mejoras de Órbita" -> "mejoras-de-orbita": el prefijo de sus rutas de archivos, único en este Órbita
export function slug(nombre, ocupadas) {
  const base =
    String(nombre)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "proyecto";
  let s = base;
  for (let i = 2; ocupadas.has(s); i++) s = `${base}-${i}`;
  return s;
}

// --- Carpetas de trabajo ----------------------------------------------------------------

// Ruta absoluta y limpia («~/web» -> /Users/…/web). No comprueba nada más.
export function normalizarCarpeta(dir) {
  let d = String(dir || "").trim();
  if (!d) throw new Error("Falta la carpeta de trabajo del proyecto");
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) d = path.join(os.homedir(), d.slice(1));
  if (!path.isAbsolute(d)) throw new Error(`La carpeta de trabajo tiene que ser una ruta completa: «${dir}»`);
  return path.resolve(d);
}

// ¿Sirve esta carpeta como carpeta de trabajo de un proyecto nuevo (o para mover uno)?
export function comprobarCarpeta(dir, proyectos, excepto = null) {
  let info;
  try {
    info = fs.statSync(dir);
  } catch {
    throw new Error(`No existe la carpeta ${dir}`);
  }
  if (!info.isDirectory()) throw new Error(`${dir} no es una carpeta`);
  for (const p of proyectos) {
    if (p === excepto) continue;
    if (p.dir === dir) throw new Error(`Esa carpeta ya es la de «${p.name}»`);
    if (dir.startsWith(baseDe(p) + path.sep)) throw new Error(`Esa carpeta está dentro de la carpeta de Órbita de «${p.name}»`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`Órbita no puede escribir en ${dir}`);
  }
}

// Lee <dir>/orbita/tablero.json. Devuelve { proyecto, tarjetas } o lanza un error con el motivo.
export function leerTablero(dir) {
  const archivo = tableroDe(dir);
  if (!fs.existsSync(dir)) throw new Error("la carpeta de trabajo ya no existe (¿se movió o se borró?)");
  if (!fs.existsSync(archivo)) throw new Error(`falta ${CARPETA}/${TABLERO} en la carpeta de trabajo`);
  const datos = JSON.parse(fs.readFileSync(archivo, "utf8"));
  if (!datos?.proyecto?.id || !Array.isArray(datos.tarjetas)) throw new Error(`${CARPETA}/${TABLERO} no tiene el formato de Órbita`);
  return { proyecto: datos.proyecto, tarjetas: datos.tarjetas };
}

// --- Cargar ------------------------------------------------------------------------------

// Devuelve { board, faltantes, migrado }. faltantes: proyectos cuya carpeta no se pudo leer
// (se conservan en la lista para que la persona los vuelva a ubicar o los quite).
export function cargar() {
  if (!fs.existsSync(GLOBAL) && fs.existsSync(LEGADO)) return { ...migrar(), migrado: true };
  let global = {};
  try {
    global = JSON.parse(fs.readFileSync(GLOBAL, "utf8"));
  } catch (err) {
    if (fs.existsSync(GLOBAL)) throw new Error(`No se pudo leer ${GLOBAL}: ${err.message}`);
  }
  const board = { ...global, cards: [], projects: [] };
  delete board.proyectos;
  delete board.formato;
  const faltantes = [];
  for (const entrada of global.proyectos || []) {
    try {
      const { proyecto, tarjetas } = leerTablero(entrada.dir);
      if (board.projects.some((p) => p.id === proyecto.id)) throw new Error("es una copia de otro proyecto ya abierto (mismo id)");
      board.projects.push({ ...proyecto, dir: entrada.dir });
      board.cards.push(...tarjetas.map((c) => ({ ...c, projectId: proyecto.id })));
      for (const c of tarjetas) ultimoProyecto.set(c.id, proyecto.id); // por si una cambia de proyecto antes del primer guardado
    } catch (err) {
      faltantes.push({ id: entrada.id, name: entrada.name, dir: entrada.dir, motivo: err.message });
    }
  }
  // Prefijos de archivos únicos (por si se abrió un proyecto de otra máquina con el mismo)
  const usadas = new Set();
  for (const p of board.projects) {
    if (!p.folder || usadas.has(p.folder)) p.folder = slug(p.name, usadas);
    usadas.add(p.folder);
  }
  return { board, faltantes, migrado: false };
}

// Formato 1 -> 2: cada proyecto pasa a tener como carpeta de trabajo la de sus entregables
// (entregables/<folder>/), y lo que había dentro pasa a <folder>/orbita/, junto a su tablero.json.
// Así todas las rutas de archivos (<folder>/…) siguen apuntando a lo mismo. Las tarjetas sin
// proyecto van a «General», en la carpeta de datos. El JSON antiguo se conserva como board.v1.json.
function migrar() {
  const viejo = JSON.parse(fs.readFileSync(LEGADO, "utf8"));
  const projects = viejo.projects || [];
  const cards = viejo.cards || [];
  const existe = (id) => projects.some((p) => p.id === id);
  // Una tarjeta sin proyecto hereda el de su tarjeta madre (planes antiguos)
  const raiz = (c, vistos = new Set()) => {
    if (existe(c.projectId)) return c.projectId;
    if (!c.parentId || vistos.has(c.id)) return null;
    vistos.add(c.id);
    const madre = cards.find((x) => x.id === c.parentId);
    return madre ? raiz(madre, vistos) : null;
  };
  for (const c of cards) c.projectId = raiz(c);
  const sueltas = cards.filter((c) => !c.projectId);
  if (sueltas.length) {
    const general = { id: nuevoId(), name: "General", folder: slug("general", new Set(projects.map((p) => p.folder))), instructions: "", memory: "", memoryAt: null, createdAt: Date.now() };
    general.dir = path.join(DATOS, "general");
    projects.push(general);
    for (const c of sueltas) c.projectId = general.id;
  }
  for (const p of projects) {
    p.dir ??= path.join(ENTREGABLES_LEGADO, p.folder);
    const base = baseDe(p);
    if (fs.existsSync(p.dir) && !fs.existsSync(base)) {
      // Lo que había (entregables, adjuntos, conocimiento) pasa entero a <dir>/orbita/
      const tmp = `${p.dir}.migrando-${nuevoId()}`;
      fs.renameSync(p.dir, tmp);
      fs.mkdirSync(p.dir, { recursive: true });
      fs.renameSync(tmp, base);
    }
    fs.mkdirSync(base, { recursive: true });
  }
  const { cards: _c, projects: _p, ...resto } = viejo;
  const board = { ...resto, cards, projects };
  guardar(board, []);
  fs.renameSync(LEGADO, path.join(path.dirname(LEGADO), "board.v1.json"));
  console.log(`  Órbita pasó a guardar cada proyecto en su carpeta de trabajo (${projects.length} proyectos). El JSON anterior quedó en data/board.v1.json.`);
  return { board, faltantes: [] };
}

// --- Guardar -----------------------------------------------------------------------------

const escrito = new Map(); // archivo -> último contenido escrito (para no reescribir lo que no cambia)
const fallos = new Set();
export const serializados = []; // archivos convertidos a JSON en el último guardado (para las pruebas)
function escribirSiCambia(archivo, datos) {
  const texto = JSON.stringify(datos, null, 1);
  serializados.push(archivo);
  if (escrito.get(archivo) === texto) return;
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo + ".tmp", texto);
    fs.renameSync(archivo + ".tmp", archivo);
    escrito.set(archivo, texto);
    fallos.delete(archivo);
  } catch (err) {
    // Una carpeta de proyecto que desapareció no puede tumbar Órbita: se avisa una vez y se reintenta en el siguiente guardado
    if (!fallos.has(archivo)) console.error(`  No se pudo guardar ${archivo}: ${err.message}`);
    fallos.add(archivo);
  }
}

// Guarda orbita.json y el tablero.json de cada proyecto. Con soloProyectos (ids), solo esos tableros: convertir
// a JSON todos los proyectos en cada report_progress sobra. Se añaden siempre el proyecto del que salió una
// tarjeta que cambió de proyecto y los archivos que no se pudieron escribir la última vez.
export function guardar(board, faltantes, soloProyectos = null) {
  const { cards, projects, ...global } = board;
  serializados.length = 0;
  if (!soloProyectos || fallos.has(GLOBAL))
    escribirSiCambia(GLOBAL, {
      formato: FORMATO,
      proyectos: [...projects.map((p) => ({ id: p.id, name: p.name, dir: p.dir })), ...faltantes.map(({ id, name, dir }) => ({ id, name, dir }))],
      ...global,
    });
  let aGuardar = projects;
  if (soloProyectos) {
    const ids = new Set(soloProyectos);
    for (const c of cards) {
      const antes = ultimoProyecto.get(c.id);
      if (ids.has(c.projectId) && antes && antes !== c.projectId) ids.add(antes);
    }
    aGuardar = projects.filter((p) => ids.has(p.id) || fallos.has(tableroDe(p.dir)));
  }
  for (const p of aGuardar) {
    const tarjetas = cards.filter((c) => c.projectId === p.id);
    escribirSiCambia(tableroDe(p.dir), { formato: FORMATO, proyecto: datosDelProyecto(p), tarjetas });
    for (const c of tarjetas) ultimoProyecto.set(c.id, p.id);
  }
}

// --- Archivos de los proyectos ------------------------------------------------------------

// «<folder>/<resto>» -> ruta real dentro de <carpeta de trabajo>/orbita/. Nunca sale de ahí.
export function rutaReal(rel, projects) {
  const limpio = String(rel || "").replaceAll("\\", "/").replace(/^\.?\/+/, "");
  const [folder, ...resto] = limpio.split("/");
  const p = projects.find((x) => x.folder === folder);
  if (!p) throw new Error(`La ruta tiene que empezar por la carpeta de un proyecto (${projects.map((x) => `${x.folder}/`).join(", ") || "no hay proyectos"}): «${rel}»`);
  const base = baseDe(p);
  const full = path.resolve(base, resto.join("/"));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Ruta fuera de la carpeta del proyecto");
  if (full === tableroDe(p.dir) || full.startsWith(tableroDe(p.dir) + ".")) throw new Error(`${CARPETA}/${TABLERO} es el tablero del proyecto: no es un entregable`);
  // Un enlace simbólico dentro de orbita/ no puede llevar fuera: se mira dónde acaba de verdad (o, si el archivo
  // aún no existe, dónde acaba la carpeta en la que se creará). Un enlace roto cuenta como existente: escribir en él
  // crearía su destino.
  const existe = (f) => fs.lstatSync(f, { throwIfNoEntry: false }) !== undefined;
  let existente = full;
  while (existente !== base && !existe(existente)) existente = path.dirname(existente);
  if (existe(base)) {
    let real;
    try {
      real = fs.realpathSync(existente);
    } catch {
      real = null; // enlace roto
    }
    const baseReal = fs.realpathSync(base);
    if (!real || (real !== baseReal && !real.startsWith(baseReal + path.sep))) throw new Error("Ruta fuera de la carpeta del proyecto (enlace simbólico)");
  }
  return full;
}

// Todos los archivos de todos los proyectos, como rutas virtuales
export function listarArchivos(projects) {
  const out = [];
  const recorrer = (dir, prefijo, raiz) => {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (e.name === ".DS_Store" || e.name === ".git" || e.name === "node_modules") continue;
      if (raiz && (e.name === TABLERO || e.name.startsWith(TABLERO + "."))) continue;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), `${prefijo}${e.name}/`, false);
      else out.push(prefijo + e.name);
    }
  };
  for (const p of projects) recorrer(baseDe(p), `${p.folder}/`, true);
  return out;
}

// Pasa la carpeta orbita/ de un proyecto a otra carpeta de trabajo (o la crea allí si no había nada)
export function moverCarpetaOrbita(p, nuevoDir) {
  const destino = path.join(nuevoDir, CARPETA);
  if (fs.existsSync(destino)) throw new Error(`Ya hay una carpeta «${CARPETA}» en ${nuevoDir}: muévela o bórrala antes`);
  const origen = baseDe(p);
  if (fs.existsSync(origen)) {
    try {
      fs.renameSync(origen, destino);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      fs.cpSync(origen, destino, { recursive: true }); // otro disco: copiar y borrar
      fs.rmSync(origen, { recursive: true, force: true });
    }
  } else fs.mkdirSync(destino, { recursive: true });
}
