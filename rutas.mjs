// La API del tablero como tabla: [método, ruta, manejador]. «:x» es un trozo cualquiera de la ruta y «:x?» uno
// opcional al final; «*» acepta cualquier método. Gana la primera fila que encaja (ver encontrarRuta). Cada
// manejador recibe { req, res, url, parts } (parts: la ruta en trozos) y, con deTarjeta / deProyecto / dePregunta,
// también la tarjeta, el proyecto o la pregunta (si no existe, responde 404).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { baseDe, serializados } from "./almacen.mjs";
import { elegirCarpeta } from "./carpetas.mjs";
import { IMAGEN, guardarEntidad, quitarEntidad } from "./entidades.mjs";
import { PORT, VERSION, VISTA, abrirNavegador } from "./entorno.mjs";
import { configuracionHooks, registrarEvento, ultimoEvento } from "./claude.mjs";
import { nombresSecretos, ponerSecreto, quitarSecreto, quitarSecretosDe } from "./secretos.mjs";
import { MAX_CONOCIMIENTO, board, brainList, broadcast, broadcastProjects, broadcastQuestions, carpetaConocimiento, colocar, conocimiento, existeArchivo, faltantes, findCard, findProject, guardarAhora, hilo, iaDeProyecto, listFiles, log, moveCard, moverProyecto, newCard, newProject, nombreDeObjetivo, nombreSeguro, nuevaVersion, papeleraPublica, pausarProyecto, ponerCriterios, ponerDependencias, preguntasIA, proyectosPublicos, quitarFaltante, removeCard, requestAI, restaurarDePapelera, revocar, safePath, save, touch } from "./estado.mjs";
import { ahora, fijarReloj, programar, revisarProgramadas } from "./programadas.mjs";

// Respuestas y cuerpos JSON (también los usa server.mjs)
export function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Se juntan los bytes y se decodifican una sola vez: una ñ o un emoji partido entre dos trozos se corrompería
export async function readJson(req, max = 5e6) {
  const trozos = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw new Error("Cuerpo demasiado grande");
    trozos.push(chunk);
  }
  const raw = Buffer.concat(trozos).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// La tarjeta de la ruta (parts[2]) y el cuerpo de la petición
const deTarjeta = (fn) => async (c) => {
  const card = findCard(c.parts[2]);
  if (!card) return send(c.res, 404, { error: "Tarjeta no encontrada" });
  return fn({ ...c, card, body: c.req.method === "DELETE" && !c.parts[3] ? {} : await readJson(c.req) });
};
// El proyecto de la ruta (parts[2])
const deProyecto = (fn) => async (c) => {
  const project = findProject(c.parts[2]);
  if (!project) return send(c.res, 404, { error: "Proyecto no encontrado" });
  return fn({ ...c, project });
};
// La pregunta rápida de la ruta (parts[2])
const dePregunta = (fn) => async (c) => {
  const q = board.questions.find((x) => x.id === c.parts[2]);
  if (!q) return send(c.res, 404, { error: "Pregunta no encontrada" });
  return fn({ ...c, q });
};
// Las imágenes que subió la persona a una entidad se borran con ella (las que eligió la IA, no: son entregables)
function borrarImagenDeEntidad(project, e) {
  if (e?.imagen?.startsWith(`${project.folder}/entidades/`) && existeArchivo(e.imagen)) fs.rmSync(safePath(e.imagen), { force: true });
}

// Adónde mandan sus eventos los hooks de Claude Code que la persona añada (ver claude.mjs)
const URL_EVENTOS = `http://127.0.0.1:${PORT}/api/claude/evento`;

