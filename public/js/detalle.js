// Órbita · Versiones, conversación, dependencias, vista previa de archivos y conectar una IA.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, LIVE, api, esc, md, proyecto, state, toast } from "./nucleo.js";
import { corto, duracion } from "./tablero.js";
import { action, closeDrawer, openDrawer, showDrawer } from "./panel.js";

// Versiones del resultado: ‹ Versión 2 de 3 › y «Ver cambios» respecto a la anterior
export function pintarVersiones(c) {
  const vs = c.versions || [];
  const ultima = vs.length - 1;
  let i = state.verVersion == null ? ultima : Math.min(state.verVersion, ultima);
  if (i < 0) {
    $("#dVer").innerHTML = "";
    $("#dVerAviso").hidden = true;
    $("#dResult").innerHTML = c.result ? md(c.result) : "";
    return;
  }
  const v = vs[i];
  const anterior = vs[i - 1];
  $("#dVer").innerHTML =
    vs.length > 1
      ? `<button class="mini" data-ver="-1" ${i === 0 ? "disabled" : ""} title="Versión anterior">‹</button><span>Versión ${v.n} de ${vs.at(-1).n}</span><button class="mini" data-ver="1" ${i === ultima ? "disabled" : ""} title="Versión siguiente">›</button>${anterior ? `<button class="mini ${state.verCambios ? "on" : ""}" data-cambios title="Qué cambió respecto a la versión ${anterior.n}">${state.verCambios ? "Ocultar cambios" : "Ver cambios"}</button>` : ""}`
      : "";
  for (const b of document.querySelectorAll("#dVer [data-ver]"))
    b.onclick = () => {
      state.verVersion = Math.max(0, Math.min(ultima, i + Number(b.dataset.ver)));
      pintarVersiones(c);
    };
  $("#dVer [data-cambios]")?.addEventListener("click", () => {
    state.verCambios = !state.verCambios;
    pintarVersiones(c);
  });
  const fecha = new Date(v.t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("#dVerAviso").hidden = i === ultima && !state.verCambios;
  $("#dVerAviso").innerHTML = i === ultima ? `Cambios de la versión ${v.n} respecto a la ${anterior?.n}` : `Estás viendo la <b>versión ${v.n}</b> (${esc(v.quien)}, ${fecha}). La actual es la ${vs.at(-1).n}.`;
  const clave = `${c.id}:${i}:${state.verCambios}:${v.result.length}`;
  if ($("#dResult").dataset.src === clave) return;
  $("#dResult").dataset.src = clave;
  $("#dResult").innerHTML = state.verCambios && anterior ? diferencias(anterior.result, v.result) : md(v.result);
}

// Diferencias línea a línea (LCS): verde lo añadido, rojo tachado lo quitado
export function diferencias(antes, despues) {
  const a = antes.split("\n"), b = despues.split("\n");
  if (a.length * b.length > 4_000_000) return `<p class="muted">Las versiones son demasiado largas para compararlas aquí.</p>` + md(despues);
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lineas = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) lineas.push(["igual", a[i++]]), j++;
    else if (i < m && (j === n || lcs[i + 1][j] >= lcs[i][j + 1])) lineas.push(["menos", a[i++]]); // primero lo que se quita…
    else lineas.push(["mas", b[j++]]); // …y después lo que entra
  }
  const añadidas = lineas.filter((l) => l[0] === "mas").length, quitadas = lineas.filter((l) => l[0] === "menos").length;
  return `<p class="diff-resumen"><span class="mas">+${añadidas}</span> <span class="menos">−${quitadas}</span> líneas</p><div class="diff">${lineas
    .map(([tipo, texto]) => `<div class="d-${tipo}"><span>${tipo === "mas" ? "+" : tipo === "menos" ? "−" : " "}</span>${esc(texto) || "&nbsp;"}</div>`)
    .join("")}</div>`;
}

