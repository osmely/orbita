// Entidades de un proyecto: lo que existe en él y perdura, agrupado por categorías (los personajes de un juego,
// sus armas y objetos, las personas de un informe, los lugares de una novela…). La IA las va extrayendo mientras
// trabaja y la persona las ve como fichas y las edita. Viven en el tablero.json del proyecto (p.entidades), así
// que viajan con su carpeta; sus imágenes, en <carpeta>/orbita/entidades/.
//
//   entidad = { id, categoria, nombre, resumen, detalles (Markdown), etiquetas: [], imagen (ruta virtual) | null,
//               creada: { t, por }, actualizada: { t, por } }
import crypto from "node:crypto";

export const MAX_ENTIDADES = 2000;
export const IMAGEN = /\.(png|jpe?g|gif|webp)$/i;
const texto = (v, max) => String(v ?? "").trim().slice(0, max);
const clave = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// «personajes» y «Personajes» son la misma categoría: se conserva cómo se escribió la primera vez
function categoriaDe(p, nombre) {
  const c = texto(nombre, 40);
  if (!c) throw new Error("Falta la categoría (p. ej. Personajes, Armas, Objetos, Personas, Lugares)");
  return (p.entidades || []).find((e) => clave(e.categoria) === clave(c))?.categoria || c.charAt(0).toUpperCase() + c.slice(1);
}

const etiquetasDe = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => texto(x, 30))
    .filter(Boolean))].slice(0, 20);

// Crea o actualiza. Sin id, si ya hay una con la misma categoría y nombre se actualiza esa: así, extraer dos veces
// lo mismo no la duplica. Solo cambia lo que se pasa. Devuelve { entidad, creada }.
export function guardarEntidad(p, datos, quien) {
  p.entidades ??= [];
  const ahora = { t: Date.now(), por: quien };
  let e = datos.id ? p.entidades.find((x) => x.id === datos.id) : null;
  if (datos.id && !e) throw new Error(`No hay ninguna entidad con id «${datos.id}» en «${p.name}»`);
  const categoria = datos.categoria != null ? categoriaDe(p, datos.categoria) : e?.categoria;
  const nombre = datos.nombre != null ? texto(datos.nombre, 120) : e?.nombre;
  if (!categoria) throw new Error("Falta la categoría (p. ej. Personajes, Armas, Objetos, Personas, Lugares)");
  if (!nombre) throw new Error("Falta el nombre de la entidad");
  const otra = p.entidades.find((x) => x !== e && clave(x.categoria) === clave(categoria) && clave(x.nombre) === clave(nombre));
  let mismoNombre = nombre;
  if (!e && otra) {
    e = otra; // ya existía: se actualiza, y conserva su nombre tal como se escribió («aria» no renombra a «Aria»)
    mismoNombre = otra.nombre;
  } else if (e && otra) throw new Error(`Ya hay otra entidad «${nombre}» en ${categoria}`);
  const creada = !e;
  if (creada) {
    if (p.entidades.length >= MAX_ENTIDADES) throw new Error(`El proyecto ya tiene ${MAX_ENTIDADES} entidades: borra alguna antes`);
    e = { id: crypto.randomUUID().slice(0, 8), categoria, nombre, resumen: "", detalles: "", etiquetas: [], imagen: null, creada: ahora };
    p.entidades.push(e);
  }
  e.categoria = categoria;
  e.nombre = mismoNombre;
  if (datos.resumen != null) e.resumen = texto(datos.resumen, 500);
  if (datos.detalles != null) e.detalles = texto(datos.detalles, 20_000);
  if (datos.etiquetas != null) e.etiquetas = etiquetasDe(datos.etiquetas);
  if (datos.imagen !== undefined) e.imagen = datos.imagen || null;
  e.actualizada = ahora;
  return { entidad: e, creada };
}

export function quitarEntidad(p, id) {
  const e = (p.entidades || []).find((x) => x.id === id);
  if (!e) throw new Error(`No hay ninguna entidad con id «${id}» en «${p.name}»`);
  p.entidades = p.entidades.filter((x) => x !== e);
  return e;
}

// Lo que la IA recibe con cada tarjeta: los nombres por categoría (con su id), sin detalles. Si son muchas, se corta.
export function indiceEntidades(p, max = 6000) {
  const lista = p?.entidades || [];
  if (!lista.length) return undefined;
  const indice = {};
  let largo = 0;
  for (const e of [...lista].sort((a, b) => a.categoria.localeCompare(b.categoria) || a.nombre.localeCompare(b.nombre))) {
    const linea = `${e.nombre} (${e.id})`;
    largo += linea.length;
    if (largo > max) {
      indice["…"] = [`y ${lista.length - Object.values(indice).flat().length} más: búscalas con entities`];
      break;
    }
    (indice[e.categoria] ??= []).push(linea);
  }
  return indice;
}

// Buscar por categoría y texto (sin tildes ni mayúsculas; con varias palabras, deben estar todas)
export function buscarEntidades(p, { categoria, consulta } = {}) {
  const palabras = clave(consulta || "").split(/\s+/).filter(Boolean);
  return (p?.entidades || []).filter((e) => {
    if (categoria && clave(e.categoria) !== clave(categoria)) return false;
    const todo = clave([e.nombre, e.categoria, e.resumen, e.detalles, ...(e.etiquetas || [])].join(" "));
    return palabras.every((w) => todo.includes(w));
  });
}
