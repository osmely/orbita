// Órbita · tareas programadas y recurrentes.
import { anotarFallo, board, changes, log, newCard, protegido, requestAI, save, touch } from "./estado.mjs";
// ---------------------------------------------------------------------------
// Tareas programadas y recurrentes
// programa = { tipo: "una" | "diaria" | "semanal" | "mensual", hora: "HH:MM", fecha?: "AAAA-MM-DD",
//              dias?: [0-6] (0 = domingo), diaMes?: 1-31, proxima, ultima }
// ---------------------------------------------------------------------------

// Reloj: en las copias de prueba (ORBITA_PRUEBAS=1) se puede adelantar para probar sin esperar días
export let desfase = 0;
export const ahora = () => Date.now() + desfase;
// Solo en pruebas: fija el reloj de las tareas programadas en un instante dado
export function fijarReloj(t) {
  desfase = Number(t) - Date.now();
}

export function proximaVez(pg, desde) {
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

export function programar(card, pg) {
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
export function ejecutarProgramada(card) {
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

export function revisarProgramadas() {
  const t = ahora();
  let hubo = false;
  for (const card of [...board.cards]) {
    const pg = card.programa;
    if (!pg || card.archivedAt || !pg.proxima || pg.proxima > t) continue;
    hubo = true;
    try {
      ejecutarProgramada(card); // aunque se perdieran varias (Órbita apagada), se crea una sola
      if (pg.tipo !== "una" && pg.proxima && pg.proxima <= t) pg.proxima = proximaVez(pg, t);
    } catch (err) {
      // Pasa a su próxima vez: si no, se repetiría en cada vuelta (y podría crear copias sin parar)
      anotarFallo(`la tarea programada «${card.title}»`, err);
      try {
        pg.proxima = pg.tipo === "una" ? null : proximaVez(pg, t);
        log(card, "step", `No se pudo ejecutar su programación: ${err.message}`);
      } catch {
        pg.proxima = null;
      }
    }
  }
  if (hubo) {
    changes.emit("change");
    save();
  }
}
setInterval(protegido("las tareas programadas", revisarProgramadas), process.env.ORBITA_PRUEBAS ? 200 : 15_000);
setTimeout(protegido("las tareas programadas", revisarProgramadas), 1500); // al arrancar, por si se perdió alguna con Órbita apagada
