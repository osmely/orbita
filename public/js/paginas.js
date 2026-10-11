// Órbita · Páginas del proyecto: instrucciones, entidades, conocimiento, entregables y archivo.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, api, elegirCarpeta, esc, fileIcon, md, proyecto, state, toast, tono, visible } from "./nucleo.js";
import { archivosDe, corto, deFiltro, elegirFiltro, proyectoPorDefecto, upsert } from "./tablero.js";
import { autosize, closeDrawer, openDrawer, showDrawer } from "./panel.js";
import { openFile } from "./detalle.js";
import { buscar, sinTildes } from "./busqueda.js";

// Instrucciones y memoria (y nombre, y eliminar si está vacío)
export function paginaAjustes(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".ajustes")) {
    pagina.innerHTML = `<div class="ajustes">
      <p class="intro">Lo que escribas aquí lo recibe la IA con <b>cada tarjeta</b> de este proyecto.</p>
      <label class="campo"><span>Nombre</span><input class="campo-input" data-campo="name"></label>
      <label class="campo"><span>Instrucciones para la IA</span><textarea data-campo="instructions" rows="6" placeholder="Reglas fijas para todas las tarjetas: idioma y tono, tecnología, formato de entrega, qué evitar…"></textarea></label>
      <label class="campo"><span>Memoria <small class="muted" data-memoria-fecha></small></span><textarea data-campo="memory" rows="10" placeholder="Lo que la IA aprende entre tarjetas: decisiones, preferencias, datos. Puedes editarla."></textarea></label>
      <div class="campo"><span>Secretos <small class="muted">claves de API, tokens, contraseñas de servicios…</small></span>
        <ul class="kn-list secretos" data-secretos></ul>
        <form class="secreto-nuevo" data-secreto-form autocomplete="off">
          <input class="campo-input" name="nombre" placeholder="NOMBRE (p. ej. STRIPE_API_KEY)" spellcheck="false" autocapitalize="characters" required>
          <input class="campo-input" name="valor" type="password" placeholder="Valor" autocomplete="new-password" required>
          <button class="btn mini-btn">Guardar</button>
        </form>
        <small class="muted">La IA recibe solo los nombres con cada tarjeta y pide el valor cuando lo necesita (queda en la actividad de la tarjeta). Si lo pega en un resultado o un comentario, el tablero lo tapa. Se guardan en la carpeta de datos de Órbita, solo en este equipo: no van en <code>orbita/</code>, así que no viajan con la carpeta ni acaban en un repositorio. Una vez guardado, el valor no se vuelve a mostrar; para cambiarlo, guárdalo otra vez con el mismo nombre.</small></div>
      <div class="campo"><span>Carpeta de trabajo</span>
        <div class="carpeta-trabajo"><code data-carpeta></code><button type="button" class="btn mini-btn" data-mostrar>Abrir</button><button type="button" class="btn mini-btn" data-cambiar-carpeta>Cambiar…</button></div>
        <small class="muted">La IA trabaja aquí. Órbita guarda el tablero del proyecto y sus entregables en <code>orbita/</code>, dentro de esta carpeta: si la copias o la subes a un repositorio, el proyecto va con ella.</small></div>
      <div class="peligro" data-peligro></div>
    </div>`;
    for (const campo of pagina.querySelectorAll("[data-campo]"))
      campo.onchange = () =>
        api(`/api/projects/${p.id}/edit`, { [campo.dataset.campo]: campo.value })
          .then(() => toast(campo.dataset.campo === "name" ? "Proyecto renombrado" : "Guardado"))
          .catch((err) => toast(err.message, true));
    const form = pagina.querySelector("[data-secreto-form]");
    form.nombre.oninput = () => (form.nombre.value = form.nombre.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nombre = form.nombre.value.trim();
      const habia = (proyecto(state.filtro)?.secretos || []).some((x) => x.nombre === nombre);
      try {
        await api(`/api/projects/${state.filtro}/secretos`, { nombre, valor: form.valor.value });
        form.reset();
        toast(habia ? `Secreto ${nombre} cambiado` : `Secreto ${nombre} guardado`);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  // Secretos: solo nombres y fechas (el valor no sale del servidor)
  const secretos = p.secretos || [];
  pagina.querySelector("[data-secretos]").innerHTML = secretos.length
    ? secretos
        .map((x) => `<li><span class="file"><code>${esc(x.nombre)}</code> <span class="muted">•••••••• · ${esc(new Date(x.t).toLocaleDateString())}</span></span><button type="button" class="btn mini-btn" data-cambiar="${esc(x.nombre)}" title="Escribir un valor nuevo">Cambiar</button><button type="button" class="icon-btn" data-quitar="${esc(x.nombre)}" title="Borrar el secreto">✕</button></li>`)
        .join("")
    : `<li class="muted">Este proyecto aún no tiene secretos.</li>`;
  for (const b of pagina.querySelectorAll("[data-secretos] [data-cambiar]"))
    b.onclick = () => {
      const form = pagina.querySelector("[data-secreto-form]");
      form.nombre.value = b.dataset.cambiar;
      form.valor.focus();
    };
  for (const b of pagina.querySelectorAll("[data-secretos] [data-quitar]"))
    b.onclick = () => {
      if (!confirm(`¿Borrar el secreto ${b.dataset.quitar}? La IA dejará de poder usarlo.`)) return;
      api(`/api/projects/${p.id}/secretos/${encodeURIComponent(b.dataset.quitar)}`, undefined, "DELETE")
        .then(() => toast(`Secreto ${b.dataset.quitar} borrado`))
        .catch((err) => toast(err.message, true));
    };
  // Rellenar sin pisar el campo que estás escribiendo
  for (const campo of pagina.querySelectorAll("[data-campo]")) {
    const valor = p[campo.dataset.campo] || "";
    if (document.activeElement !== campo && campo.value !== valor) {
      const habia = campo.value;
      campo.value = valor;
      if (habia) {
        campo.classList.remove("flash");
        void campo.offsetWidth;
        campo.classList.add("flash");
      }
    }
  }
  pagina.querySelector("[data-memoria-fecha]").textContent = p.memoryAt ? `actualizada ${new Date(p.memoryAt).toLocaleString()}` : "la IA la irá completando";
  pagina.querySelector("[data-carpeta]").textContent = p.dir;
  pagina.querySelector("[data-mostrar]").onclick = () => api(`/api/projects/${p.id}/mostrar`, {}).catch((err) => toast(err.message, true));
  pagina.querySelector("[data-cambiar-carpeta]").onclick = async () => {
    try {
      const dir = await elegirCarpeta(`Nueva carpeta de trabajo de «${p.name}» (su carpeta orbita/ se moverá allí)`);
      if (!dir) return;
      await api(`/api/projects/${p.id}/carpeta`, { dir });
      toast(`«${p.name}» trabaja ahora en ${dir}`);
    } catch (err) {
      toast(err.message, true);
    }
  };
  const tiene = [...state.cards.values()].some((c) => c.projectId === p.id);
  pagina.querySelector("[data-peligro]").innerHTML = tiene
    ? `<p class="muted">Para eliminar el proyecto, primero mueve o elimina sus tarjetas. Si solo quieres quitarlo de la vista, cierra su pestaña (✕).</p>`
    : `<button class="btn danger" data-eliminar>Eliminar proyecto</button> <span class="muted">Está vacío. Sus archivos no se tocan.</span>`;
  pagina.querySelector("[data-eliminar]")?.addEventListener("click", () => {
    if (!confirm(`¿Eliminar el proyecto «${p.name}»?`)) return;
    api(`/api/projects/${p.id}`, undefined, "DELETE")
      .then(() => {
        toast("Proyecto eliminado");
        elegirFiltro(proyectoPorDefecto(p.id));
      })
      .catch((err) => toast(err.message, true));
  });
}

// Entidades: lo que existe en el proyecto y perdura (personajes, armas, objetos, personas, lugares…), como fichas
// agrupadas por categoría. Las va guardando la IA (save_entity) y aquí se ven, se buscan y se editan.
export const ICONOS_CATEGORIA = [
  // [cómo se reconoce, icono, tono del color]
  [/personaj|heroe|villan|npc|criatur|enemig|monstru|bestia/, "🧙", 268],
  [/arma/, "⚔️", 0],
  [/objet|item|inventari|equipo|recurso|pocion|artefact/, "🎒", 32],
  [/persona|contact|cliente|usuari|gente|miembro|autor/, "👤", 205],
  [/lugar|mapa|zona|nivel|region|ciudad|escenari|mundo/, "🗺️", 145],
  [/hechiz|magia|habilidad|poder|talento/, "✨", 300],
  [/faccion|grupo|organiz|empresa|clan|gremio|reino/, "🏰", 20],
  [/vehicul|nave|montura/, "🚀", 185],
  [/mision|quest|evento|capitulo|escena/, "📜", 48],
  [/concept|idea|tema|regla/, "💡", 58],
];
export function categoriaConocida(cat) {
  return ICONOS_CATEGORIA.find(([re]) => re.test(sinTildes(cat)));
}
export function iconoCategoria(cat) {
  return categoriaConocida(cat)?.[1] || "🏷️";
}
// Un color propio por categoría: el de las habituales, o uno de la paleta según su nombre
export const TONOS_CATEGORIA = [268, 205, 145, 32, 330, 185, 0, 95, 48, 300];
export function tonoCategoria(cat) {
  return categoriaConocida(cat)?.[2] ?? TONOS_CATEGORIA[[...sinTildes(cat)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) % TONOS_CATEGORIA.length];
}
export function imagenEntidad(e) {
  return e.imagen ? `/files/${e.imagen.split("/").map(encodeURIComponent).join("/")}?v=${e.actualizada?.t || ""}` : "";
}

export function paginaEntidades(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".entidades")) {
    pagina.innerHTML = `<div class="entidades">
      <div class="ent-barra">
        <input class="campo-input" type="search" placeholder="Buscar por nombre, detalles o etiquetas…" data-buscar autocomplete="off">
        <button class="btn primary" data-nueva>＋ Nueva entidad</button>
      </div>
      <div class="ent-cats" data-cats></div>
      <div data-grupos></div>
    </div>`;
    const buscar = pagina.querySelector("[data-buscar]");
    buscar.value = state.entBusca || "";
    buscar.oninput = () => {
      state.entBusca = buscar.value;
      paginaEntidades(pagina);
    };
    pagina.querySelector("[data-nueva]").onclick = () => abrirEntidad(state.filtro, null);
  }
  const todas = p.entidades || [];
  const porCat = new Map();
  for (const e of todas) porCat.set(e.categoria, (porCat.get(e.categoria) || 0) + 1);
  if (state.entCat && !porCat.has(state.entCat)) state.entCat = "";
  const cats = [...porCat.keys()].sort((a, b) => a.localeCompare(b));
  pagina.querySelector("[data-cats]").innerHTML = todas.length
    ? [`<button class="ent-cat ${state.entCat ? "" : "on"}" data-cat="">Todas <b>${todas.length}</b></button>`, ...cats.map((c) => `<button class="ent-cat ${state.entCat === c ? "on" : ""}" data-cat="${esc(c)}" style="--h:${tonoCategoria(c)}">${iconoCategoria(c)} ${esc(c)} <b>${porCat.get(c)}</b></button>`)].join("")
    : "";
  for (const b of pagina.querySelectorAll("[data-cat]"))
    b.onclick = () => {
      state.entCat = b.dataset.cat;
      paginaEntidades(pagina);
    };
  const palabras = sinTildes(state.entBusca || "").split(/\s+/).filter(Boolean);
  const visibles = todas.filter((e) => (!state.entCat || e.categoria === state.entCat) && palabras.every((w) => sinTildes([e.nombre, e.categoria, e.resumen, e.detalles, ...(e.etiquetas || [])].join(" ")).includes(w)));
  const grupos = pagina.querySelector("[data-grupos]");
  if (!todas.length) {
    grupos.innerHTML = `<div class="ent-vacio">
      <div class="ent-vacio-iconos" aria-hidden="true">🧙 ⚔️ 🎒 👤 🗺️</div>
      <h3>Aún no hay entidades</h3>
      <p>Las entidades son lo que existe en el proyecto y conviene recordar: los personajes de un juego, sus armas y objetos, las personas de un informe, los lugares de una historia… Cada una es una ficha con su categoría, resumen, detalles e imagen.</p>
      <p class="muted">La IA las va guardando mientras trabaja. También puedes pedírselo en una tarjeta: <i>«Extrae los personajes, armas y objetos del juego como entidades»</i>, o crearlas tú.</p>
    </div>`;
    return;
  }
  if (!visibles.length) {
    grupos.innerHTML = `<p class="muted ent-nada">Ninguna entidad coincide con la búsqueda.</p>`;
    return;
  }
  const enGrupos = new Map();
  for (const e of visibles.sort((a, b) => a.nombre.localeCompare(b.nombre))) enGrupos.set(e.categoria, [...(enGrupos.get(e.categoria) || []), e]);
  grupos.innerHTML = [...enGrupos.keys()]
    .sort((a, b) => enGrupos.get(b).length - enGrupos.get(a).length || a.localeCompare(b)) // los más numerosos primero
    .map(
      (cat) => `<section class="ent-grupo" style="--h:${tonoCategoria(cat)}">
        <h3><span class="ent-grupo-ico">${iconoCategoria(cat)}</span>${esc(cat)} <b>${enGrupos.get(cat).length}</b></h3>
        <div class="ent-grid">${enGrupos
          .get(cat)
          .map(
            (e) => `<button class="ent-ficha" data-ent="${esc(e.id)}">
              <span class="ent-img ${e.imagen ? "" : "sin"}">${e.imagen ? `<img src="${esc(imagenEntidad(e))}" alt="" loading="lazy">` : `<span class="ent-img-ico">${iconoCategoria(cat)}</span>`}</span>
              <span class="ent-txt"><b>${esc(e.nombre)}</b>${e.resumen ? `<span class="ent-resumen">${esc(e.resumen)}</span>` : ""}${e.etiquetas?.length ? `<span class="ent-tags">${e.etiquetas.slice(0, 4).map((t) => `<i>${esc(t)}</i>`).join("")}</span>` : ""}</span>
            </button>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");
  for (const b of grupos.querySelectorAll("[data-ent]")) b.onclick = () => abrirEntidad(state.filtro, b.dataset.ent);
}

// La ficha de una entidad, en el panel lateral: se edita y se guarda con «Guardar» (id null = nueva)
export function abrirEntidad(pid, id) {
  const p = proyecto(pid);
  const e = id ? (p?.entidades || []).find((x) => x.id === id) : null;
  if (!p || (id && !e)) return toast("Esa entidad ya no existe", true);
  state.openId = null;
  state.view = "entidad";
  state.entidadAbierta = { pid, id };
  const cat = e?.categoria || state.entCat || "";
  const cats = [...new Set([...(p.entidades || []).map((x) => x.categoria), "Personajes", "Armas", "Objetos", "Personas", "Lugares"])];
  const cuando = (x) => (x ? `${esc(x.por)}, ${new Date(x.t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "");
  $("#drawerBody").innerHTML = `
    <div class="d-head">
      <textarea class="t" rows="1" id="eNombre" placeholder="Nombre de la entidad" maxlength="120">${esc(e?.nombre || "")}</textarea>
      <button class="icon-btn" id="dClose" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="ent-cabecera">
      <label class="ent-foto" id="eFoto" title="${id ? "Pulsa o arrastra una imagen" : "Guárdala primero para añadirle una imagen"}" style="--h:${tonoCategoria(cat || "x")}">
        ${e?.imagen ? `<img src="${esc(imagenEntidad(e))}" alt="">` : `<span class="ent-img-ico">${iconoCategoria(cat)}</span><small>${id ? "＋ Imagen" : ""}</small>`}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden id="eFotoInput" ${id ? "" : "disabled"}>
      </label>
      <div class="ent-campos">
        <label class="field">Categoría <input id="eCat" list="eCats" value="${esc(cat)}" placeholder="Personajes, Armas, Objetos…" maxlength="40" autocomplete="off"></label>
        <datalist id="eCats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <label class="field">Etiquetas <input id="eTags" value="${esc((e?.etiquetas || []).join(", "))}" placeholder="separadas por comas" autocomplete="off"></label>
      </div>
    </div>
    <label class="campo"><span>Resumen</span><input class="campo-input" id="eResumen" maxlength="500" value="${esc(e?.resumen || "")}" placeholder="Una línea que la describa"></label>
    <div class="d-section">
      <h4>Detalles <button class="mini" id="eEditar" style="margin-left:auto">${e?.detalles ? "Editar" : "Escribir"}</button></h4>
      <div class="result" id="eVista" ${e?.detalles ? "" : "hidden"}>${e?.detalles ? md(e.detalles) : ""}</div>
      <textarea class="d-desc" id="eDetalles" rows="12" hidden placeholder="Todo lo que conviene recordar: atributos, historia, relaciones… (Markdown)">${esc(e?.detalles || "")}</textarea>
    </div>
    ${e ? `<p class="muted ent-meta">Creada por ${cuando(e.creada)}${e.actualizada && e.actualizada.t !== e.creada.t ? ` · actualizada por ${cuando(e.actualizada)}` : ""}</p>` : ""}
    <div class="actions">
      <button class="btn primary" id="eGuardar">${id ? "Guardar" : "Crear entidad"}</button>
      ${e?.imagen ? `<button class="btn" id="eQuitarFoto">Quitar imagen</button>` : ""}
      ${id ? `<button class="btn danger" id="eBorrar">Eliminar</button>` : ""}
    </div>`;
  autosize($("#eNombre"));
  $("#eNombre").addEventListener("input", (ev) => autosize(ev.target));
  $("#dClose").onclick = closeDrawer;
  const detalles = $("#eDetalles");
  if (!id) detalles.hidden = false;
  $("#eEditar").onclick = () => {
    detalles.hidden = !detalles.hidden;
    $("#eVista").hidden = !detalles.hidden || !detalles.value.trim();
    if (detalles.hidden) $("#eVista").innerHTML = md(detalles.value);
    $("#eEditar").textContent = detalles.hidden ? "Editar" : "Vista previa";
    if (!detalles.hidden) detalles.focus();
  };
  $("#eGuardar").onclick = async () => {
    try {
      const guardada = await api(`/api/projects/${pid}/entidades`, { id: id || undefined, categoria: $("#eCat").value, nombre: $("#eNombre").value, resumen: $("#eResumen").value, detalles: detalles.value, etiquetas: $("#eTags").value });
      toast(id ? `«${guardada.nombre}» guardada` : `«${guardada.nombre}» creada en ${guardada.categoria}`);
      if (!id) setTimeout(() => abrirEntidad(pid, guardada.id), 50); // ya puede llevar imagen
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#eBorrar")?.addEventListener("click", () => {
    if (!confirm(`¿Eliminar «${e.nombre}» de ${e.categoria}?`)) return;
    api(`/api/projects/${pid}/entidades/${id}`, undefined, "DELETE")
      .then(() => {
        toast(`«${e.nombre}» eliminada`);
        closeDrawer();
      })
      .catch((err) => toast(err.message, true));
  });
  $("#eQuitarFoto")?.addEventListener("click", () => api(`/api/projects/${pid}/entidades/${id}/imagen`, undefined, "DELETE").then(() => abrirEntidad(pid, id)).catch((err) => toast(err.message, true)));
  if (id) {
    const foto = $("#eFoto");
    const subirFoto = async (archivos) => {
      const f = [...archivos].find((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type));
      if (!f) return toast("La imagen tiene que ser PNG, JPG, GIF o WebP", true);
      await subir(`/api/projects/${pid}/entidades/${id}/imagen`, [f], () => "Imagen actualizada");
      abrirEntidad(pid, id);
    };
    $("#eFotoInput").onchange = (ev) => subirFoto(ev.target.files);
    foto.ondragover = (ev) => (ev.preventDefault(), foto.classList.add("over"));
    foto.ondragleave = () => foto.classList.remove("over");
    foto.ondrop = (ev) => {
      ev.preventDefault();
      foto.classList.remove("over");
      subirFoto(ev.dataTransfer.files);
    };
  }
  showDrawer();
  if (!id) $("#eNombre").focus();
}

// Conocimiento: archivos de referencia que la IA recibe
export function tamano(b) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}
export function paginaConocimiento(pagina) {
  const p = proyecto(state.filtro);
  if (!pagina.querySelector(".conocimiento")) {
    pagina.innerHTML = `<div class="conocimiento">
      <p class="intro">Archivos de referencia para la IA: guías, documentos, datos, imágenes. Los textos pequeños los recibe directamente; el resto los lee cuando los necesita.</p>
      <ul class="kn-list" data-kn></ul>
      <label class="kn-drop">⬆︎ Arrastra archivos aquí o <u>elige archivos</u> <small>(hasta 10 MB cada uno)</small><input type="file" multiple hidden data-subir></label>
    </div>`;
    pagina.querySelector("[data-subir]").onchange = (e) => subirConocimiento(p.id, e.target.files);
    const zona = pagina.querySelector(".kn-drop");
    zona.ondragover = (e) => (e.preventDefault(), zona.classList.add("over"));
    zona.ondragleave = () => zona.classList.remove("over");
    zona.ondrop = (e) => {
      e.preventDefault();
      zona.classList.remove("over");
      subirConocimiento(p.id, e.dataTransfer.files);
    };
  }
  const lista = pagina.querySelector("[data-kn]");
  lista.innerHTML =
    (p.knowledge || [])
      .map((k) => `<li><button class="file" data-f="${esc(k.path)}"><span class="ico">${fileIcon(k.name)}</span>${esc(k.name)}</button><span class="muted">${tamano(k.size)}</span><button class="icon-btn" data-quitar-kn="${esc(k.name)}" title="Quitar">✕</button></li>`)
      .join("") || `<li class="muted">Todavía no hay archivos de conocimiento.</li>`;
  for (const b of lista.querySelectorAll("[data-f]")) b.onclick = () => openFile(b.dataset.f);
  for (const b of lista.querySelectorAll("[data-quitar-kn]"))
    b.onclick = () => confirm(`¿Quitar «${b.dataset.quitarKn}» del conocimiento del proyecto?`) && api(`/api/projects/${p.id}/knowledge/${encodeURIComponent(b.dataset.quitarKn)}`, undefined, "DELETE").catch((err) => toast(err.message, true));
}

export function adjuntar(cardId, archivos) {
  return subir(`/api/cards/${cardId}/attachments`, archivos, (n) => `📎 «${n}» adjuntado`);
}
export function subirConocimiento(id, archivos) {
  return subir(`/api/projects/${id}/knowledge`, archivos, (n) => `«${n}» añadido al conocimiento`);
}

export async function subir(ruta, archivos, mensaje) {
  for (const f of archivos) {
    if (f.size > 10 * 1024 * 1024) {
      toast(`«${f.name}» pasa de 10 MB`, true);
      continue;
    }
    const data = await new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] || "");
      r.onerror = mal;
      r.readAsDataURL(f);
    });
    try {
      await api(ruta, { name: f.name, data });
      toast(mensaje(f.name));
    } catch (err) {
      toast(err.message, true);
    }
  }
}

// Entregables: lo que escribió la IA en la carpeta del proyecto
export function paginaEntregables(pagina) {
  const f = state.filtro;
  const p = proyecto(f);
  const archivos = archivosDe(f);
  const grupos = p ? [[p.folder, archivos]] : [...new Set(archivos.map((x) => (x.includes("/") ? x.split("/")[0] : "")))].map((d) => [d, archivos.filter((x) => (d ? x.startsWith(d + "/") : !x.includes("/")))]);
  pagina.innerHTML = `<p class="intro">${p ? `Lo que escribió la IA para este proyecto, en <code>${esc(p.dir)}/orbita/</code>.` : "Lo que escribió la IA en todos los proyectos."}</p>
    ${
      archivos.length
        ? grupos
            .map(([dir, lista]) => {
              const dueño = state.projects.find((x) => x.folder === dir);
              return `${p ? "" : `<h4 class="grupo">${dueño ? `<i class="tab-dot" style="--h:${tono(dueño.id)}"></i>${esc(dueño.name)}` : dir ? `<code>${esc(dir)}/</code>` : "Sueltos"}</h4>`}<div class="files">${lista.map((x) => `<button class="file" data-f="${esc(x)}"><span class="ico">${fileIcon(x)}</span>${esc(dir ? x.slice(dir.length + 1) : x)}</button>`).join("")}</div>`;
            })
            .join("")
        : `<div class="empty-state">Todavía no hay entregables.</div>`
    }`;
  for (const b of pagina.querySelectorAll("[data-f]")) b.onclick = () => openFile(b.dataset.f);
}

// Archivo: tarjetas archivadas del proyecto, con «Restaurar»
export function paginaArchivo(pagina) {
  const archivadas = [...state.cards.values()].filter((c) => c.archivedAt && deFiltro(state.filtro, c)).sort((a, b) => b.archivedAt - a.archivedAt);
  pagina.innerHTML = `<p class="intro">Las tarjetas archivadas no se borran: siguen aquí con su resultado y sus archivos.</p>
    ${
      archivadas.length
        ? `<ul class="archive-list">${archivadas
            .map((c) => `<li>${state.filtro === "todos" && proyecto(c.projectId) ? `<i class="tab-dot" style="--h:${tono(c.projectId)}" title="${esc(proyecto(c.projectId).name)}"></i>` : ""}<button class="link-card" data-open="${c.id}">${esc(c.title)}</button><time>${new Date(c.archivedAt).toLocaleDateString()}</time><button class="btn mini-btn" data-restore="${c.id}">Restaurar</button></li>`)
            .join("")}</ul><div class="actions"><button class="btn" id="restoreAll">Restaurar todas</button></div>`
        : '<div class="empty-state">No hay tarjetas archivadas.</div>'
    }`;
  for (const b of pagina.querySelectorAll("[data-restore]")) b.onclick = () => api(`/api/cards/${b.dataset.restore}/unarchive`, {}).then(() => toast("Restaurada en «Hecho»"));
  for (const b of pagina.querySelectorAll("[data-open]")) b.onclick = () => openDrawer(b.dataset.open);
  pagina.querySelector("#restoreAll")?.addEventListener("click", () => Promise.all(archivadas.map((c) => api(`/api/cards/${c.id}/unarchive`, {}))).then(() => toast("Todas restauradas")));
  // Papelera: lo que borró una IA (30 días)
  const papelera = (state.papelera || []).filter((x) => state.filtro === "todos" || (state.filtro === "sin" ? !x.projectId : x.projectId === state.filtro));
  if (papelera.length) {
    pagina.insertAdjacentHTML(
      "beforeend",
      `<h3 class="papelera-titulo">🗑 Papelera <small>lo que borró una IA · se vacía sola a los 30 días</small></h3>
      <ul class="archive-list papelera">${papelera
        .map((x) => `<li><span class="link-card">${esc(x.title)}</span><span class="muted papelera-por" title="${esc(x.motivo || "")}">${esc(x.por)}${x.motivo ? ` · ${esc(corto(x.motivo, 50))}` : ""}</span><time>${new Date(x.borradaEn).toLocaleDateString()}</time><button class="btn mini-btn" data-restaurar-p="${x.id}">Restaurar</button><button class="icon-btn" data-borrar-p="${x.id}" title="Borrar del todo" aria-label="Borrar del todo">✕</button></li>`)
        .join("")}</ul>`,
    );
    for (const b of pagina.querySelectorAll("[data-restaurar-p]")) b.onclick = () => restaurarPapelera(b.dataset.restaurarP);
    for (const b of pagina.querySelectorAll("[data-borrar-p]"))
      b.onclick = async () => {
        const x = state.papelera.find((y) => y.id === b.dataset.borrarP);
        if (!confirm(`¿Borrar del todo «${x?.title}»? No se podrá recuperar.`)) return;
        await api(`/api/papelera/${b.dataset.borrarP}`, undefined, "DELETE").catch((err) => toast(err.message, true));
      };
  }
}

export async function restaurarPapelera(id) {
  try {
    const card = await api(`/api/papelera/${id}/restaurar`, {});
    upsert(card);
    toast(`↶ «${corto(card.title, 50)}» restaurada`);
  } catch (err) {
    toast(err.message, true);
  }
}

export function renderCounts() {
  const cards = [...state.cards.values()].filter(visible);
  for (const col of document.querySelectorAll(".col")) {
    const n = cards.filter((c) => c.column === col.dataset.col).length;
    $(".count", col).textContent = n || "";
    col.classList.toggle("empty", n === 0);
  }
  const active = [...state.cards.values()].filter((c) => c.status === "running").length; // en todos los proyectos
  $("#statAgents").textContent = active;
  $("#agentDots").innerHTML = "<i></i>".repeat(Math.min(active, 4));
  const hechas = cards.filter((c) => c.column === "done").length;
  $("#archiveDone").hidden = hechas === 0;
  $("#archiveDone").textContent = `Archivar ${hechas}`;
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
  // Archivar lo hecho del proyecto visible (se puede deshacer)
  $("#archiveDone").onclick = async () => {
    const ids = [...state.cards.values()].filter((c) => visible(c) && c.column === "done").map((c) => c.id);
    try {
      const { archived } = await api("/api/archive", { ids });
      toast(`🗄 ${archived} tarjeta${archived === 1 ? "" : "s"} archivada${archived === 1 ? "" : "s"}`, false, {
        texto: "Deshacer",
        accion: () => Promise.all(ids.map((id) => api(`/api/cards/${id}/unarchive`, {}))),
      });
    } catch (err) {
      toast(err.message, true);
    }
  };
}
