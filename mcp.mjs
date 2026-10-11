// Servidor MCP de Órbita: la IA que se conecte aquí es el cerebro del tablero.
// Ve las tarjetas, toma las que pongas en "En curso", informa su progreso,
// te pregunta cuando lo necesita y entrega resultados para que los revises.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { VERSION_APP } from "./entorno.mjs";

const INSTRUCTIONS = `Órbita es un tablero kanban. Tú eres su cerebro: la persona pone tarjetas en "En curso" y tú las trabajas.
Columnas: backlog (Ideas), doing (En curso), review (Para revisar), done (Hecho).

Ciclo de trabajo:
1. wait_for_work con tu nombre: espera hasta que haya una tarjeta para ti y te la asigna. Devuelve la tarjeta completa, con los mensajes de la persona en "inbox".
2. Trabaja la tarjeta con tus propias capacidades (código, búsqueda, archivos…). Llama a report_progress al cambiar de fase: la persona lo ve en vivo. Usa su campo "detalle" para enseñar lo que llevas hecho (hallazgos, borradores, tablas, capturas con ![](/files/…)): aparece en la sección «En vivo» de la tarjeta antes de que entregues.
3. Si produces un documento o datos que valga la pena guardar, usa write_file con card_id.
4. submit_result con el resultado en Markdown, empezando con un resumen de 1-2 frases. Puedes incluir imágenes guardadas con write_file usando ![descripción](/files/<ruta>).
5. Vuelve a llamar a wait_for_work. Repite hasta que la persona te pida parar.

Cada tarjeta puede pertenecer a un proyecto con su carpeta (campo "project" de la tarjeta): con write_file y card_id, tus archivos se guardan dentro de esa carpeta automáticamente; para enlazarlos en el resultado usa la ruta que te devuelve write_file.

wait_for_work puede traerte una pregunta rápida en lugar de una tarjeta (campo "question", con el contexto de su proyecto si lo tiene): respóndela enseguida con answer_question, directo y breve, y sigue con wait_for_work.

Si la persona adjuntó archivos a la tarjeta, vienen en "attachments" (los textos pequeños con su contenido; el resto, léelos con read_file): son material de entrada para tu trabajo.

Si la tarjeta pertenece a un proyecto, "project" trae sus instructions (síguelas siempre), su memory y sus archivos de knowledge. Cuando aprendas algo que sirva para próximas tarjetas (una decisión, una preferencia de la persona, un dato del proyecto), guárdalo con update_memory, breve.

Para contarle algo a la persona a mitad de trabajo (sin entregar), usa add_comment. Lo que ella te escriba mientras trabajas te llega en la respuesta de report_progress y add_comment, y su conversación completa está en get_card ("conversation").

Si eres la IA de preguntas rápidas, pasa solo: "preguntas" en cada wait_for_work: solo recibirás preguntas, y las respondes al momento con answer_question.

Si eres la IA de un proyecto concreto, pasa project en cada wait_for_work: solo recibirás su trabajo, y otra IA puede llevar otro proyecto en paralelo.

Si la persona te pide abrir, crear o conectarte a un proyecto («abre un proyecto para X y quédate escuchando»), usa open_project: crea el proyecto (o abre el que ya tenga ese nombre), te hace su IA y su tablero cambia solo a él; la persona no tiene que hacer nada en la app. Después llama a wait_for_work con el worker y el project que te devuelve, y repítelo cada vez que vuelva sin trabajo.

Si la tarjeta trae acceptance_criteria («Terminado cuando…»), trabaja para cumplirlos y, al entregar, revisa cada uno con honestidad y pásalos en submit_result → criteria con su evidencia (una captura /files/…, una prueba o un enlace); lo que no cumplas, márcalo met=false y explica. Si un criterio trae person_says, la persona dice que no se cumple: corrígelo primero. Al crear tarjetas (planes), añade criteria comprobables.

Pasa siempre tu nombre en "worker" al llamar a report_progress, write_file, ask_human y submit_result. Si una herramienta responde «DETENTE», la persona te quitó esa tarjeta (la movió, la eliminó, la dio por hecha o pausó su proyecto): deja de trabajar en ella, no la entregues y vuelve a wait_for_work. Si fue una pausa, lo que llevas se conserva y la tarjeta te volverá al reanudar el proyecto. Solo te enteras de estos avisos al llamar a una herramienta: mientras trabajas, llama a report_progress al menos cada 2–3 minutos y antes de cada paso largo, para que una pausa o un cambio de la persona te llegue a tiempo. wait_for_work también te trae esos avisos en "notices".

Si te falta una decisión que solo la persona puede tomar, usa ask_human y sigue con otra tarjeta; su respuesta te llegará por wait_for_work.
Las tarjetas de tipo "plan" piden dividir un objetivo: crea las subtareas con create_card (parent_id = la tarjeta del plan) y entrega un resumen del plan.`;

