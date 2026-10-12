// Servidor MCP de Órbita: la IA que se conecte aquí es el cerebro del tablero.
// Ve las tarjetas, toma las que pongas en "En curso", informa su progreso,
// te pregunta cuando lo necesita y entrega resultados para que los revises.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { VERSION_APP } from "./entorno.mjs";
import { normalizarCarpeta, baseDe, CARPETA } from "./almacen.mjs";
// El tablero y sus operaciones (antes llegaban por parámetro desde server.mjs)
import { PLAN_INSTRUCCIONES, aLaPapelera, board, brainList, broadcast, broadcastProjects, actualizarTokens, changes, claim, conectada, conocimiento, dependenciasPendientes, elegible, enPausa, evaluarCriterios, findCard, findProject, hilo, iaDeProyecto, listFiles, log, moveCard, moverProyecto, newCard, newProject, nuevaVersion, papeleraPublica, ponerCriterios, ponerDependencias, requestAI, restaurarDePapelera, safePath, save, seen, touch } from "./estado.mjs";
import { nombresSecretos, leerSecreto, taparSecretos } from "./secretos.mjs";
import { guardarEntidad, quitarEntidad, indiceEntidades, buscarEntidades, IMAGEN } from "./entidades.mjs";

const INSTRUCTIONS = `Órbita es un tablero kanban; tú eres su IA. Columnas: backlog (Ideas), doing (En curso), review (Para revisar), done (Hecho). Pasa siempre tu nombre en "worker".

Ciclo:
1. wait_for_work: espera y te asigna una tarjeta (con los mensajes de la persona en "inbox").
2. Trabaja con tus herramientas en project.working_directory. Llama a report_progress en cada paso y al menos cada 30–60 s: «step» corto y concreto, «percent» real y, en «detalle», el avance completo (Hecho / Ahora / Después, archivos, hallazgos).
3. submit_result: Markdown que empieza con un resumen de 1–2 frases. Si hay acceptance_criteria, revísalos todos en «criteria» con evidencia (met=false si no se cumple; person_says = la persona dice que falla: corrígelo).
4. Vuelve a wait_for_work, sin pedir confirmación, hasta que la persona te pida parar. Si Órbita no responde (se está reiniciando) o la llamada se corta, espera unos segundos y vuelve a llamar: no dejes de escuchar.

La persona solo te lee en Órbita, nunca en tu chat. Si necesitas una decisión, ask_human. Si ofreces algo al entregar, escríbelo en el resultado: su respuesta te llega por wait_for_work. Para avisar sin entregar, add_comment.

«DETENTE» en una respuesta: la persona te quitó la tarjeta; déjala y vuelve a wait_for_work. Si pausa el proyecto, termina la tarjeta que tienes y no recibirás más hasta que lo reanude. Solo te enteras al llamar a una herramienta, por eso report_progress a menudo.

Proyecto: síguelo con sus instructions y su memory (actualízala con update_memory: decisiones y preferencias). knowledge y attachments son material de entrada. entities (personajes, objetos, personas…) se gestionan con entities. secrets son nombres: el valor, con get_secret, sin copiarlo en el tablero. write_file guarda archivos de trabajo en orbita/ (enlázalos con ![](/files/…)); los entregables son las tarjetas con deliverable, que se guardan al aprobarlas.

Planes (kind "plan"): divide el objetivo con create_card (parent_id, criteria comprobables, depends_on, deliverable si su resultado es un entregable) y entrega un resumen.

Si te piden abrir o crear un proyecto, open_project con directory = tu directorio actual; luego wait_for_work con el project que devuelve. Con project en wait_for_work eres la IA de ese proyecto: solo recibes sus tarjetas.`;

const MAX_ESPERA = 55; // segundos que wait_for_work espera como mucho (Claude Code corta las llamadas hacia los 60 s)
const COLUMN = z.enum(["backlog", "doing", "review", "done"]);

