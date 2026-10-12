// Tokens de cada tarjeta, sacados de los registros de sesión de Claude Code (~/.claude/projects/<carpeta>/<sesión>.jsonl).
// Órbita solo los LEE, y solo los de las carpetas de trabajo de sus proyectos. Cada respuesta de Claude trae ahí su uso
// (entrada, caché y salida); para saber de qué tarjeta es, se sigue en cada sesión qué tarjeta tiene la IA entre manos:
// - la que le da wait_for_work, o la que nombra al llamar a una herramienta de Órbita (report_progress, write_file…);
// - hasta que la entrega (submit_result) o pregunta (ask_human).
// Los registros pueden ser enormes: se leen por partes y, en cada pasada, solo lo que se ha añadido.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RAIZ = process.env.ORBITA_CLAUDE_PROYECTOS || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
// Claude Code nombra la carpeta de cada sesión con su directorio de trabajo, cambiando lo que no es letra o número por «-»
export const carpetaDeSesiones = (dir) => path.join(RAIZ, dir.replace(/[^a-zA-Z0-9]/g, "-"));

const ID = /^[0-9a-f]{8}$/;
const archivos = new Map(); // ruta -> { leido, resto, nombres: Map(tool_use_id -> nombre), actual, mensajes: Map(id -> { tarjeta, uso }) }

function procesarLinea(est, linea) {
  if (!linea.includes('"assistant"') && !linea.includes("tool_result")) return;
  let j;
  try {
    j = JSON.parse(linea);
  } catch {
    return;
  }
  const contenido = Array.isArray(j.message?.content) ? j.message.content : [];
  if (j.type === "assistant") {
    let suelta = false;
    for (const c of contenido) {
      if (c.type !== "tool_use") continue;
      est.nombres.set(c.id, c.name);
      const tarjeta = c.input?.id ?? c.input?.card_id;
      if (!/__(report_progress|submit_result|ask_human|add_comment|write_file|get_secret|update_memory|entities|update_card|get_card)$/.test(c.name) || typeof tarjeta !== "string" || !ID.test(tarjeta)) continue;
      if (/__(report_progress|submit_result|ask_human|add_comment)$/.test(c.name) || !est.actual) est.actual = tarjeta;
      if (/__(submit_result|ask_human)$/.test(c.name) && tarjeta === est.actual) suelta = true;
    }
    const m = j.message;
    if (m?.id && m.usage) {
      const ya = est.mensajes.get(m.id);
      if (ya) ya.uso = m.usage; // el mismo mensaje viene en varias líneas: cuenta una vez
      else if (est.actual) est.mensajes.set(m.id, { tarjeta: est.actual, uso: m.usage });
    }
    if (suelta) est.actual = null;
  } else if (j.type === "user") {
    for (const c of contenido) {
      if (c.type !== "tool_result" || !/__wait_for_work$/.test(est.nombres.get(c.tool_use_id) || "")) continue;
      const texto = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("");
      const id = texto.match(/"work":\s*\{\s*"id":\s*"([0-9a-f]{8})"/)?.[1];
      if (id) est.actual = id;
    }
  }
}

async function leerNuevo(ruta, est, tamano) {
  // Si el archivo se recortó o se rehízo, se empieza de cero
  if (tamano < est.leido) Object.assign(est, nuevoEstado());
  const flujo = fs.createReadStream(ruta, { start: est.leido, end: tamano - 1, encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const trozo of flujo) {
    const lineas = (est.resto + trozo).split("\n");
    est.resto = lineas.pop();
    for (const l of lineas) procesarLinea(est, l);
  }
  est.leido = tamano;
}
const nuevoEstado = () => ({ leido: 0, resto: "", nombres: new Map(), actual: null, mensajes: new Map() });

// Totales por tarjeta de todas las sesiones de esas carpetas de trabajo: Map(id -> { entrada, salida, cacheLeida, mensajes })
export async function contarTokens(dirs) {
  for (const dir of new Set(dirs)) {
    const carpeta = carpetaDeSesiones(dir);
    let nombres;
    try {
      nombres = fs.readdirSync(carpeta).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // esa carpeta nunca la ha abierto Claude Code
    }
    for (const f of nombres) {
      const ruta = path.join(carpeta, f);
      let tamano;
      try {
        tamano = fs.statSync(ruta).size;
      } catch {
        continue;
      }
      if (!archivos.has(ruta)) archivos.set(ruta, nuevoEstado());
      const est = archivos.get(ruta);
      if (tamano !== est.leido) await leerNuevo(ruta, est, tamano).catch(() => {});
    }
  }
  const totales = new Map();
  for (const est of archivos.values())
    for (const { tarjeta, uso } of est.mensajes.values()) {
      const t = totales.get(tarjeta) || { entrada: 0, salida: 0, cacheLeida: 0, mensajes: 0 };
      t.entrada += (uso.input_tokens || 0) + (uso.cache_creation_input_tokens || 0) + (uso.cache_read_input_tokens || 0);
      t.cacheLeida += uso.cache_read_input_tokens || 0;
      t.salida += uso.output_tokens || 0;
      t.mensajes++;
      totales.set(tarjeta, t);
    }
  return totales;
}
