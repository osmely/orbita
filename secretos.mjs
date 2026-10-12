// Secretos de cada proyecto (claves de API, tokens, contraseñas de servicios…): la IA los usa sin que
// nadie los escriba en las tarjetas. Se guardan en la carpeta de datos de Órbita (secretos.json, que solo
// puede leer la persona), nunca en <carpeta de trabajo>/orbita/: esa carpeta viaja con el proyecto y puede
// acabar en un repositorio.
//
//   secretos.json = { <id del proyecto>: { <NOMBRE>: { valor, t } } }
import "./arranque.mjs"; // antes de leer secretos.json (ver arranque.mjs)
import fs from "node:fs";
import path from "node:path";
import { DATOS } from "./entorno.mjs";

const ARCHIVO = path.join(DATOS, "secretos.json");
const NOMBRE = /^[A-Z_][A-Z0-9_]{0,63}$/; // como una variable de entorno: así la IA puede ponerlo tal cual en un .env
const MAX_VALOR = 10_000;
const MIN_TAPAR = 6; // los valores más cortos no se tapan en los textos: se confundirían con palabras normales

// Si secretos.json está dañado, Órbita arranca igual pero no lo sobrescribe (se perderían los secretos)
let danado = null;
let datos = {};
try {
  datos = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    danado = `No se pudo leer ${ARCHIVO} (${err.message}): arréglalo o bórralo para guardar secretos`;
    console.error(`  ${danado}`);
  }
}

function guardar() {
  if (danado) throw new Error(danado);
  const tmp = ARCHIVO + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, ARCHIVO);
  tapables = calcularTapables();
}

const comprobarNombre = (nombre) => {
  if (!NOMBRE.test(String(nombre || ""))) throw new Error("El nombre va en mayúsculas, números y _ (como STRIPE_API_KEY), y empieza por una letra o _");
  return nombre;
};

// Solo nombres y fechas: el valor nunca sale hacia la interfaz
export const nombresSecretos = (projectId) =>
  Object.entries(datos[projectId] || {})
    .map(([nombre, s]) => ({ nombre, t: s.t }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

export function ponerSecreto(projectId, nombre, valor) {
  comprobarNombre(nombre);
  if (typeof valor !== "string" || !valor) throw new Error("Falta el valor del secreto");
  if (valor.length > MAX_VALOR) throw new Error("El valor pasa de 10.000 caracteres");
  (datos[projectId] ??= {})[nombre] = { valor, t: Date.now() };
  guardar();
}

export function quitarSecreto(projectId, nombre) {
  if (!datos[projectId]?.[nombre]) throw new Error(`No hay ningún secreto ${nombre} en este proyecto`);
  delete datos[projectId][nombre];
  if (!Object.keys(datos[projectId]).length) delete datos[projectId];
  guardar();
}

export function quitarSecretosDe(projectId) {
  if (!datos[projectId]) return;
  delete datos[projectId];
  guardar();
}

export function leerSecreto(projectId, nombre) {
  const s = datos[projectId]?.[nombre];
  if (!s) {
    const hay = nombresSecretos(projectId).map((x) => x.nombre);
    throw new Error(`Este proyecto no tiene el secreto «${nombre}». ${hay.length ? `Tiene: ${hay.join(", ")}.` : "No tiene ninguno: pídeselo a la persona (se añaden en Contexto para la IA → Secretos)."}`);
  }
  return s.valor;
}

// Si la IA pega un valor en lo que se ve en el tablero (resultado, progreso, comentarios…), se tapa con su nombre.
// Se tapan los de todos los proyectos: un secreto lo es esté donde esté. Los más largos primero, por si uno contiene a otro.
function calcularTapables() {
  const lista = [];
  for (const secretos of Object.values(datos)) for (const [nombre, s] of Object.entries(secretos)) if (s.valor.length >= MIN_TAPAR) lista.push([s.valor, `«secreto ${nombre}»`]);
  return lista.sort((a, b) => b[0].length - a[0].length);
}
let tapables = calcularTapables();

export function taparSecretos(x) {
  if (!tapables.length) return x;
  if (typeof x === "string") {
    for (const [valor, nombre] of tapables) if (x.includes(valor)) x = x.replaceAll(valor, nombre);
    return x;
  }
  if (Array.isArray(x)) return x.map(taparSecretos);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, taparSecretos(v)]));
  return x;
}
