// ¿Hay ya una Órbita abierta en este puerto? Se mira ANTES de cargar el tablero (server.mjs importa este módulo
// antes que estado.mjs): si la nueva cargase primero, se quedaría con una copia anterior a lo último que guardó la otra.
// - Misma versión: basta con abrir su ventana; esta termina.
// - Versión anterior (la abriste antes de actualizar y solo cerraste su ventana): se le pide que se cierre
//   (guarda todo antes) y, cuando el puerto queda libre, esta sigue arrancando con el tablero ya guardado.
import { ABRIR_NAVEGADOR, PORT, VERSION, abrirVentana } from "./entorno.mjs";

const B = `http://127.0.0.1:${PORT}`;
const pedir = (ruta, opciones = {}, ms = 2000) =>
  fetch(B + ruta, { ...opciones, signal: AbortSignal.timeout(ms) })
    .then((r) => r.json())
    .catch(() => null);

// Si al final arranca esta, ¿abre ventana? No si la de la versión anterior tenía una: esa se recarga sola
export let abrirAlArrancar = ABRIR_NAVEGADOR;

const otra = await pedir("/api/board");
if (otra?.version === VERSION) {
  console.log(`\n  ◉ Órbita ya está abierta en http://localhost:${PORT}\n`);
  if (ABRIR_NAVEGADOR) abrirVentana(`http://localhost:${PORT}`);
  process.exit(0);
}
if (otra?.version) {
  console.log(`\n  ◉ Había una Órbita de una versión anterior abierta: la cierro y abro la nueva…`);
  const r = await pedir("/api/salir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actualizar: true }) }, 3000);
  if (r?.ventanas) abrirAlArrancar = false;
  // Espera a que se cierre del todo (ha guardado al recibir la petición)
  for (let i = 0; i < 60 && (await pedir("/api/board", {}, 500)); i++) await new Promise((ok) => setTimeout(ok, 100));
}