export const RUTAS = [
  // Lo que hace Claude Code, por sus hooks http. Sin cuerpo, salvo que haya que contestarle algo
  // (p. ej. que no pare con la tarjeta en curso: ver claude.mjs)
  ["POST", "/api/claude/evento", async ({ req, res }) => {
    const { respuesta } = registrarEvento(await readJson(req, 20e6));
    if (respuesta) return send(res, 200, respuesta);
    res.writeHead(204);
    res.end();
  }],
  // El bloque de hooks para copiar, y si están llegando eventos
  ["GET", "/api/claude/hooks", async ({ res }) => send(res, 200, { url: URL_EVENTOS, configuracion: configuracionHooks(URL_EVENTOS), ultimoEvento: ultimoEvento() })],
  ["POST", "/api/salir", async ({ res }) => {
        guardarAhora();
        send(res, 200, { ok: true });
        broadcast({ type: "cerrada" });
        setTimeout(() => process.exit(0), 200);
        return;
  }],
  ["GET", "/api/board", async ({ res }) => {
        return send(res, 200, { cards: board.cards, projects: proyectosPublicos(), faltantes, questions: board.questions, preguntasIA: board.preguntasIA, plantillas: board.plantillas, papelera: papeleraPublica(), files: listFiles(), brains: brainList(), version: VERSION, mcpUrl: `http://localhost:${PORT}/mcp`, vista: VISTA });
  }],
  ["POST", "/api/cards", async ({ req, res }) => {
        const body = await readJson(req);
        if (!body.title?.trim()) return send(res, 400, { error: "Falta el título" });
        const card = newCard({ title: body.title.trim(), description: body.description || "", projectId: body.projectId, criterios: body.criterios });
        if (body.run) requestAI(card);
        else touch(card);
        return send(res, 200, card);
  }],
  ["POST", "/api/questions", async ({ req, res }) => {
        const { text, projectId } = await readJson(req);
        const pregunta = String(text || "").trim().slice(0, 5000);
        if (!pregunta) return send(res, 400, { error: "Escribe tu pregunta" });
        const q = { id: crypto.randomUUID().slice(0, 8), text: pregunta, projectId: projectId && findProject(projectId) ? projectId : null, t: Date.now(), status: "pendiente", worker: null, answer: "", answeredAt: null };
        board.questions.push(q);
        if (board.questions.length > 100) board.questions.splice(0, board.questions.length - 100);
        broadcastQuestions();
        return send(res, 200, q);
  }],
  ["DELETE", "/api/questions/:id", dePregunta(async ({ res, q }) => {
        board.questions = board.questions.filter((x) => x !== q);
        broadcastQuestions();
        return send(res, 200, { ok: true });
  })],
  ["POST", "/api/questions/:id/card", dePregunta(async ({ res, q }) => {
        const titulo = q.text.replace(/\s+/g, " ").slice(0, 120) + (q.text.length > 120 ? "…" : "");
        const card = newCard({
          title: titulo,
          description: q.answer ? `${q.text}\n\n---\nRespuesta rápida de ${q.worker || "la IA"}:\n\n${q.answer}` : q.text,
          projectId: q.projectId,
        });
        touch(card);
        return send(res, 200, card);
  })],
  ["POST", "/api/goal", async ({ req, res }) => {
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
  }],
  ["POST", "/api/projects", async ({ req, res }) => {
        const { name, dir } = await readJson(req);
        const { project, abierto } = newProject(name, dir);
        broadcastProjects();
        broadcast({ type: "files", files: listFiles() });
        return send(res, 200, { ...project, abierto });
  }],
  ["POST", "/api/carpeta/elegir", async ({ req, res }) => {
        const { titulo } = await readJson(req);
        return send(res, 200, await elegirCarpeta(titulo || "Elige la carpeta de trabajo del proyecto"));
  }],
  ["POST", "/api/faltantes/:id/:accion?", async ({ req, res, parts }) => {
        const f = faltantes.find((x) => x.id === parts[2]);
        if (!f) return send(res, 404, { error: "Ese proyecto ya no está en la lista" });
        if (parts[3] === "quitar") quitarFaltante(f);
        else if (parts[3] === "ubicar") {
          const { dir } = await readJson(req);
          const { project } = newProject(f.name, dir);
          if (project.id !== f.id) return send(res, 400, { error: `En esa carpeta hay otro proyecto («${project.name}»): se ha abierto también` });
        } else return send(res, 404, { error: "no encontrado" });
        guardarAhora();
        broadcastProjects();
        broadcast({ type: "files", files: listFiles() });
        return send(res, 200, { ok: true });
  }],
  ["POST", "/api/projects/:id/carpeta", async ({ req, res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        const { dir } = await readJson(req);
        return send(res, 200, moverProyecto(project, dir));
  }],
  ["POST", "/api/projects/:id/mostrar", async ({ req, res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        const { orbita } = await readJson(req);
        abrirNavegador(orbita ? baseDe(project) : project.dir); // abre cualquier ruta con la app del sistema
        return send(res, 200, { ok: true });
  }],
  ["POST", "/api/papelera/:id/restaurar", async ({ res, parts }) => {
        try {
          return send(res, 200, restaurarDePapelera(parts[2]));
        } catch (err) {
          return send(res, 404, { error: err.message });
        }
  }],
  ["DELETE", "/api/papelera/:id", async ({ res, parts }) => {
        const antes = board.papelera.length;
        board.papelera = board.papelera.filter((x) => x.card.id !== parts[2]);
        if (board.papelera.length === antes) return send(res, 404, { error: "No está en la papelera" });
        broadcast({ type: "papelera", papelera: papeleraPublica() });
        save();
        return send(res, 200, { ok: true });
  }],
  ["POST", "/api/plantillas", async ({ req, res }) => {
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
  }],
  ["DELETE", "/api/plantillas/:id", async ({ res, parts }) => {
        const p = board.plantillas.find((x) => x.id === parts[2]);
        if (!p) return send(res, 404, { error: "Esa plantilla no existe" });
        if (p.serie) return send(res, 400, { error: "Las plantillas de serie no se borran" });
        board.plantillas = board.plantillas.filter((x) => x !== p);
        broadcast({ type: "plantillas", plantillas: board.plantillas });
        save();
        return send(res, 200, { ok: true });
  }],
  ["POST", "/api/preguntas/ia", async ({ req, res }) => {
        const { ia } = await readJson(req);
        preguntasIA(ia);
        return send(res, 200, { preguntasIA: board.preguntasIA });
  }],
  ["POST", "/api/projects/:id/ia", async ({ req, res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        const { ia } = await readJson(req);
        iaDeProyecto(project, ia);
        return send(res, 200, project);
  }],
  ["POST", "/api/projects/:id/pausa", async ({ req, res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        const { pausado } = await readJson(req);
        pausarProyecto(project, !!pausado);
        return send(res, 200, project);
  }],
  ["*", "/api/projects/:id/edit", async ({ req, res, parts }) => {
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
  }],
  ["POST", "/api/cards/:id/attachments", async ({ req, res, parts }) => {
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
  }],
  ["DELETE", "/api/cards/:id/attachments/:nombre", async ({ res, parts }) => {
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
  }],
  ["POST", "/api/projects/:id/knowledge", async ({ req, res, parts }) => {
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
  }],
  ["DELETE", "/api/projects/:id/knowledge/:nombre", async ({ res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        const archivo = path.join(carpetaConocimiento(project), nombreSeguro(decodeURIComponent(parts[4])));
        if (!fs.existsSync(archivo)) return send(res, 404, { error: "Ese archivo no existe" });
        fs.rmSync(archivo); // la persona lo quita desde el panel del proyecto
        broadcastProjects();
        broadcast({ type: "files", files: listFiles() });
        return send(res, 200, { knowledge: conocimiento(project) });
  }],
  ["DELETE", "/api/projects/:id", async ({ res, parts }) => {
        const project = findProject(parts[2]);
        if (!project) return send(res, 404, { error: "Proyecto no encontrado" });
        if (board.cards.some((c) => c.projectId === project.id)) return send(res, 400, { error: "El proyecto tiene tarjetas: muévelas a otro proyecto antes de eliminarlo" });
        quitarSecretosDe(project.id);
        board.projects = board.projects.filter((p) => p.id !== project.id);
        broadcastProjects();
        return send(res, 200, { ok: true });
  }],
  ["POST", "/api/archive", async ({ req, res }) => {
        const { ids } = await readJson(req);
        const cards = (Array.isArray(ids) ? ids : []).map(findCard).filter((c) => c && !c.archivedAt && c.column === "done");
        for (const c of cards) {
          c.archivedAt = Date.now();
          log(c, "stop", "Archivada");
          touch(c);
        }
        return send(res, 200, { archived: cards.length });
  }],
  ["DELETE", "/api/cards/:id", deTarjeta(async ({ res, card }) => {
        removeCard(card.id);
        return send(res, 200, { ok: true });
  })],
  ["*", "/api/cards/:id/edit", deTarjeta(async ({ res, card, body }) => {
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
  })],
  ["*", "/api/cards/:id/programa", deTarjeta(async ({ res, card, body }) => {
        programar(card, body.programa || null);
        touch(card);
        return send(res, 200, card);
  })],
  ["*", "/api/cards/:id/criterio", deTarjeta(async ({ res, card, body }) => {
        const cr = card.criterios.find((c) => c.id === body.id);
        if (!cr) return send(res, 404, { error: "Ese criterio no existe" });
        cr.falla = !!body.falla;
        touch(card);
        return send(res, 200, card);
  })],
  ["*", "/api/cards/:id/move", deTarjeta(async ({ res, card, body }) => {
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
  })],
  ["*", "/api/cards/:id/comment", deTarjeta(async ({ res, card, body }) => {
        const text = String(body.text || "").trim();
        if (!text) return send(res, 400, { error: "Escribe tu mensaje" });
        card.inbox.push({ t: Date.now(), text, kind: "comentario" });
        hilo(card, { de: "persona", tipo: "comentario", texto: text });
        log(card, "you", text);
        touch(card);
        return send(res, 200, card);
  })],
  ["*", "/api/cards/:id/feedback", deTarjeta(async ({ res, card, body }) => {
        if (!String(body.text || "").trim()) return send(res, 400, { error: "Escribe tu comentario" });
        requestAI(card, body.text);
        return send(res, 200, card);
  })],
  ["*", "/api/cards/:id/unarchive", deTarjeta(async ({ res, card }) => {
        card.archivedAt = null;
        log(card, "start", "Restaurada del archivo");
        touch(card);
        return send(res, 200, card);
  })],
  ["*", "/api/cards/:id/reset", deTarjeta(async ({ res, card }) => {
        revocar(card, "la persona la reinició (empezar de cero)");
        Object.assign(card, { worker: null, inbox: [], log: [], result: "", versions: [], question: "", progress: 0, step: "", status: "idle", column: "backlog", files: [] });
        touch(card);
        return send(res, 200, card);
  })],
  ["POST", "/api/projects/:id/entidades", deProyecto(async ({ req, res, project }) => {
    const { id, categoria, nombre, resumen, detalles, etiquetas } = await readJson(req);
    const entidad = guardarEntidad(project, { id, categoria, nombre, resumen, detalles, etiquetas }, "Tú").entidad;
    broadcastProjects();
    return send(res, 200, entidad);
  })],
  ["DELETE", "/api/projects/:id/entidades/:eid", deProyecto(async ({ res, parts, project }) => {
    const entidad = quitarEntidad(project, parts[4]);
    borrarImagenDeEntidad(project, entidad);
    broadcastProjects();
    return send(res, 200, entidad);
  })],
  ["POST", "/api/projects/:id/entidades/:eid/imagen", deProyecto(async ({ req, res, parts, project }) => {
    const e = (project.entidades || []).find((x) => x.id === parts[4]);
    if (!e) return send(res, 404, { error: "Entidad no encontrada" });
    const { name, data } = await readJson(req, 15e6);
    const ext = (String(name).match(IMAGEN)?.[0] || "").toLowerCase();
    if (!ext) return send(res, 400, { error: "La imagen tiene que ser PNG, JPG, GIF o WebP" });
    const contenido = Buffer.from(String(data || ""), "base64");
    if (!contenido.length) return send(res, 400, { error: "La imagen está vacía" });
    if (contenido.length > MAX_CONOCIMIENTO) return send(res, 413, { error: "La imagen pasa de 10 MB" });
    const rel = `${project.folder}/entidades/${e.id}${ext}`;
    if (e.imagen !== rel) borrarImagenDeEntidad(project, e); // la anterior, si era otra (p. ej. .png → .jpg)
    fs.mkdirSync(path.dirname(safePath(rel)), { recursive: true });
    fs.writeFileSync(safePath(rel), contenido);
    const entidad = guardarEntidad(project, { id: e.id, imagen: rel }, "Tú").entidad;
    broadcast({ type: "files", files: listFiles() });
    broadcastProjects();
    return send(res, 200, entidad);
  })],
  ["DELETE", "/api/projects/:id/entidades/:eid/imagen", deProyecto(async ({ res, parts, project }) => {
    const e = (project.entidades || []).find((x) => x.id === parts[4]);
    if (!e) return send(res, 404, { error: "Entidad no encontrada" });
    borrarImagenDeEntidad(project, e);
    const entidad = guardarEntidad(project, { id: e.id, imagen: null }, "Tú").entidad;
    broadcast({ type: "files", files: listFiles() });
    broadcastProjects();
    return send(res, 200, entidad);
  })],
  // Secretos: la interfaz solo los escribe y los borra; nunca recibe su valor
  ["POST", "/api/projects/:id/secretos", deProyecto(async ({ req, res, project }) => {
    const { nombre, valor } = await readJson(req);
    ponerSecreto(project.id, nombre, valor);
    broadcastProjects();
    return send(res, 200, { secretos: nombresSecretos(project.id) });
  })],
  ["DELETE", "/api/projects/:id/secretos/:nombre", deProyecto(async ({ res, parts, project }) => {
    quitarSecreto(project.id, decodeURIComponent(parts[4]));
    broadcastProjects();
    return send(res, 200, { secretos: nombresSecretos(project.id) });
  })],
  // Solo en las copias de prueba (ORBITA_PRUEBAS=1)
  ...(process.env.ORBITA_PRUEBAS
    ? [
    ["POST", "/api/_guardado", async ({ res }) => {
          guardarAhora();
          return send(res, 200, { serializados });
    }],
    ["POST", "/api/_reloj", async ({ req, res }) => {
          const { fijar } = await readJson(req);
          fijarReloj(fijar);
          revisarProgramadas();
          return send(res, 200, { ahora: ahora() });
    }],
      ]
    : []),
];

// Busca la fila de un método y una ruta (en trozos). Devuelve su manejador o null.
export function encontrarRuta(metodo, parts) {
  for (const [m, patron, manejar] of RUTAS) {
    if (m !== "*" && m !== metodo) continue;
    const trozos = patron.split("/").filter(Boolean);
    const opcional = trozos.at(-1)?.endsWith("?");
    if (parts.length !== trozos.length && !(opcional && parts.length === trozos.length - 1)) continue;
    if (trozos.every((t, i) => t.startsWith(":") ? i < parts.length || t.endsWith("?") : t === parts[i])) return manejar;
  }
  return null;
}
