// Órbita · Exportar resultados, visor de imágenes y play / pausa por proyecto.
// Parte de la interfaz (ver main.js): exporta lo que declara e importa lo que usa de los demás módulos.
import { $, api, esc, md, proyecto, state, toast } from "./nucleo.js";
import { renderAll } from "./tablero.js";
import { sinTildes } from "./busqueda.js";

// ---------------------------------------------------------------------------
// Copiar, descargar .md, abrir como página y PDF (de la versión que se está viendo)
// ---------------------------------------------------------------------------

// Los criterios de la versión que se exporta (o los actuales), como lista de comprobación
export function criteriosMd(c, v) {
  const cr = v.criterios || (v.n == null || v.n === c.versions?.at(-1)?.n ? c.criterios : null) || [];
  if (!cr.length) return "";
  return `**Terminado cuando…** (${cr.filter((x) => x.estado === "cumple").length}/${cr.length} ✓)\n\n${cr.map((x) => `- ${x.estado === "cumple" ? "✅" : x.estado === "no" ? "❌" : "⬜"} ${x.texto}${x.evidencia ? ` — ${x.evidencia.replace(/\n+/g, " ")}` : ""}`).join("\n")}\n\n---\n\n`;
}

export function versionVista(c) {
  const vs = c.versions || [];
  const i = state.verVersion == null ? vs.length - 1 : Math.min(state.verVersion, vs.length - 1);
  return i >= 0 ? vs[i] : { n: null, result: c.result, t: c.updatedAt, quien: c.worker };
}
export function nombreArchivo(t) {
  return sinTildes(t).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "resultado";
}
export function fechaLarga(t) {
  return new Date(t).toLocaleString([], { dateStyle: "long", timeStyle: "short" });
}

// Las imágenes de Órbita (/files/…) se meten dentro del .md como datos, para que se vean en cualquier sitio
export async function incrustarImagenes(markdown) {
  const rutas = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\((\/files\/[^)\s]+)\)/g)].map((m) => m[1]))];
  for (const ruta of rutas) {
    try {
      const blob = await (await fetch(ruta)).blob();
      const datos = await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.readAsDataURL(blob);
      });
      markdown = markdown.split(`(${ruta})`).join(`(${datos})`);
    } catch {}
  }
  return markdown;
}