export function createMcpHandler() {

  const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
  const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

  const summary = (c) => ({
    id: c.id,
    title: c.title,
    project: findProject(c.projectId)?.name,
    kind: c.kind,
    column: c.column,
    status: c.status,
    worker: c.worker || undefined,
    progress: c.progress,
    question: c.question || undefined,
    pending_messages: c.inbox?.length || undefined,
    waiting_for: dependenciasPendientes(c).length ? dependenciasPendientes(c).map((d) => d.title) : undefined,
  });

  const detail = (c) => ({
    ...summary(c),
    description: c.kind === "plan" ? `Objetivo: ${c.description}` : c.description,
    instructions: c.kind === "plan" ? PLAN_INSTRUCCIONES : undefined,
    project: contextoDeProyecto(findProject(c.projectId)),
    attachments: c.attachments?.length ? leerConPresupuesto(c.attachments) : undefined,
    parent_id: c.parentId || undefined,
    inbox: c.inbox?.length ? c.inbox : undefined,
    conversation: c.thread?.length ? c.thread.slice(-30).map((m) => `[${new Date(m.t).toISOString().slice(0, 16)}] ${m.de === "persona" ? "Persona" : m.quien || "IA"} (${m.tipo}): ${m.texto}`) : undefined,
    depends_on: c.dependsOn?.length ? c.dependsOn.map((id) => ({ id, title: findCard(id)?.title, done: findCard(id)?.column === "done" })) : undefined,
    // «Terminado cuando…»: al entregar hay que revisarlos todos (submit_result → criteria)
    acceptance_criteria: c.criterios?.length
      ? c.criterios.map((cr) => ({ id: cr.id, text: cr.texto, ...(cr.estado ? { last_review: cr.estado === "cumple" ? "met" : "not met", evidence: cr.evidencia } : {}), ...(cr.falla ? { person_says: "NO se cumple: corrígelo" } : {}) }))
      : undefined,
    deliverable: c.entregable ? "Esta tarjeta es un entregable: tu resultado es lo que la persona se queda (al aprobarla se guarda en «Entregables»). Que sea completo y autocontenido." : undefined,
    previous_result: c.result || undefined,
    version: c.versions?.length ? `Tu entrega será la versión ${c.versions.at(-1).n + 1}; la última es la ${c.versions.at(-1).n} (de ${c.versions.at(-1).quien}).` : undefined,
    files: c.files.length ? c.files : undefined,
    recent_activity: c.log.slice(-12).map((l) => `[${l.kind}] ${l.text}`),
  });

  // «DETENTE»: la persona quitó la tarjeta a la IA y su trabajo ya no se usará.
  function detener(cardId, worker, titulo, motivo) {
    for (const n of board.notices) if (n.cardId === cardId && n.worker === worker && !n.delivered) n.delivered = true;
    const card = findCard(cardId);
    if (card?.revocada && !card.revocada.avisada) {
      card.revocada.avisada = true;
      log(card, "stop", `${worker} recibió el aviso y se detuvo`);
      touch(card);
    }
    save(); // los avisos entregados van en orbita.json
    // En una pausa de proyecto lo hecho se conserva: la tarjeta se retoma al reanudar
    if (/pausó el proyecto/.test(motivo)) return new Error(`DETENTE: ${motivo}. Deja «${titulo}» por ahora y no la entregues: lo que llevas (avance en vivo, archivos, conversación) se conserva y la retomarás cuando se reanude. Llama a wait_for_work para seguir con otra tarjeta.`);
    return new Error(`DETENTE: ${motivo}. No sigas trabajando en «${titulo}» ni entregues nada: ese trabajo ya no se usará. Llama a wait_for_work para seguir con otra tarjeta.`);
  }

  function requireCard(id) {
    const card = findCard(id);
    if (!card) {
      const borrada = board.deleted[id];
      if (borrada) throw detener(id, borrada.worker, borrada.title, borrada.motivo);
      throw new Error(`No existe la tarjeta ${id}. Usa list_cards para ver los ids.`);
    }
    return card;
  }

  // Proyecto por id o nombre; lanza un error con la lista si no existe
  function buscarProyecto(ref) {
    if (ref == null || ref === "") return null;
    const p = findProject(ref) || board.projects.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
    if (!p) throw new Error(`No existe el proyecto «${ref}». Proyectos: ${board.projects.map((x) => `«${x.name}» (${x.id})`).join(", ")}.`);
    return p;
  }

  // Para las herramientas que trabajan sobre una tarjeta: ¿sigue siendo de esta IA?
  function requireWorker(card, worker) {
    if (card.revocada && (!worker || worker === card.revocada.worker)) throw detener(card.id, card.revocada.worker, card.title, card.revocada.motivo);
    if (card.column === "done") throw detener(card.id, worker || card.worker, card.title, "la persona ya la dio por hecha");
    if (!card.worker) throw new Error("Nadie ha tomado esta tarjeta. Tómala antes con wait_for_work.");
    if (worker && card.worker !== worker) throw detener(card.id, worker, card.title, `ahora la tiene «${card.worker}»`);
    seen(card.worker);
  }

  // Lo que la IA necesita saber del proyecto: instrucciones, memoria y conocimiento
  const TEXTO = /\.(md|txt|csv|json|html?|css|js|mjs|ts|py|ya?ml|xml|sql)$/i;
  // Los textos pequeños van incluidos (hasta 30 KB entre todos); el resto se lee con read_file
  function leerConPresupuesto(archivos, presupuesto = 30_000) {
    return archivos.map((a) => {
      if (TEXTO.test(a.name) && a.size <= presupuesto) {
        presupuesto -= a.size;
        return { path: a.path, content: fs.readFileSync(safePath(a.path), "utf8") };
      }
      return { path: a.path, size: a.size, note: "léelo con read_file" };
    });
  }

  function contextoDeProyecto(p) {
    if (!p) return undefined;
    const knowledge = leerConPresupuesto(conocimiento(p));
    return {
      name: p.name,
      working_directory: p.dir,
      files_folder: `${p.folder}/ (rutas de write_file/read_file; en disco: ${baseDe(p)})`,
      instructions: p.instructions || undefined,
      memory: p.memory || undefined,
      knowledge: knowledge.length ? knowledge : undefined,
      entities: indiceEntidades(p), // solo nombres e ids por categoría: los detalles, con entities
      secrets: nombresSecretos(p.id).length ? nombresSecretos(p.id).map((x) => x.nombre) : undefined, // solo los nombres: el valor, con get_secret
    };
  }

  // Mensajes que la persona escribió mientras la IA trabajaba: se le dan en su siguiente llamada
  function mensajesNuevos(card) {
    if (!card.inbox?.length) return "";
    const lista = card.inbox.map((m) => `- ${m.text}`).join("\n");
    card.inbox = [];
    return `\n\nLa persona te escribió mientras trabajabas (tenlo en cuenta):\n${lista}`;
  }

  // Avisos pendientes para una IA (se entregan una vez)
  function avisosPara(worker) {
    const pendientes = board.notices.filter((n) => n.worker === worker && !n.delivered);
    for (const n of pendientes) {
      n.delivered = true;
      const card = findCard(n.cardId);
      if (card?.revocada && !card.revocada.avisada) {
        card.revocada.avisada = true;
        log(card, "stop", `${worker} recibió el aviso y se detuvo`);
        touch(card);
      }
    }
    if (pendientes.length) save();
    return pendientes.map((n) => `Te quitaron «${n.title}»: ${n.motivo}. Si seguías trabajando en ella, detente; no la entregues.`);
  }

  // La próxima tarjeta para esta IA: la de más arriba en «En curso». El orden de la columna manda para todas,
  // también para las que le devolvieron (le respondieron o comentaron su resultado): esas no se saltan la cola.
  function nextFor(worker) {
    // Las de un proyecto en pausa no se entregan y las de proyectos con su propia IA solo van a esa IA
    return board.cards
      .filter((c) => !c.archivedAt && !enPausa(c) && elegible(c.projectId, worker) && ((c.status === "returned" && c.worker === worker) || (c.status === "queued" && dependenciasPendientes(c).length === 0)))
      .sort((a, b) => a.order - b.order)[0];
  }

  function hand(card, worker) {
    claim(card, worker);
    const out = detail(card);
    // Los mensajes se entregan una vez; quedan en la actividad de la tarjeta.
    card.inbox = [];
    touch(card);
    return out;
  }

  // Lo que escribe la IA llega con los valores de los secretos tapados: así nunca acaban en el tablero ni en orbita/
  const safe = (fn) => async (args, extra) => {
    try {
      return await fn(taparSecretos(args), extra);
    } catch (err) {
      return fail(err.message || String(err));
    }
  };

  function build() {
    const server = new McpServer({ name: "orbita", version: VERSION_APP }, { instructions: INSTRUCTIONS });

    server.registerTool(
      "wait_for_work",
      {
        description: "Espera hasta que haya una tarjeta para ti y te la asigna. Sin trabajo, vuelve a llamarla.",
        inputSchema: {
          worker: z.string().min(1),
          timeout_seconds: z.number().int().min(0).optional().describe("Por defecto 50; máximo 55"),
          project: z.string().optional().describe("Ser la IA de un solo proyecto (id o nombre)"),
        },
      },
      safe(async ({ worker, timeout_seconds = 50, project }, extra) => {
        // Más y algunos clientes (Claude Code, hacia los 60 s) cortan la llamada antes de que respondamos: se recorta, sin error
        timeout_seconds = Math.min(timeout_seconds, MAX_ESPERA);
        worker = worker.slice(0, 60);
        if (project) {
          const p = findProject(project) || board.projects.find((x) => x.name.toLowerCase() === project.toLowerCase());
          if (!p) throw new Error(`No existe el proyecto «${project}». Proyectos: ${board.projects.map((x) => `«${x.name}» (${x.id})`).join(", ")}.`);
          if (p.ia && p.ia !== worker && conectada(p.ia)) throw new Error(`El proyecto «${p.name}» ya tiene su IA conectada ahora: «${p.ia}». Usa otro proyecto o pide a la persona que la cambie.`);
          if (p.ia !== worker) iaDeProyecto(p, worker);
        }
        seen(worker, +1);
        try {
          let card = nextFor(worker);
          if (!card && timeout_seconds > 0) {
            await new Promise((resolve) => {
              const done = () => {
                clearTimeout(timer);
                changes.off("change", check);
                extra?.signal?.removeEventListener("abort", done);
                resolve();
              };
              const check = () => {
                card = nextFor(worker);
                if (card) done();
              };
              const timer = setTimeout(done, timeout_seconds * 1000);
              changes.on("change", check);
              extra?.signal?.addEventListener("abort", done);
            });
          }
          const notices = avisosPara(worker);
          const avisos = notices.length ? { notices } : {};
          if (!card) return ok({ ...avisos, work: null, message: "No hay tarjetas pendientes. Vuelve a llamar a wait_for_work para seguir escuchando." });
          return ok({ ...avisos, work: hand(card, worker), next: "Trabájala, informa con report_progress y termina con submit_result. Si necesitas algo de la persona, pregúntaselo con ask_human (no en tu chat: no lo está mirando)." });
        } finally {
          seen(worker, -1);
        }
      }),
    );

    // Abrir un proyecto desde la propia IA: lo crea (o reutiliza), la IA pasa a ser la suya y el tablero de la persona salta a él
    server.registerTool(
      "open_project",
      {
        description: "Crea o abre el proyecto de una carpeta y te hace su IA; el tablero de la persona salta a él. Luego, wait_for_work con el project devuelto.",
        inputSchema: {
          directory: z.string().optional().describe("Carpeta de trabajo (ruta completa); obligatoria para crear"),
          name: z.string().min(1).max(80).optional().describe("Nombre o id"),
          move_here: z.boolean().optional().describe("Trasladar el proyecto existente a directory"),
          worker: z.string().min(1).max(60).optional(),
          goal: z.string().max(5000).optional().describe("Objetivo: crea una tarjeta de plan para ti"),
          instructions: z.string().max(20_000).optional().describe("Reglas fijas (si aún no tiene)"),
        },
      },
      safe(async ({ directory, name, move_here, worker, goal, instructions }) => {
        const dir = directory ? normalizarCarpeta(directory) : null;
        const buscado = name?.trim();
        const porNombre = buscado && (findProject(buscado) || board.projects.find((x) => x.name.toLowerCase() === buscado.toLowerCase()));
        let p = (dir && board.projects.find((x) => x.dir === dir)) || null;
        if (!p && porNombre) {
          if (dir && porNombre.dir !== dir) {
            if (!move_here) throw new Error(`«${porNombre.name}» ya existe y su carpeta de trabajo es ${porNombre.dir}. Para usarlo tal cual, llama a open_project sin directory (o con esa carpeta). Para trasladarlo a ${dir} junto con su carpeta ${CARPETA}/, repite con move_here: true (pregúntaselo antes a la persona).`);
            moverProyecto(porNombre, dir);
          }
          p = porNombre;
        }
        let creado = false;
        if (!p) {
          if (!dir) throw new Error("Para crear un proyecto hace falta su carpeta de trabajo: pasa directory (normalmente tu directorio de trabajo actual).");
          const r = newProject(buscado || null, dir);
          p = r.project;
          creado = !r.abierto;
        }
        worker = (worker?.trim() || `Claude · ${p.name.length > 28 ? p.name.slice(0, 27).trimEnd() + "…" : p.name}`).slice(0, 60);
        if (p.ia && p.ia !== worker && conectada(p.ia)) throw new Error(`El proyecto «${p.name}» ya lo lleva «${p.ia}», que está conectada ahora. Pide a la persona que la cambie o abre otro proyecto.`);
        if (instructions?.trim() && !p.instructions) p.instructions = instructions.trim();
        iaDeProyecto(p, worker); // también avisa a la app (proyectos) y guarda
        let plan = null;
        if (goal?.trim()) {
          plan = newCard({ title: `Planificar: ${goal.trim().slice(0, 150)}`, description: goal.trim(), kind: "plan", tag: "objetivo", projectId: p.id, origin: "ia" });
          requestAI(plan); // a la cola de «En curso»: wait_for_work se la dará a esta IA
        }
        seen(worker);
        broadcast({ type: "enfoque", projectId: p.id, por: worker, creado });
        const pendientes = board.cards.filter((c) => c.projectId === p.id && !c.archivedAt && ["queued", "returned"].includes(c.status)).length;
        return ok({
          project: { id: p.id, name: p.name, working_directory: p.dir, orbita_folder: baseDe(p), created: creado },
          worker,
          paused: p.pausado ? "El proyecto está en pausa: no recibirás sus tarjetas hasta que la persona lo reanude." : undefined,
          queued_cards: pendientes,
          next: `Llama ahora a wait_for_work con { worker: "${worker}", project: "${p.id}" } y vuelve a llamarla cada vez que responda sin trabajo: así te quedas escuchando. Las tarjetas que la persona ponga en «En curso» en este proyecto te llegarán solo a ti.`,
        });
      }),
    );

    server.registerTool(
      "list_cards",
      {
        description:  "Lista tarjetas (filtra por columna o proyecto; archivadas con include_archived).",
        inputSchema: { column: COLUMN.optional(), project: z.string().optional(), include_archived: z.boolean().optional() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ column, project, include_archived }) => {
        const p = project?.toLowerCase();
        const cards = board.cards
          .filter((c) => (include_archived || !c.archivedAt) && (!column || c.column === column))
          .filter((c) => !p || c.projectId === project || (findProject(c.projectId)?.name || "").toLowerCase().includes(p))
          .map((c) => ({ ...summary(c), archived: c.archivedAt ? true : undefined }));
        const proyectos = board.projects.map((x) => `${x.name} (id ${x.id}, carpeta de trabajo ${x.dir})`);
        return ok(cards.length ? { projects: proyectos, cards } : "No hay tarjetas con ese filtro.");
      }),
    );

    server.registerTool(
      "get_card",
      {
        description:  "Todo sobre una tarjeta: descripción, inbox, conversación, resultado, archivos y actividad.",
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ id }) => ok(detail(requireCard(id)))),
    );

    server.registerTool(
      "report_progress",
      {
        description: "Paso y progreso en vivo; «detalle» sustituye al avance anterior. Cada paso y cada 30–60 s.",
        inputSchema: {
          id: z.string(),
          step: z.string().describe("Qué haces ahora, corto"),
          percent: z.number().min(0).max(100).optional(),
          detalle: z.string().optional().describe("Avance completo en Markdown"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ id, step, percent, detalle, worker }) => {
        const card = requireCard(id);
        requireWorker(card, worker);
        card.step = step.slice(0, 200);
        if (detalle != null) {
          card.live = detalle.slice(0, 100_000);
          card.liveAt = Date.now();
        }
        card.status = "running";
        card.column = "doing";
        if (percent != null) card.progress = Math.max(card.progress, Math.min(99, Math.round(percent)));
        log(card, "step", card.step);
        const nuevos = mensajesNuevos(card);
        touch(card);
        return ok("ok" + nuevos);
      }),
    );

    server.registerTool(
      "submit_result",
      {
        description:  "Entrega el resultado (Markdown) y la pasa a «Para revisar». Con acceptance_criteria, revísalos todos en criteria.",
        inputSchema: {
          id: z.string(),
          result: z.string().min(1),
          criteria: z
            .array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string().optional().describe("Prueba, captura o enlace") }))
            .optional()
            .describe("Uno por criterio"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ id, result, criteria, worker }) => {
        const card = requireCard(id);
        requireWorker(card, worker);
        evaluarCriterios(card, criteria); // si faltan criterios o evidencias, no se entrega (y la IA sabe qué falta)
        nuevaVersion(card, result, card.worker);
        card.status = "ready";
        card.column = "review";
        card.progress = 100;
        card.step = "Listo para revisar";
        hilo(card, { de: "ia", quien: card.worker, tipo: "entrega", texto: result.split("\n").find((l) => l.trim())?.replace(/^[#>*\s-]+/, "").slice(0, 300) || "Entregó el resultado" });
        const cumplidos = card.criterios.filter((c) => c.estado === "cumple").length;
        log(card, "done", `${card.worker} entregó el resultado${card.criterios.length ? ` (criterios: ${cumplidos}/${card.criterios.length} ✓)` : ""}`);
        touch(card);
        setTimeout(actualizarTokens, 2000); // su gasto, en cuanto Claude Code lo apunte
        return ok("Entregado. Llama a wait_for_work para la siguiente tarjeta.");
      }),
    );

    server.registerTool(
      "ask_human",
      {
        description:  "Pausa tu tarjeta con una pregunta; la respuesta llega por wait_for_work.",
        inputSchema: {
          id: z.string(),
          question: z.string().min(1),
          worker: z.string().optional(),
        },
      },
      safe(async ({ id, question, worker }) => {
        const card = requireCard(id);
        requireWorker(card, worker);
        card.question = question.slice(0, 1000);
        hilo(card, { de: "ia", quien: card.worker, tipo: "pregunta", texto: card.question });
        card.status = "waiting";
        card.column = "review";
        card.step = "Esperando tu respuesta";
        log(card, "ask", card.question);
        touch(card);
        return ok("Pregunta enviada. Sigue con wait_for_work; la respuesta llegará por ahí.");
      }),
    );

    // Entidades del proyecto: personajes, objetos, personas, lugares… (ver entidades.mjs)
    const proyectoDe = (card_id, project) => {
      const p = card_id ? findProject(requireCard(card_id).projectId) : buscarProyecto(project);
      if (!p) throw new Error(card_id ? "Esa tarjeta no pertenece a ningún proyecto." : "Indica card_id (tu tarjeta) o project.");
      return p;
    };
    const fichaEntidad = (e, completa = true) => ({
      id: e.id,
      category: e.categoria,
      name: e.nombre,
      summary: e.resumen || undefined,
      details: completa ? e.detalles || undefined : undefined,
      tags: e.etiquetas?.length ? e.etiquetas : undefined,
      image: e.imagen ? `/files/${e.imagen}` : undefined,
      updated: `${new Date(e.actualizada?.t || e.creada.t).toISOString().slice(0, 16)} por ${e.actualizada?.por || e.creada.por}`,
    });

    // Entidades del proyecto en una sola herramienta: ver (list), guardar (save) y borrar (delete)
    server.registerTool(
      "entities",
      {
        description: "Entidades del proyecto (personajes, objetos, personas, lugares…). list: busca y devuelve detalles. save: crea o actualiza (misma categoría y nombre, o id; solo cambia lo que pases). delete: solo si la persona lo pide.",
        inputSchema: {
          action: z.enum(["list", "save", "delete"]),
          card_id: z.string().optional().describe("Tu tarjeta (obligatoria para save y delete)"),
          project: z.string().optional(),
          id: z.string().optional(),
          category: z.string().max(40).optional().describe("En plural: Personajes, Armas…"),
          name: z.string().max(120).optional(),
          summary: z.string().max(500).optional(),
          details: z.string().max(20000).optional().describe("Markdown; sustituye a los anteriores"),
          tags: z.array(z.string().max(30)).max(20).optional(),
          image_path: z.string().optional().describe("Imagen guardada con write_file; vacía la quita"),
          query: z.string().optional(),
          worker: z.string().optional(),
        },
      },
      safe(async ({ action, card_id, project, id, category, name, summary, details, tags, image_path, query, worker }) => {
        if (action === "list") {
          const p = proyectoDe(card_id, project);
          const encontradas = buscarEntidades(p, { categoria: category, consulta: query });
          const categorias = {};
          for (const e of p.entidades || []) categorias[e.categoria] = (categorias[e.categoria] || 0) + 1;
          return ok({ project: p.name, categories: categorias, total: encontradas.length, entities: encontradas.slice(0, 100).map((e) => fichaEntidad(e)), more: encontradas.length > 100 ? "Hay más: afina con category o query" : undefined });
        }
        if (!card_id) throw new Error("Para save y delete hace falta card_id (tu tarjeta).");
        const card = requireCard(card_id);
        requireWorker(card, worker);
        const p = proyectoDe(card_id);
        if (action === "delete") {
          if (!id) throw new Error("Para borrar, pasa el id de la entidad.");
          const e = quitarEntidad(p, id);
          log(card, "note", `${card.worker} borró la entidad «${e.nombre}» (${e.categoria})`);
          touch(card);
          broadcastProjects();
          return ok(`Borrada «${e.nombre}» (${e.categoria}).`);
        }
        let imagen;
        if (image_path !== undefined) {
          if (!image_path) imagen = null;
          else {
            const rel = image_path.replace(/^\/?files\//, "").replace(/^\.?\//, "");
            const ruta = rel.startsWith(`${p.folder}/`) ? rel : `${p.folder}/${rel}`;
            if (!IMAGEN.test(ruta)) throw new Error("image_path tiene que ser una imagen png, jpg, gif o webp");
            if (!fs.existsSync(safePath(ruta))) throw new Error(`No existe ${ruta}: guárdala antes con write_file`);
            imagen = ruta;
          }
        }
        if (!id && (!category || !name)) throw new Error("Para crear una entidad hacen falta category y name (o pasa id para actualizar una).");
        const { entidad, creada } = guardarEntidad(p, { id, categoria: category, nombre: name, resumen: summary, detalles: details, etiquetas: tags, imagen }, card.worker);
        log(card, "note", `${card.worker} ${creada ? "añadió" : "actualizó"} la entidad «${entidad.nombre}» (${entidad.categoria})`);
        touch(card);
        broadcastProjects();
        return ok({ [creada ? "created" : "updated"]: fichaEntidad(entidad, false) });
      }),
    );

    server.registerTool(
      "get_secret",
      {
        description: "Valor de un secreto del proyecto (nombres en project.secrets). No lo copies en el tablero.",
        inputSchema: {
          card_id: z.string().describe("Tu tarjeta"),
          name: z.string().describe("p. ej. STRIPE_API_KEY"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ card_id, name, worker }) => {
        const card = requireCard(card_id);
        requireWorker(card, worker);
        const valor = leerSecreto(card.projectId, name);
        log(card, "note", `${card.worker} usó el secreto ${name}`);
        touch(card);
        return ok(valor);
      }),
    );

    server.registerTool(
      "update_memory",
      {
        description: "Reescribe la memoria del proyecto (completa y breve: decisiones, preferencias, datos).",
        inputSchema: {
          card_id: z.string().describe("Tu tarjeta"),
          memory: z.string().max(20000).describe("Completa, en Markdown"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ card_id, memory, worker }) => {
        const card = requireCard(card_id);
        requireWorker(card, worker);
        const p = findProject(card.projectId);
        if (!p) throw new Error("Esta tarjeta no pertenece a ningún proyecto: no hay memoria que actualizar.");
        p.memory = memory;
        p.memoryAt = Date.now();
        log(card, "note", `${card.worker} actualizó la memoria del proyecto`);
        touch(card);
        broadcastProjects();
        return ok(`Memoria de «${p.name}» actualizada.` + mensajesNuevos(card));
      }),
    );

    server.registerTool(
      "add_comment",
      {
        description: "Nota en la conversación de tu tarjeta, sin entregar.",
        inputSchema: {
          id: z.string(),
          text: z.string().min(1).describe("Markdown"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ id, text, worker }) => {
        const card = requireCard(id);
        requireWorker(card, worker);
        hilo(card, { de: "ia", quien: card.worker, tipo: "nota", texto: text });
        log(card, "note", `${card.worker} comentó`);
        const nuevos = mensajesNuevos(card);
        touch(card);
        return ok("Comentario publicado." + nuevos);
      }),
    );

    server.registerTool(
      "create_card",
      {
        description:  "Crea una tarjeta (en Ideas; request_ai la pone en curso). Hereda el proyecto de parent_id.",
        inputSchema: {
          title: z.string().min(1).describe("Corto e imperativo"),
          description: z.string().optional().describe("Qué hacer y contexto"),
          parent_id: z.string().optional().describe("La tarjeta de plan"),
          depends_on: z.array(z.string()).optional().describe("Ids que deben estar hechas antes"),
          criteria: z.array(z.string()).optional().describe("Terminado cuando…, comprobables"),
          acceptance_criteria: z.array(z.string()).optional(), // el nombre con el que la IA los ve en las tarjetas
          request_ai: z.boolean().optional(),
          project: z.string().optional().describe("Id o nombre"),
          deliverable: z.boolean().optional().describe("Su resultado es un entregable"),
        },
      },
      safe(async ({ title, description, parent_id, depends_on, criteria, acceptance_criteria, request_ai, project, deliverable }) => {
        criteria ??= acceptance_criteria;
        for (const d of depends_on || []) if (!findCard(d)) throw new Error(`depends_on: no existe la tarjeta ${d}`);
        const parent = parent_id && findCard(parent_id);
        const card = newCard({
          title,
          description: description || "",
          origin: "ia",
          parentId: parent ? parent.id : null,
          tag: parent?.kind === "plan" ? parent.title.replace(/^Planificar:\s*/, "").slice(0, 120) : null,
          projectId: parent?.projectId || buscarProyecto(project)?.id || null, // sin ninguno, va a «General»
          criterios: criteria,
          entregable: !!deliverable,
        });
        if (depends_on?.length) ponerDependencias(card, depends_on);
        if (parent) log(parent, "spawn", `Creó la tarjeta «${card.title}»`), touch(parent);
        if (request_ai) requestAI(card);
        else touch(card);
        return ok({ created: summary(card) });
      }),
    );

    // Si otra IA la está trabajando, no se toca (se pisarían el trabajo)
    function noEsDeOtra(card, worker) {
      if (card.worker && worker && card.worker !== worker && ["running", "returned", "waiting"].includes(card.status))
        throw new Error(`«${card.title}» la está trabajando «${card.worker}»: no se puede cambiar ni borrar ahora. Pide a la persona que la aparte primero.`);
    }

    server.registerTool(
      "update_card",
      {
        description:  "Cambia una tarjeta: pasa solo lo que cambia. column la mueve.",
        inputSchema: {
          id: z.string(),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          criteria: z.array(z.string()).optional().describe("Lista completa"),
          acceptance_criteria: z.array(z.string()).optional(),
          project: z.string().optional().describe("Id o nombre"),
          depends_on: z.array(z.string()).optional().describe("Lista completa"),
          deliverable: z.boolean().optional(),
          column: COLUMN.optional().describe("Solo si la persona lo pide"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ id, title, description, criteria, acceptance_criteria, project, depends_on, deliverable, column, worker }) => {
        criteria ??= acceptance_criteria;
        const card = requireCard(id);
        noEsDeOtra(card, worker);
        const cambios = [];
        if (title !== undefined && title.trim() !== card.title) (card.title = title.trim().slice(0, 200)), cambios.push("título");
        if (description !== undefined && description !== card.description) (card.description = description.slice(0, 8000)), cambios.push("descripción");
        if (criteria !== undefined) ponerCriterios(card, criteria), cambios.push("criterios");
        if (project !== undefined) {
          const p = buscarProyecto(project);
          if (p.id !== card.projectId) (card.projectId = p.id), cambios.push("proyecto");
        }
        if (depends_on !== undefined) {
          for (const d of depends_on) if (!findCard(d)) throw new Error(`depends_on: no existe la tarjeta ${d}`);
          ponerDependencias(card, depends_on);
          cambios.push("dependencias");
        }
        if (deliverable !== undefined && deliverable !== !!card.entregable) (card.entregable = deliverable), cambios.push(deliverable ? "entregable" : "ya no es entregable");
        const mover = column !== undefined && column !== card.column;
        if (!cambios.length && !mover) return ok({ unchanged: summary(card), message: "No había nada que cambiar." });
        if (cambios.length) log(card, "step", `✎ ${worker || "La IA"} editó: ${cambios.join(", ")}`);
        if (mover) moveCard(card, column), cambios.push(`columna: ${column}`);
        touch(card);
        return ok({ updated: summary(card), changed: cambios });
      }),
    );

    server.registerTool(
      "delete_card",
      {
        description:  "Borra tarjetas a la papelera. Solo si la persona lo pide.",
        inputSchema: {
          ids: z.array(z.string()).min(1).describe("Ids"),
          reason: z.string().optional().describe("Por qué (lo ve la persona)"),
          worker: z.string().optional(),
        },
      },
      safe(async ({ ids, reason, worker }) => {
        const cards = ids.map((id) => requireCard(id));
        for (const c of cards) noEsDeOtra(c, worker); // todas o ninguna
        for (const c of cards) aLaPapelera(c, worker || "La IA", reason);
        return ok({ deleted: cards.map((c) => ({ id: c.id, title: c.title })), message: `Borrada${cards.length > 1 ? "s" : ""} ${cards.length}: están en la papelera (trash con su id para recuperarlas).` });
      }),
    );

    server.registerTool(
      "trash",
      {
        description: "Papelera (30 días). Sin id, la lista; con id, restaura esa tarjeta.",
        inputSchema: { id: z.string().optional() },
      },
      safe(async ({ id }) =>
        id ? ok({ restored: summary(restaurarDePapelera(id)) }) : ok(papeleraPublica().map((x) => ({ id: x.id, title: x.title, deleted_at: new Date(x.borradaEn).toISOString(), by: x.por, reason: x.motivo || undefined }))),
      ),
    );

    server.registerTool(
      "read_file",
      {
        description:  "Lee un archivo de orbita/ («<carpeta>/…»); sin path, los lista.",
        inputSchema: { path: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ path: rel }) => {
        if (!rel) {
          const files = listFiles();
          return ok(files.length ? files.join("\n") : "(no hay archivos)");
        }
        const full = safePath(rel);
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(full).toLowerCase()];
        if (mime) return { content: [{ type: "image", data: fs.readFileSync(full).toString("base64"), mimeType: mime }] };
        return ok(fs.readFileSync(full, "utf8").slice(0, 200_000));
      }),
    );

    server.registerTool(
      "write_file",
      {
        description: "Guarda un archivo en orbita/ (con card_id, ruta relativa a su proyecto; imágenes en base64). Enlázalo con ![](/files/<ruta>).",
        inputSchema: {
          path: z.string(),
          content: z.string(),
          encoding: z.enum(["utf8", "base64"]).optional().describe("base64 para binarios"),
          card_id: z.string().optional(),
          worker: z.string().optional(),
        },
      },
      safe(async ({ path: rel, content, encoding = "utf8", card_id, worker }) => {
        // Si la tarjeta se la quitaron a esta IA, no se escribe nada para ella
        const deTarjeta = card_id ? requireCard(card_id) : null;
        if (deTarjeta && (deTarjeta.revocada || deTarjeta.column === "done" || (worker && deTarjeta.worker && deTarjeta.worker !== worker))) requireWorker(deTarjeta, worker);
        // Los archivos de una tarjeta van a la carpeta de su proyecto
        const proyecto = deTarjeta && findProject(deTarjeta.projectId);
        if (proyecto && !rel.replace(/^\.?\//, "").startsWith(proyecto.folder + "/")) rel = `${proyecto.folder}/${rel.replace(/^\.?\//, "")}`;
        const full = safePath(rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, encoding === "base64" ? Buffer.from(content, "base64") : content);
        const relPath = rel.replaceAll("\\", "/").replace(/^\.?\/+/, "");
        const card = deTarjeta;
        if (card) {
          if (!card.files.includes(relPath)) card.files.push(relPath);
          log(card, "file", `${card.worker || "La IA"} escribió ${relPath}`);
          touch(card);
        }
        broadcast({ type: "files", files: listFiles() });
        return ok(`Guardado en ${relPath}`);
      }),
    );

    // Sin comandos (prompts MCP): la app de Claude los rechazaba. Para arrancar a la IA se pega la instrucción del panel 🧠.
    return server;
  }

  // Modo sin sesión: un servidor y un transporte nuevos por petición.
  return async function handle(req, res, body, allowedHosts) {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Usa POST" }, id: null }));
      return;
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