const COLUMN = z.enum(["backlog", "doing", "review", "done"]);

export function createMcpHandler(ops) {
  const { board, findCard, findProject, newCard, touch, log, requestAI, moveCard, claim, seen, brainList, changes, listFiles, safePath, broadcast, save, WORKSPACE, PLAN_INSTRUCCIONES, dependenciasPendientes, ponerDependencias, hilo, conocimiento, broadcastProjects, nuevaVersion, broadcastQuestions, enPausa, ponerCriterios, evaluarCriterios, elegible, iaDeProyecto, conectada, preguntasIA, aLaPapelera, restaurarDePapelera, papeleraPublica, newProject } = ops;

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
    } else save();
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

  // Para las herramientas que trabajan sobre una tarjeta: ¿sigue siendo de esta IA?
  function requireWorker(card, worker) {
    if (card.revocada && (!worker || worker === card.revocada.worker)) throw detener(card.id, card.revocada.worker, card.title, card.revocada.motivo);
    if (card.column === "done") throw detener(card.id, worker || card.worker, card.title, "la persona ya la dio por hecha");
    if (!card.worker) throw new Error("Nadie ha tomado esta tarjeta. Tómala antes con claim_card o wait_for_work.");
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
        return { path: a.path, content: fs.readFileSync(path.join(WORKSPACE, a.path), "utf8") };
      }
      return { path: a.path, size: a.size, note: "léelo con read_file" };
    });
  }

  function contextoDeProyecto(p) {
    if (!p) return undefined;
    const knowledge = leerConPresupuesto(conocimiento(p));
    return {
      name: p.name,
      files_folder: p.folder + "/",
      instructions: p.instructions || undefined,
      memory: p.memory || undefined,
      knowledge: knowledge.length ? knowledge : undefined,
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

  // Preguntas rápidas: van antes que las tarjetas (son cortas). Si esta IA ya tenía una sin responder, se la vuelve a dar.
  function siguientePregunta(worker) {
    const suya = board.questions.find((q) => q.status === "respondiendo" && q.worker === worker);
    if (suya) return suya;
    const pendientes = board.questions.filter((q) => q.status === "pendiente");
    // La IA de preguntas las toma todas (con el contexto de su proyecto)…
    if (worker === board.preguntasIA) return pendientes[0];
    // …y mientras esté conectada, las IAs de tarjetas no reciben ninguna. Si no lo está, nunca se quedan sin respuesta.
    if (board.preguntasIA && conectada(board.preguntasIA)) return undefined;
    return pendientes.find((q) => elegible(q.projectId, worker));
  }
  function darPregunta(q, worker) {
    q.status = "respondiendo";
    q.worker = worker;
    broadcastQuestions();
    return {
      id: q.id,
      text: q.text,
      asked_at: new Date(q.t).toISOString(),
      project: contextoDeProyecto(findProject(q.projectId)),
    };
  }

  // La próxima tarjeta para esta IA: primero lo que le devolvieron, luego la cola.
  function nextFor(worker) {
    // Las de un proyecto en pausa no se entregan
    // y las de proyectos con su propia IA solo van a esa IA; la IA de preguntas no toma tarjetas
    if (worker === board.preguntasIA) return undefined;
    const mine = board.cards.find((c) => c.worker === worker && c.status === "returned" && !enPausa(c) && elegible(c.projectId, worker));
    if (mine) return mine;
    // La de más arriba en «En curso» va primero: el orden de la columna es la prioridad
    return board.cards.filter((c) => c.status === "queued" && !c.archivedAt && !enPausa(c) && elegible(c.projectId, worker) && dependenciasPendientes(c).length === 0).sort((a, b) => a.order - b.order)[0];
  }

  function hand(card, worker) {
    claim(card, worker);
    const out = detail(card);
    // Los mensajes se entregan una vez; quedan en la actividad de la tarjeta.
    card.inbox = [];
    touch(card);
    return out;
  }

  const safe = (fn) => async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(err.message || String(err));
    }
  };

  function build() {
    const server = new McpServer({ name: "orbita", version: VERSION_APP }, { instructions: INSTRUCTIONS });

    server.registerTool(
      "wait_for_work",
      {
        title: "Esperar trabajo",
        description:
          "Espera hasta que haya una tarjeta para ti (en «En curso» o devuelta a ti con comentarios), te la asigna y la devuelve completa. Si se agota el tiempo sin trabajo, responde que no hay nada: vuelve a llamarla para seguir escuchando.",
        inputSchema: {
          worker: z.string().min(1).describe("Tu nombre visible en el tablero, p. ej. «Claude»"),
          timeout_seconds: z.number().int().min(0).max(240).optional().describe("Cuánto esperar como máximo (por defecto 50, máximo 240: muchos clientes HTTP cortan a los 5 minutos)"),
          project: z.string().optional().describe("Para ser la IA de un solo proyecto (id o nombre): solo recibirás sus tarjetas y preguntas, y las demás IAs lo dejarán para ti. Así varios proyectos avanzan en paralelo, uno por IA."),
          solo: z.enum(["preguntas"]).optional().describe('«preguntas»: ser la IA de preguntas rápidas. Solo recibirás preguntas (nunca tarjetas) y las demás IAs dejarán de responderlas mientras estés conectada.'),
        },
      },
      safe(async ({ worker, timeout_seconds = 50, project, solo }, extra) => {
        worker = worker.slice(0, 60);
        if (solo === "preguntas" && board.preguntasIA !== worker) {
          if (board.preguntasIA && conectada(board.preguntasIA)) throw new Error(`Ya hay una IA de preguntas conectada: «${board.preguntasIA}».`);
          preguntasIA(worker);
        }
        if (project) {
          const p = findProject(project) || board.projects.find((x) => x.name.toLowerCase() === project.toLowerCase());
          if (!p) throw new Error(`No existe el proyecto «${project}». Proyectos: ${board.projects.map((x) => `«${x.name}» (${x.id})`).join(", ")}.`);
          if (p.ia && p.ia !== worker && conectada(p.ia)) throw new Error(`El proyecto «${p.name}» ya tiene su IA conectada ahora: «${p.ia}». Usa otro proyecto o pide a la persona que la cambie.`);
          if (p.ia !== worker) iaDeProyecto(p, worker);
        }
        seen(worker, +1);
        try {
          let pregunta = siguientePregunta(worker);
          let card = pregunta ? null : nextFor(worker);
          if (!card && !pregunta && timeout_seconds > 0) {
            await new Promise((resolve) => {
              const done = () => {
                clearTimeout(timer);
                changes.off("change", check);
                extra?.signal?.removeEventListener("abort", done);
                resolve();
              };
              const check = () => {
                pregunta = siguientePregunta(worker);
                card = pregunta ? null : nextFor(worker);
                if (card || pregunta) done();
              };
              const timer = setTimeout(done, timeout_seconds * 1000);
              changes.on("change", check);
              extra?.signal?.addEventListener("abort", done);
            });
          }
          const notices = avisosPara(worker);
          const avisos = notices.length ? { notices } : {};
          if (pregunta) return ok({ ...avisos, work: null, question: darPregunta(pregunta, worker), next: "Es una pregunta rápida: respóndela directamente con answer_question (breve, en Markdown) y vuelve a wait_for_work." });
          if (!card) return ok({ ...avisos, work: null, message: worker === board.preguntasIA ? "No hay preguntas pendientes. Vuelve a llamar a wait_for_work (con solo: \"preguntas\") para seguir escuchando." : "No hay tarjetas pendientes. Vuelve a llamar a wait_for_work para seguir escuchando." });
          return ok({ ...avisos, work: hand(card, worker), next: "Trabájala, informa con report_progress y termina con submit_result." });
        } finally {
          seen(worker, -1);
        }
      }),
    );

    // Abrir un proyecto desde la propia IA: lo crea (o reutiliza), la IA pasa a ser la suya y el tablero de la persona salta a él
    server.registerTool(
      "open_project",
      {
        title: "Abrir un proyecto y ser su IA",
        description:
          "Crea un proyecto en el tablero (o abre el que ya tenga ese nombre) y te hace su IA: solo tú recibirás sus tarjetas y preguntas, y otras IAs pueden llevar otros proyectos en paralelo. El tablero de la persona cambia solo a ese proyecto: no tiene que hacer nada en la app. Úsala cuando te pidan «abre/crea un proyecto…», «conéctate al proyecto…» o «trabaja en…». Después llama a wait_for_work con el worker y el project que te devuelve, en bucle, para quedarte escuchando.",
        inputSchema: {
          name: z.string().min(1).max(80).describe("Nombre del proyecto (o su id, si ya existe)"),
          worker: z.string().min(1).max(60).optional().describe("Tu nombre visible en el tablero. Por defecto «Claude · <proyecto>», para distinguirte de otras sesiones"),
          goal: z.string().max(5000).optional().describe("Objetivo grande del proyecto: se crea una tarjeta de planificación y será lo primero que recibas para dividirlo en tarjetas"),
          instructions: z.string().max(20_000).optional().describe("Reglas fijas para todas las tarjetas del proyecto (idioma, tecnología, formato…). Solo se ponen si el proyecto aún no tiene"),
        },
      },
      safe(async ({ name, worker, goal, instructions }) => {
        const buscado = name.trim();
        let p = findProject(buscado) || board.projects.find((x) => x.name.toLowerCase() === buscado.toLowerCase());
        const creado = !p;
        worker = (worker?.trim() || `Claude · ${buscado.length > 28 ? buscado.slice(0, 27).trimEnd() + "…" : buscado}`).slice(0, 60);
        if (p?.ia && p.ia !== worker && conectada(p.ia)) throw new Error(`El proyecto «${p.name}» ya lo lleva «${p.ia}», que está conectada ahora. Elige otro nombre de proyecto o pide a la persona que la cambie.`);
        if (creado) p = newProject(buscado);
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
          project: { id: p.id, name: p.name, folder: p.folder + "/", created: creado },
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
        title: "Ver el tablero",
        description: "Lista las tarjetas con su proyecto, columna, estado, progreso y quién las trabaja. Puedes filtrar por columna o por proyecto (nombre). Las archivadas no salen salvo con include_archived.",
        inputSchema: { column: COLUMN.optional(), project: z.string().optional(), include_archived: z.boolean().optional() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ column, project, include_archived }) => {
        const p = project?.toLowerCase();
        const cards = board.cards
          .filter((c) => (include_archived || !c.archivedAt) && (!column || c.column === column))
          .filter((c) => !p || (findProject(c.projectId)?.name || "").toLowerCase().includes(p))
          .map((c) => ({ ...summary(c), archived: c.archivedAt ? true : undefined }));
        const proyectos = board.projects.map((x) => `${x.name} (carpeta ${x.folder}/)`);
        return ok(cards.length ? { projects: proyectos, cards } : "No hay tarjetas con ese filtro.");
      }),
    );

    server.registerTool(
      "get_card",
      {
        title: "Ver una tarjeta",
        description: "Devuelve todo sobre una tarjeta: descripción, mensajes pendientes de la persona (inbox), resultado anterior, archivos y actividad.",
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ id }) => ok(detail(requireCard(id)))),
    );

    server.registerTool(
      "claim_card",
      {
        title: "Tomar una tarjeta",
        description: "Toma una tarjeta concreta (de cualquier columna salvo Hecho) para trabajarla tú. Normalmente es mejor usar wait_for_work.",
        inputSchema: { id: z.string(), worker: z.string().min(1) },
      },
      safe(async ({ id, worker }) => {
        seen(worker);
        return ok({ work: hand(requireCard(id), worker.slice(0, 60)) });
      }),
    );

    server.registerTool(
      "report_progress",
      {
        title: "Informar progreso",
        description:
          "Actualiza la línea de estado y la barra de progreso de tu tarjeta; la persona lo ve en vivo. Con «detalle» publicas tu avance intermedio (Markdown, puede llevar imágenes) en la sección «En vivo» de la tarjeta: sustituye al anterior, así que manda el avance completo hasta ahora.",
        inputSchema: {
          id: z.string(),
          step: z.string().describe("Qué estás haciendo ahora, en una frase corta"),
          percent: z.number().min(0).max(100).optional(),
          detalle: z.string().optional().describe("Avance intermedio en Markdown: hallazgos, borrador, tabla, capturas con ![](/files/…)"),
          worker: z.string().optional().describe("Tu nombre (el mismo de wait_for_work): si la tarjeta ya no es tuya, te avisa para que te detengas"),
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
        title: "Entregar resultado",
        description: "Entrega el resultado de tu tarjeta en Markdown (empieza con un resumen de 1-2 frases). Pasa a «Para revisar». Si la tarjeta trae acceptance_criteria, revisa cada uno y pásalos todos en criteria, con evidencia.",
        inputSchema: {
          id: z.string(),
          result: z.string().min(1),
          criteria: z
            .array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string().optional().describe("Captura (/files/…), prueba o enlace que lo demuestre; si no se cumple, por qué") }))
            .optional()
            .describe("Autorrevisión: uno por cada criterio de acceptance_criteria. Sé honesto: met=false si no lo cumples."),
          worker: z.string().optional().describe("Tu nombre (el mismo de wait_for_work): si la tarjeta ya no es tuya, te avisa para que te detengas"),
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
        return ok("Entregado. Llama a wait_for_work para la siguiente tarjeta.");
      }),
    );

    server.registerTool(
      "ask_human",
      {
        title: "Preguntar a la persona",
        description: "Pausa tu tarjeta con una pregunta para la persona. Su respuesta te llegará por wait_for_work; mientras tanto puedes seguir con otras tarjetas.",
        inputSchema: {
          id: z.string(),
          question: z.string().min(1),
          worker: z.string().optional().describe("Tu nombre (el mismo de wait_for_work): si la tarjeta ya no es tuya, te avisa para que te detengas"),
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

    server.registerTool(
      "answer_question",
      {
        title: "Responder una pregunta rápida",
        description: "Responde una pregunta rápida que te llegó por wait_for_work (campo question). La persona la ve en el momento. Contesta directo y breve, en Markdown.",
        inputSchema: { id: z.string(), answer: z.string().min(1), worker: z.string().optional() },
      },
      safe(async ({ id, answer, worker }) => {
        const q = board.questions.find((x) => x.id === id);
        if (!q) throw new Error("Esa pregunta ya no existe (la persona la borró).");
        if (q.status === "respondida") throw new Error("Esa pregunta ya está respondida.");
        if (worker && q.worker && q.worker !== worker) throw new Error(`Esa pregunta la está respondiendo «${q.worker}».`);
        q.answer = answer.slice(0, 50_000);
        q.status = "respondida";
        q.worker = worker || q.worker || "IA";
        q.answeredAt = Date.now();
        broadcastQuestions();
        return ok("Respuesta enviada. Vuelve a wait_for_work.");
      }),
    );

    server.registerTool(
      "update_memory",
      {
        title: "Actualizar la memoria del proyecto",
        description:
          "Reescribe la memoria del proyecto de tu tarjeta: lo que conviene recordar en las próximas tarjetas (decisiones, preferencias de la persona, datos del proyecto, errores a evitar). Sustituye a la anterior: parte de la memoria que recibiste, añade o corrige, y mantenla breve (viñetas).",
        inputSchema: {
          card_id: z.string().describe("Tu tarjeta: se actualiza la memoria de su proyecto"),
          memory: z.string().max(20000).describe("La memoria completa, en Markdown"),
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
        title: "Comentar en la tarjeta",
        description:
          "Deja una nota en la conversación de tu tarjeta sin entregarla ni pausarla: un hallazgo importante, una decisión que tomaste, un aviso. Si la persona te escribió mientras trabajabas, la respuesta te lo trae.",
        inputSchema: {
          id: z.string(),
          text: z.string().min(1).describe("La nota, en Markdown"),
          worker: z.string().optional().describe("Tu nombre (el mismo de wait_for_work)"),
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
        title: "Crear tarjeta",
        description: "Crea una tarjeta. Por defecto va a Ideas para que la persona decida; con request_ai=true va directa a «En curso». Hereda el proyecto de parent_id.",
        inputSchema: {
          title: z.string().min(1).describe("Título corto e imperativo"),
          description: z.string().optional().describe("Qué hay que hacer, con contexto y criterio de terminado"),
          parent_id: z.string().optional().describe("Tarjeta de la que sale esta, si aplica"),
          depends_on: z.array(z.string()).optional().describe("Ids de tarjetas que tienen que estar hechas antes que esta"),
          criteria: z.array(z.string()).optional().describe("Criterios de aceptación («Terminado cuando…»), uno por elemento, comprobables"),
          request_ai: z.boolean().optional(),
        },
      },
      safe(async ({ title, description, parent_id, depends_on, criteria, request_ai }) => {
        for (const d of depends_on || []) if (!findCard(d)) throw new Error(`depends_on: no existe la tarjeta ${d}`);
        const parent = parent_id && findCard(parent_id);
        const card = newCard({
          title,
          description: description || "",
          origin: "ia",
          parentId: parent ? parent.id : null,
          tag: parent?.kind === "plan" ? parent.title.replace(/^Planificar:\s*/, "").slice(0, 120) : null,
          projectId: parent?.projectId || null,
          criterios: criteria,
        });
        if (depends_on?.length) ponerDependencias(card, depends_on);
        if (parent) log(parent, "spawn", `Creó la tarjeta «${card.title}»`), touch(parent);
        if (request_ai) requestAI(card);
        else touch(card);
        return ok({ created: summary(card) });
      }),
    );

    server.registerTool(
      "move_card",
      {
        title: "Mover tarjeta",
        description: "Mueve una tarjeta de columna, como si la arrastrara la persona. Úsala solo si la persona te lo pide (p. ej. aprobar = done).",
        inputSchema: { id: z.string(), column: COLUMN },
      },
      safe(async ({ id, column }) => {
        const card = requireCard(id);
        moveCard(card, column);
        return ok({ moved: summary(card) });
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
        title: "Editar tarjeta",
        description: "Cambia una tarjeta existente: título, descripción, criterios de aceptación, proyecto o dependencias. Pasa solo lo que cambia. Úsala cuando la persona te lo pida (p. ej. «reescribe las tarjetas del proyecto X»). Queda apuntado en la actividad de la tarjeta.",
        inputSchema: {
          id: z.string(),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          criteria: z.array(z.string()).optional().describe("Lista completa de criterios («Terminado cuando…»); sustituye a la anterior y conserva lo revisado de los que no cambian"),
          project: z.string().nullable().optional().describe("Id o nombre del proyecto; null para dejarla sin proyecto"),
          depends_on: z.array(z.string()).optional().describe("Lista completa de ids a las que espera"),
          worker: z.string().optional().describe("Tu nombre"),
        },
      },
      safe(async ({ id, title, description, criteria, project, depends_on, worker }) => {
        const card = requireCard(id);
        noEsDeOtra(card, worker);
        const cambios = [];
        if (title !== undefined && title.trim() !== card.title) (card.title = title.trim().slice(0, 200)), cambios.push("título");
        if (description !== undefined && description !== card.description) (card.description = description.slice(0, 8000)), cambios.push("descripción");
        if (criteria !== undefined) ponerCriterios(card, criteria), cambios.push("criterios");
        if (project !== undefined) {
          const p = project === null ? null : findProject(project) || board.projects.find((x) => x.name.toLowerCase() === String(project).toLowerCase());
          if (project !== null && !p) throw new Error(`No existe el proyecto «${project}». Proyectos: ${board.projects.map((x) => `«${x.name}» (${x.id})`).join(", ")}.`);
          if ((p?.id || null) !== card.projectId) (card.projectId = p?.id || null), cambios.push("proyecto");
        }
        if (depends_on !== undefined) {
          for (const d of depends_on) if (!findCard(d)) throw new Error(`depends_on: no existe la tarjeta ${d}`);
          ponerDependencias(card, depends_on);
          cambios.push("dependencias");
        }
        if (!cambios.length) return ok({ unchanged: summary(card), message: "No había nada que cambiar." });
        log(card, "step", `✎ ${worker || "La IA"} editó: ${cambios.join(", ")}`);
        touch(card);
        return ok({ updated: summary(card), changed: cambios });
      }),
    );

    server.registerTool(
      "delete_card",
      {
        title: "Borrar tarjetas",
        description: "Borra una o varias tarjetas (p. ej. las de un proyecto: búscalas antes con list_cards). No se pierden: van a la papelera, la persona ve un aviso con «Deshacer» y se pueden restaurar 30 días (restore_card). Úsala solo cuando la persona te lo pida.",
        inputSchema: {
          ids: z.array(z.string()).min(1).describe("Ids de las tarjetas a borrar"),
          reason: z.string().optional().describe("Por qué, en una frase (lo verá la persona)"),
          worker: z.string().optional().describe("Tu nombre"),
        },
      },
      safe(async ({ ids, reason, worker }) => {
        const cards = ids.map((id) => requireCard(id));
        for (const c of cards) noEsDeOtra(c, worker); // todas o ninguna
        for (const c of cards) aLaPapelera(c, worker || "La IA", reason);
        return ok({ deleted: cards.map((c) => ({ id: c.id, title: c.title })), message: `Borrada${cards.length > 1 ? "s" : ""} ${cards.length}: están en la papelera (restore_card para recuperarlas).` });
      }),
    );

    server.registerTool(
      "list_trash",
      {
        title: "Ver la papelera",
        description: "Tarjetas borradas en los últimos 30 días, para restaurarlas con restore_card.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      safe(async () => ok(papeleraPublica().map((x) => ({ id: x.id, title: x.title, deleted_at: new Date(x.borradaEn).toISOString(), by: x.por, reason: x.motivo || undefined })))),
    );

    server.registerTool(
      "restore_card",
      {
        title: "Restaurar tarjeta",
        description: "Saca una tarjeta de la papelera y la devuelve a su columna.",
        inputSchema: { id: z.string() },
      },
      safe(async ({ id }) => ok({ restored: summary(restaurarDePapelera(id)) })),
    );

    server.registerTool(
      "list_files",
      {
        title: "Ver entregables",
        description: "Lista los archivos de la carpeta compartida de entregables del tablero.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      safe(async () => {
        const files = listFiles();
        return ok(files.length ? files.join("\n") : "(no hay archivos)");
      }),
    );

    server.registerTool(
      "read_file",
      {
        title: "Leer entregable",
        description: "Lee un archivo de la carpeta compartida de entregables. Las imágenes se devuelven como imagen.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true },
      },
      safe(async ({ path: rel }) => {
        const full = safePath(rel);
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(full).toLowerCase()];
        if (mime) return { content: [{ type: "image", data: fs.readFileSync(full).toString("base64"), mimeType: mime }] };
        return ok(fs.readFileSync(full, "utf8").slice(0, 200_000));
      }),
    );

    server.registerTool(
      "write_file",
      {
        title: "Guardar entregable",
        description:
          "Crea o sobrescribe un archivo en la carpeta de entregables del tablero. Con card_id, el archivo aparece en esa tarjeta. Para imágenes (png, jpg, gif, webp) pasa el contenido en base64 con encoding=base64; luego puedes mostrarlas en tu resultado con ![descripción](/files/<ruta>).",
        inputSchema: {
          path: z.string(),
          content: z.string(),
          encoding: z.enum(["utf8", "base64"]).optional().describe("utf8 para texto (por defecto), base64 para imágenes u otros binarios"),
          card_id: z.string().optional(),
          worker: z.string().optional().describe("Tu nombre (el mismo de wait_for_work): si la tarjeta ya no es tuya, te avisa para que te detengas"),
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
        const relPath = path.relative(WORKSPACE, full);
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

    server.registerPrompt(
      "nuevo_proyecto",
      {
        title: "Abrir un proyecto en Órbita y escucharlo",
        description: "Crea (o abre) un proyecto en el tablero, hace a esta IA su IA y la deja escuchando sus tarjetas. La app cambia sola al proyecto.",
        argsSchema: {
          nombre: z.string().describe("Nombre del proyecto"),
          objetivo: z.string().optional().describe("Objetivo grande, para que la IA lo divida en tarjetas"),
          ia: z.string().optional().describe("Cómo aparecerá la IA en el tablero"),
        },
      },
      ({ nombre, objetivo, ia }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Abre en Órbita el proyecto «${nombre}» con open_project (name: "${nombre}"${ia ? `, worker: "${ia}"` : ""}${objetivo ? `, goal: ${JSON.stringify(objetivo)}` : ""}) y quédate escuchándolo: llama a wait_for_work con el worker y el project que te devuelva, trabaja cada tarjeta que llegue y vuelve a wait_for_work, sin pedirme confirmación entre tarjetas.\n\n${INSTRUCTIONS}`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "trabajar",
      {
        title: "Ser el cerebro de Órbita",
        description: "Pone a la IA a escuchar el tablero y trabajar las tarjetas una tras otra.",
        argsSchema: { nombre: z.string().optional().describe("Cómo aparecerás en el tablero"), proyecto: z.string().optional().describe("Id o nombre del proyecto, para ser solo su IA") },
      },
      ({ nombre, proyecto }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Sé el cerebro de mi tablero Órbita. Usa las herramientas del servidor MCP "orbita" con el nombre «${nombre || "Claude"}»${proyecto ? ` y trabaja SOLO el proyecto «${proyecto}» (pasa project: "${proyecto}" en cada wait_for_work)` : ""}:\n\n${INSTRUCTIONS}\n\nEmpieza ahora con wait_for_work y sigue el ciclo sin pedirme confirmación entre tarjetas.`,
            },
          },
        ],
      }),
    );

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