// Conversación: tú a la derecha, la IA a la izquierda
export const ETIQUETA = { respuesta: "respuesta", pregunta: "❓ pregunta", nota: "📝 nota", entrega: "✓ entregó" };
export function pintarHilo(c) {
  const lista = $("#dThread");
  const mensajes = c.thread || [];
  const firma = `${mensajes.length}:${mensajes.at(-1)?.t || 0}:${c.status}`;
  if (lista.dataset.firma !== firma) {
    lista.dataset.firma = firma;
    lista.innerHTML = mensajes.length
      ? mensajes
          .map((m, i) => {
            const pendiente = m.tipo === "pregunta" && i === mensajes.length - 1 && c.status === "waiting";
            const hora = new Date(m.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            return `<li class="msg ${m.de} ${m.tipo}${pendiente ? " pendiente" : ""}"><div class="who">${m.de === "persona" ? "Tú" : `🧠 ${esc(m.quien || "IA")}`}${ETIQUETA[m.tipo] ? ` · <span>${ETIQUETA[m.tipo]}</span>` : ""}<time>${hora}</time></div><div class="txt">${md(m.texto)}</div></li>`;
          })
          .join("")
      : ""; // vacía: el campo de abajo ya dice a quién le llega lo que escribas
    lista.scrollTop = lista.scrollHeight;
  }
  // El cuadro de texto se adapta a lo que está pasando
  const ta = $("#dFeedbackText");
  const quien = c.worker || "la IA";
  let botones;
  if (c.status === "waiting") {
    ta.placeholder = "Tu respuesta…";
    botones = `<button class="btn primary" data-a="answer">Responder</button>`;
  } else if (LIVE.includes(c.status)) {
    ta.placeholder = c.status === "queued" ? "Instrucciones para quien la tome…" : `Escribe a ${quien}: lo leerá en su próximo paso, sin detenerse…`;
    botones = `<button class="btn primary" data-a="comment">Enviar</button>`;
  } else if (c.column === "backlog") {
    ta.placeholder = "Nota o instrucción para quien la trabaje…";
    botones = `<button class="btn primary" data-a="feedback">⚡ Pedírsela a la IA</button><button class="btn" data-a="comment">Solo anotar</button>`;
  } else {
    // Entregada: aquí se le contesta (a lo que preguntó u ofreció al entregar) o se le piden cambios
    ta.placeholder = `Responde a ${quien} o pide cambios: lo recibe y sigue con esta tarjeta…`;
    botones = `<button class="btn primary" data-a="feedback">↩ Responder a la IA</button><button class="btn" data-a="comment">Solo anotar</button>`;
  }
  const marcados = (c.criterios || []).filter((x) => x.falla);
  if (marcados.length && c.column === "review") ta.placeholder = `La IA sabrá que no se cumple${marcados.length > 1 ? "n" : ""} ${marcados.map((x) => `«${corto(x.texto, 40)}»`).join(", ")}. Añade lo que quieras…`;
  if ($("#dSend").dataset.modo !== botones) {
    $("#dSend").dataset.modo = botones;
    $("#dSend").innerHTML = botones;
    for (const b of document.querySelectorAll("#dSend .btn")) b.onclick = () => action(c.id, b.dataset.a);
  }
}

// «Espera a…» en el panel de la tarjeta
export function pintarDependencias(c) {
  const deps = (c.dependsOn || []).map((id) => state.cards.get(id)).filter(Boolean);
  $("#dDepList").innerHTML = deps.length
    ? deps
        .map((d) => `<li class="${d.column === "done" ? "hecha" : ""}"><span class="dep-estado">${d.column === "done" ? "✓" : "⏳"}</span><button class="link-card" data-open="${d.id}">${esc(d.title)}</button><span class="muted">${d.column === "done" ? "hecha" : { backlog: "en Ideas", doing: "en curso", review: "para revisar" }[d.column]}</span><button class="icon-btn dep-quitar" data-quitar="${d.id}" title="Ya no esperar a esta">✕</button></li>`)
        .join("")
    : "";
  // Candidatas: mismo proyecto, sin archivar, que no sean ella ni la esperen ya (eso haría un ciclo; el servidor lo comprueba)
  const esperanA = (id, vistas = new Set()) => [...state.cards.values()].some((x) => x.dependsOn?.includes(id) && (x.id === c.id || (!vistas.has(x.id) && (vistas.add(x.id), esperanA(x.id, vistas)))));
  const candidatas = [...state.cards.values()].filter((x) => x.id !== c.id && !x.archivedAt && !c.dependsOn?.includes(x.id) && x.projectId === c.projectId && !esperanA(x.id) && !(x.dependsOn || []).includes(c.id));
  $("#dDepAdd").innerHTML = `<option value="">＋ Añadir una tarjeta a la que espera…</option>` + candidatas.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join("");
  $("#dDepAdd").hidden = candidatas.length === 0;
  $("#dDeps").hidden = !deps.length && !candidatas.length; // nada que mostrar ni que elegir
  const guardar = (ids) => api(`/api/cards/${c.id}/edit`, { dependsOn: ids }).catch((err) => toast(err.message, true));
  $("#dDepAdd").onchange = (e) => {
    if (e.target.value) guardar([...(c.dependsOn || []), e.target.value]);
  };
  for (const b of document.querySelectorAll("#dDepList [data-quitar]")) b.onclick = () => guardar(c.dependsOn.filter((x) => x !== b.dataset.quitar));
  for (const b of document.querySelectorAll("#dDepList [data-open]")) b.onclick = () => openDrawer(b.dataset.open);
}

// Opciones de proyecto para un <select>
// Toda tarjeta es de un proyecto: si no se indica, el que estás viendo (o «General», o el primero)
export function llenarProyectos(select, valor) {
  select.innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  select.value = proyecto(valor)?.id || proyecto(state.filtro)?.id || state.projects.find((p) => p.name === "General")?.id || state.projects[0]?.id || "";
}

export async function openFile(f) {
  const url = "/files/" + f.split("/").map(encodeURIComponent).join("/");
  const vista = state.vista + f.split("/").map(encodeURIComponent).join("/"); // aislada: puede ejecutarse sin tocar el tablero
  const ext = (f.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const tipo =
    ["html", "htm"].includes(ext) ? "html"
    : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "img"
    : ext === "pdf" ? "pdf"
    : ["mp3", "wav", "ogg"].includes(ext) ? "audio"
    : ["mp4", "webm"].includes(ext) ? "video"
    : ext === "md" ? "md"
    : ["csv", "tsv"].includes(ext) ? "csv"
    : ext === "json" ? "json"
    : LENGUAJE[ext] ? "codigo"
    : "texto";
  const text = ["md", "csv", "json", "codigo", "texto"].includes(tipo) ? await (await fetch(url)).text() : "";
  const back = state.openId;
  state.view = "file";
  const nombre = f.split("/").pop();
  let cuerpo;
  if (tipo === "html")
    cuerpo = `<div class="vista-barra"><span class="muted">▶ Funciona aquí mismo, aislada de tu tablero</span><button class="mini" id="vRecargar" title="Volver a cargar">↻ Recargar</button><button class="mini" id="vGrande" title="A pantalla completa">⛶ En grande</button><a class="mini" href="${esc(vista)}" target="_blank" rel="noopener">↗ Pestaña nueva</a></div>
      <iframe class="vista-html" id="vFrame" src="${esc(vista)}" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups" title="${esc(nombre)}"></iframe>`;
  else if (tipo === "img") cuerpo = `<img src="${esc(ext === "svg" ? vista : url)}" alt="${esc(f)}">`;
  else if (tipo === "pdf") cuerpo = `<iframe class="vista-html vista-pdf" src="${esc(vista)}" title="${esc(nombre)}"></iframe>`;
  else if (tipo === "audio") cuerpo = `<audio controls src="${esc(vista)}" style="width:100%"></audio>`;
  else if (tipo === "video") cuerpo = `<video controls src="${esc(vista)}" style="width:100%;border-radius:10px"></video>`;
  else if (tipo === "md") cuerpo = `<div class="result">${md(text)}</div>`;
  else if (tipo === "csv") cuerpo = tablaCSV(text, ext === "tsv" ? "\t" : null);
  else if (tipo === "json") {
    let bonito = text;
    try {
      bonito = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
    cuerpo = bloqueCodigo(bonito, "json");
  } else if (tipo === "codigo") cuerpo = bloqueCodigo(text, LENGUAJE[ext]);
  else cuerpo = `<pre>${esc(text)}</pre>`;
  $("#drawerBody").innerHTML = `
    <div class="d-head"><div class="t" style="font-family:var(--mono);font-size:15px">${esc(f)}</div><button class="icon-btn" id="dBack" title="Volver">←</button></div>
    <div class="vista-acciones"><a class="mini" href="${esc(url)}" download="${esc(nombre)}">⤓ Descargar</a></div>
    <div class="d-section file-view tipo-${tipo}">${cuerpo}</div>`;
  $("#dBack").onclick = () => (back && state.cards.has(back) ? openDrawer(back) : closeDrawer());
  if (tipo === "html") {
    $("#vRecargar").onclick = () => ($("#vFrame").src = vista);
    $("#vGrande").onclick = () => vistaGrande(vista, nombre);
  }
  showDrawer(); // desde «Entregables» el panel podía estar cerrado: el archivo se abría sin verse
}

// A pantalla completa, dentro de Órbita (sigue aislada); Esc o ✕ para salir
export function vistaGrande(src, nombre) {
  const capa = document.createElement("div");
  capa.className = "vista-grande";
  capa.id = "vistaGrande";
  capa.innerHTML = `<div class="vg-barra"><span>${esc(nombre)}</span><span class="muted vg-nota">Esc con el cursor fuera de la página · dentro, las teclas son de la página</span><button class="btn" id="vgCerrar" title="Salir de la vista en grande">✕ Salir</button></div><iframe src="${esc(src)}" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups" title="${esc(nombre)}"></iframe>`;
  document.body.append(capa);
  const cerrar = () => {
    capa.remove();
    document.removeEventListener("keydown", tecla, true);
  };
  const tecla = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // que no cierre también el panel
    cerrar();
  };
  document.addEventListener("keydown", tecla, true);
  $("#vgCerrar").onclick = cerrar;
  capa.querySelector("iframe").focus(); // para jugar o escribir sin hacer clic antes
}

// CSV → tabla (con comillas, comas dentro de comillas y saltos de línea)
export function tablaCSV(texto, sep) {
  sep ||= (texto.split("\n")[0].match(/;/g) || []).length > (texto.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') (campo += '"'), i++;
      else if (ch === '"') comillas = false;
      else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) fila.push(campo), (campo = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo), filas.push(fila), (fila = []), (campo = "");
    } else campo += ch;
  }
  if (campo || fila.length) fila.push(campo), filas.push(fila);
  const datos = filas.filter((r) => r.some((c) => c.trim()));
  if (!datos.length) return `<p class="muted">El archivo está vacío.</p>`;
  const [cab, ...resto] = datos;
  const max = 500;
  const num = (v) => /^[+-]?[\d.,]+\s?%?$/.test(v.trim()) && /\d/.test(v);
  return `<div class="tabla-csv"><table><thead><tr>${cab.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${resto
    .slice(0, max)
    .map((r) => `<tr>${cab.map((_, k) => `<td${num(r[k] || "") ? ' class="num"' : ""}>${esc(r[k] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div><p class="muted tabla-pie">${resto.length} fila${resto.length === 1 ? "" : "s"} × ${cab.length} columna${cab.length === 1 ? "" : "s"}${resto.length > max ? ` (se muestran ${max})` : ""}</p>`;
}

// Código con colores, sin librerías: comentarios, cadenas, números y palabras clave
export const LENGUAJE = { js: "js", mjs: "js", cjs: "js", ts: "js", jsx: "js", tsx: "js", py: "py", css: "css", sh: "sh", bash: "sh", zsh: "sh", sql: "sql", yml: "yaml", yaml: "yaml", java: "js", c: "js", cpp: "js", go: "js", rs: "js", swift: "js", rb: "py", php: "js", xml: "xml" };
export const CLAVES = {
  js: "async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
  sh: "if then else elif fi for while do done case esac function in export local return echo exit",
  sql: "select from where and or not insert into values update set delete create table drop alter join left right inner on group by order having limit as null primary key",
  css: "",
  yaml: "true false null",
  json: "true false null",
  xml: "",
};
export function bloqueCodigo(texto, lenguaje) {
  const claves = new Set((CLAVES[lenguaje] || "").split(" ").filter(Boolean));
  const comentario = lenguaje === "py" || lenguaje === "sh" || lenguaje === "yaml" ? "#[^\\n]*" : lenguaje === "sql" ? "--[^\\n]*" : lenguaje === "json" ? "(?!)" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const re = new RegExp(`(${comentario})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, "g");
  const colorear = (t) => {
    let html = "", ultimo = 0;
    for (const m of t.matchAll(re)) {
      html += esc(t.slice(ultimo, m.index));
      const [todo, com, cad, num, pal] = m;
      if (com) html += `<span class="c-com">${esc(com)}</span>`;
      else if (cad) html += `<span class="c-cad">${esc(cad)}</span>`;
      else if (num) html += `<span class="c-num">${esc(num)}</span>`;
      else if (pal && claves.has(lenguaje === "sql" ? pal.toLowerCase() : pal)) html += `<span class="c-clave">${esc(pal)}</span>`;
      else html += esc(todo);
      ultimo = m.index + todo.length;
    }
    return html + esc(t.slice(ultimo));
  };
  const lineas = colorear(texto.length > 400_000 ? texto.slice(0, 400_000) : texto).split("\n");
  return `<pre class="codigo" data-lenguaje="${esc(lenguaje)}"><code>${lineas.map((l, i) => `<span class="ln">${i + 1}</span>${l}`).join("\n")}</code></pre>`;
}

// Conectar una IA como cerebro
export function openConnect() {
  state.openId = null;
  state.view = "connect";
  const url = state.mcpUrl;
  const snippets = [
    ["Claude Code", "Conéctalo una vez (queda disponible en todas tus sesiones):", `claude mcp add --transport http --scope user orbita ${url}`],
    ["Cursor / Windsurf / VS Code", "Añade esto a la configuración MCP (por ejemplo ~/.cursor/mcp.json):", JSON.stringify({ mcpServers: { orbita: { url } } }, null, 2)],
    ["Claude Desktop", "Añade esto a claude_desktop_config.json (usa el puente mcp-remote):", JSON.stringify({ mcpServers: { orbita: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2)],
  ];
  const tools = [
    ["wait_for_work", "escucha el tablero y toma la siguiente tarjeta en «En curso»"],
    ["report_progress", "mueve la barra de progreso en vivo"],
    ["submit_result", "entrega el resultado para que lo revises"],
    ["ask_human", "te hace una pregunta"],
    ["create_card", "crea tarjetas (por ejemplo, al planificar un objetivo)"],
    ["list_cards / get_card / update_card", "consulta y edita el tablero"],
    ["read_file / write_file", "comparte archivos y entregables"],
  ];
  const brains = state.brains.length
    ? `<div class="brain-now on">🧠 Conectada ahora: <b>${state.brains.map((b) => esc(b.name) + (b.listening ? " (escuchando)" : "")).join(", ")}</b></div>`
    : `<div class="brain-now">Ahora mismo no hay ninguna IA conectada. Las tarjetas que pongas en «En curso» esperarán a que se conecte una.</div>`;
  $("#drawerBody").innerHTML = `
    <div class="d-head"><div class="t">Conecta un cerebro</div><button class="icon-btn" id="dClose" title="Cerrar (Esc)" aria-label="Cerrar">✕</button></div>
    <p class="sub" style="margin:6px 0 4px;font-size:13px">Órbita no usa API keys. La inteligencia la pone la IA que conectes por MCP: Claude Code, Cursor, Claude Desktop o cualquier otra. Esa IA toma las tarjetas que pongas en «En curso», te muestra su progreso y te entrega el resultado.</p>
    ${brains}
    <div class="mcp-url"><code>${esc(url)}</code><button class="btn" data-copy="${esc(url)}">Copiar</button></div>
    ${snippets.map(([name, hint, code]) => `<div class="d-section"><h4>${name}</h4><p class="sub" style="margin:0 0 8px">${hint}</p><div class="snippet"><pre>${esc(code)}</pre><button class="btn" data-copy="${esc(code)}">Copiar</button></div></div>`).join("")}
    <div class="d-section"><h4>Ponla a trabajar</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">Abre el panel 🧠 de tu proyecto (en la barra de secciones), copia su instrucción y pégala en una sesión de tu IA: se queda escuchando las tarjetas de ese proyecto. O pídeselo con tus palabras: <i>«Sé el cerebro de mi tablero Órbita: usa wait_for_work y trabaja las tarjetas una tras otra»</i>.</p>
    </div>
    <div class="d-section" id="dClaudeHooks"><h4>Todo lo que hace Claude, en vivo</h4><p class="sub" style="margin:0;font-size:13px">Cargando…</p></div>
    <div class="d-section"><h4>Un proyecto nuevo, desde tu IA</h4>
      <p class="sub" style="margin:0 0 8px;font-size:13px">No hace falta tocar la app: pídeselo en su chat y el tablero cambia solo al proyecto. Por ejemplo: <i>«Abre en Órbita un proyecto llamado Web de la tienda y quédate escuchando»</i>. Cada sesión puede llevar su propio proyecto, en paralelo.</p>
    </div>
    <div class="d-section"><h4>Lo que puede hacer</h4><ul class="tool-list">${tools.map(([t, d]) => `<li><code>${t}</code><span>${d}</span></li>`).join("")}</ul></div>`;
  $("#dClose").onclick = closeDrawer;
  const copiables = () => {
    for (const b of document.querySelectorAll("#drawerBody [data-copy]"))
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast("Copiado ✓");
        } catch {
          toast("No se pudo copiar; selecciónalo a mano", true);
        }
      };
  };
  copiables();
  showDrawer();
  // Los hooks de Claude Code que mandan a Órbita todo lo que hace (Órbita no toca su configuración: tú la añades)
  api("/api/claude/hooks")
    .then(({ configuracion, ultimoEvento }) => {
      const caja = $("#dClaudeHooks");
      if (!caja || state.view !== "connect") return;
      const json = JSON.stringify(configuracion, null, 2);
      caja.innerHTML = `<h4>Todo lo que hace Claude, en vivo</h4>
        <p class="sub" style="margin:0 0 8px;font-size:13px">Para ver en la pestaña «En vivo» cada comando, cada archivo que lee o edita, sus búsquedas, lo que dice y cuándo espera tu permiso, añade estos hooks a los ajustes de Claude Code: <code>~/.claude/settings.json</code> (en todos tus proyectos) o <code>.claude/settings.json</code> de un proyecto. Si ya tienes una sección <code>"hooks"</code>, añade estas entradas dentro. Si Órbita no está abierta, Claude sigue igual.</p>
        <div class="snippet"><pre>${esc(json)}</pre><button class="btn" data-copy="${esc(json)}">Copiar</button></div>
        <p class="sub" style="margin:10px 0 0;font-size:13px">${ultimoEvento ? `✓ Llegan eventos de Claude: el último, hace <span data-since="${ultimoEvento}">${duracion(ultimoEvento)}</span>.` : "Aún no ha llegado ningún evento: se verán en la tarjeta que Claude esté trabajando."}</p>`;
      copiables();
    })
    .catch(() => {});
}