export function paginaHTML(c, v) {
  const p = proyecto(c.projectId);
  const cuerpo = md(criteriosMd(c, v) + v.result).replace(/(src|href)="\/files\//g, `$1="${location.origin}/files/`); // rutas completas: la página vive fuera de Órbita
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>
  body { margin: 0; background: #f6f6f9; color: #1d1d27; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 64px; background: #fff; min-height: 100vh; box-sizing: border-box; }
  header { border-bottom: 1px solid #e6e6ee; padding-bottom: 18px; margin-bottom: 26px; }
  header h1 { font-size: 28px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -.01em; }
  .meta { color: #6b6b80; font-size: 13.5px; }
  h1, h2, h3 { line-height: 1.3; } h2 { font-size: 21px; margin-top: 30px; } h3 { font-size: 17px; }
  a { color: #5b4bdb; } img { max-width: 100%; height: auto; border-radius: 10px; border: 1px solid #e6e6ee; }
  pre { background: #f3f3f8; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 13.5px; }
  code { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; } th, td { border: 1px solid #dcdce6; padding: 7px 10px; text-align: left; } th { background: #f3f3f8; }
  blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid #c4b5fd; color: #4b4b5c; }
  footer { margin-top: 40px; color: #9a9aac; font-size: 12px; }
  @media print { body { background: #fff; } main { padding: 0; min-height: 0; } a { color: inherit; } }
</style></head><body><main>
<header><h1>${esc(c.title)}</h1><div class="meta">${p ? `${esc(p.name)} · ` : ""}${v.n ? `Versión ${v.n} · ` : ""}${esc(v.quien || "")}${v.quien ? " · " : ""}${fechaLarga(v.t || Date.now())}</div></header>
${cuerpo}
<footer>Exportado desde Órbita</footer>
</main></body></html>`;
}

export async function exportar(id, como) {
  const c = state.cards.get(id);
  if (!c) return;
  const v = versionVista(c);
  try {
    if (como === "copiar") {
      await navigator.clipboard.writeText(v.result);
      return toast(`Resultado${v.n ? ` (versión ${v.n})` : ""} copiado en Markdown ✓`);
    }
    if (como === "md") {
      const texto = `# ${c.title}\n\n_${v.n ? `Versión ${v.n} · ` : ""}${fechaLarga(v.t || Date.now())}_\n\n${criteriosMd(c, v)}${await incrustarImagenes(v.result)}\n`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([texto], { type: "text/markdown;charset=utf-8" }));
      a.download = `${nombreArchivo(c.title)}${v.n ? `-v${v.n}` : ""}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return toast(`Descargado ${a.download}`);
    }
    // Página (y PDF: la misma página, con el diálogo de imprimir para «Guardar como PDF»)
    const url = URL.createObjectURL(new Blob([paginaHTML(c, v)], { type: "text/html;charset=utf-8" }));
    const w = window.open(url, "_blank");
    if (!w) toast("El navegador bloqueó la ventana nueva: permite las ventanas emergentes de Órbita", true);
    else if (como === "pdf") {
      // Se imprime desde aquí: la página hereda la política de seguridad de Órbita, que no deja ejecutar scripts dentro de ella
      w.addEventListener("load", () => setTimeout(() => w.print(), 400));
      toast("En el diálogo de imprimir, elige «Guardar como PDF»");
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (err) {
    toast(err.message || "No se pudo exportar", true);
  }
}


// ---------------------------------------------------------------------------
// Visor de imágenes: tocar una imagen la amplía, con copiar, descargar y ← →
// ---------------------------------------------------------------------------

export const visor = { lista: [], i: 0 };
export const ZONAS_IMG = ".result, .file-view, .msg .txt, #page";

export function abrirVisor(img) {
  const zona = img.closest(".d-section, #page") || document.body;
  visor.lista = [...zona.querySelectorAll("img")].filter((x) => x.closest(ZONAS_IMG) && !x.closest("button, a.btn"));
  visor.i = Math.max(0, visor.lista.indexOf(img));
  $("#visor").hidden = false;
  pintarVisor();
}
export function pintarVisor() {
  const img = visor.lista[visor.i];
  if (!img) return cerrarVisor();
  const url = img.currentSrc || img.src;
  const nombre = img.alt || decodeURIComponent(url.split("/").pop().split("?")[0]) || "imagen";
  $("#visorImg").style.width = $("#visorImg").style.height = "";
  $("#visorImg").src = url;
  $("#visorImg").alt = nombre;
  $("#visorLienzo").classList.remove("real");
  $("#visorNombre").textContent = nombre;
  const varias = visor.lista.length > 1;
  $("#visorCuenta").textContent = varias ? `${visor.i + 1} de ${visor.lista.length}` : "";
  $("#visorAnt").hidden = $("#visorSig").hidden = !varias;
  $("#visorAnt").disabled = visor.i === 0;
  $("#visorSig").disabled = visor.i === visor.lista.length - 1;
  $("#visorBajar").href = url;
  $("#visorBajar").download = /^data:/.test(url) ? "imagen.png" : decodeURIComponent(url.split("/").pop().split("?")[0]);
  $("#visorOriginal").href = url;
}
export function cerrarVisor() {
  $("#visor").hidden = true;
  $("#visorImg").removeAttribute("src");
}
export function pasarVisor(paso) {
  const j = visor.i + paso;
  if (j >= 0 && j < visor.lista.length) (visor.i = j), pintarVisor();
}

// El portapapeles solo acepta PNG: las demás se convierten
export async function comoPNG(url) {
  const blob = await (await fetch(url)).blob();
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const lienzo = document.createElement("canvas");
  lienzo.width = bmp.width;
  lienzo.height = bmp.height;
  lienzo.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo convertir la imagen"))), "image/png"));
}
export async function copiarImagen() {
  const url = $("#visorImg").src;
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("sin soporte");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": comoPNG(url) })]); // la promesa directa: así funciona también en Safari
    toast("Imagen copiada ✓ Pégala donde quieras");
  } catch {
    try {
      await navigator.clipboard.writeText(new URL(url, location.href).href);
      toast("Este navegador no deja copiar imágenes: copié el enlace", true);
    } catch {
      toast("No se pudo copiar la imagen. Usa «Descargar»", true);
    }
  }
}







// Ajustada: lo más grande que quepa en la pantalla (también agranda las pequeñas, hasta 3×)
export function ajustarVisor() {
  const img = $("#visorImg");
  const lienzo = $("#visorLienzo");
  if (!img.naturalWidth) return;
  if (lienzo.classList.contains("real")) return (img.style.width = img.style.height = "");
  const cs = getComputedStyle(lienzo);
  const anchoLibre = lienzo.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const altoLibre = lienzo.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const escala = Math.min(anchoLibre / img.naturalWidth, altoLibre / img.naturalHeight, 3);
  img.style.width = Math.floor(img.naturalWidth * escala) + "px";
  img.style.height = Math.floor(img.naturalHeight * escala) + "px";
}




// ---------------------------------------------------------------------------
// Play / pausa por proyecto
// ---------------------------------------------------------------------------

export async function pausarProyecto(id, si, silencioso = false) {
  const p = proyecto(id);
  if (!p) return;
  try {
    const nuevo = await api(`/api/projects/${id}/pausa`, { pausado: si });
    state.projects = state.projects.map((x) => (x.id === id ? { ...x, ...nuevo } : x)); // sin esperar al aviso del servidor
    renderAll();
    if (!silencioso)
      toast(si ? `⏸ «${p.name}» en pausa: la IA termina lo que tiene y no toma más` : `▶ «${p.name}» reanudado`, false, { texto: "Deshacer", accion: () => pausarProyecto(id, !si, true) });
  } catch (err) {
    toast(err.message, true);
  }
}
export async function reanudarTodos() {
  const pausados = state.projects.filter((x) => x.pausado).map((x) => x.id);
  for (const o of pausados) await pausarProyecto(o, false, true);
  toast(`▶ ${pausados.length} proyecto${pausados.length === 1 ? "" : "s"} reanudado${pausados.length === 1 ? "" : "s"}`);
}

// Lo que se prepara al cargar la página (main.js lo llama en orden)
export function iniciarModulo() {
  document.addEventListener("click", (e) => {
    const img = e.target.closest?.("img");
    if (!img || !$("#visor").hidden || img.closest("#visor, button, a.btn") || !img.closest(ZONAS_IMG)) return;
    e.preventDefault(); // dentro de un enlace, ampliar en vez de navegar
    abrirVisor(img);
  });
  $("#visorCerrar").onclick = cerrarVisor;
  $("#visorCopiar").onclick = copiarImagen;
  $("#visorAnt").onclick = () => pasarVisor(-1);
  $("#visorSig").onclick = () => pasarVisor(+1);
  $("#visorImg").onclick = (e) => {
    e.stopPropagation();
    $("#visorLienzo").classList.toggle("real"); // tamaño real ↔ ajustada a la pantalla
    ajustarVisor();
  };
  $("#visorImg").onload = ajustarVisor;
  addEventListener("resize", () => !$("#visor").hidden && ajustarVisor());
  $("#visor").onclick = (e) => {
    if (e.target === $("#visor") || e.target === $("#visorLienzo")) cerrarVisor(); // sin devolver false: los enlaces (Descargar, Original) deben funcionar
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if ($("#visor").hidden) return;
      const k = { Escape: cerrarVisor, ArrowLeft: () => pasarVisor(-1), ArrowRight: () => pasarVisor(+1), c: copiarImagen, C: copiarImagen }[e.key];
      if (!k || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation(); // que Esc no cierre también la tarjeta de debajo
      k();
    },
    true,
  );
}
