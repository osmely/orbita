// Dónde y cómo se ejecuta Órbita en la máquina de cada persona: argumentos, carpeta de datos,
// la interfaz (en disco o dentro del ejecutable) y abrir el navegador.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import paquete from "./package.json" with { type: "json" };

export const NOMBRE = "Órbita";
export const VERSION_APP = paquete.version;

// ¿Corre como ejecutable (Node SEA)? Entonces la interfaz va dentro del propio binario.
const sea = (() => {
  try {
    const s = createRequire(import.meta.url)("node:sea");
    return s.isSea() ? s : null;
  } catch {
    return null;
  }
})();
export const ES_EJECUTABLE = Boolean(sea);

// --- Argumentos -------------------------------------------------------------------------

const AYUDA = `${NOMBRE} ${VERSION_APP}: tu tablero kanban que trabaja con tu propia IA (por MCP)

Uso: orbita [opciones]

  --port <n>      Puerto local (por defecto 4321, o el último que usaste)
  --data <dir>    Carpeta de datos de Órbita (la lista de proyectos; cada
                  proyecto se guarda en su carpeta de trabajo, en orbita/)
  --no-open       No abrir el navegador al arrancar
  --version       Muestra la versión
  --help          Muestra esta ayuda

Variables de entorno equivalentes: PORT, ORBITA_DATA, ORBITA_NO_OPEN=1
Todo se queda en tu máquina: el servidor solo escucha en 127.0.0.1.`;

function leerArgumentos(argv) {
  const opciones = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valor = () => {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (v == null || v.startsWith("--")) salir(`Falta el valor de ${a.split("=")[0]}`);
      return v;
    };
    if (a === "--help" || a === "-h") salir(AYUDA, 0);
    else if (a === "--version" || a === "-v") salir(VERSION_APP, 0);
    else if (a === "--no-open") opciones.noAbrir = true;
    else if (a.startsWith("--port")) opciones.puerto = valor();
    else if (a.startsWith("--data")) opciones.datos = valor();
    else salir(`Opción desconocida: ${a}\n\n${AYUDA}`);
  }
  return opciones;
}

export function salir(mensaje, codigo = 1) {
  (codigo ? console.error : console.log)(mensaje);
  process.exit(codigo);
}

// --- Carpeta de datos --------------------------------------------------------------------

// La carpeta de datos habitual de cada sistema. Nunca junto al programa: al actualizarlo, se sustituye.
function carpetaPorDefecto() {
  const casa = os.homedir();
  if (process.platform === "darwin") return path.join(casa, "Library", "Application Support", "Orbita");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(casa, "AppData", "Roaming"), "Orbita");
  return path.join(process.env.XDG_DATA_HOME || path.join(casa, ".local", "share"), "orbita");
}

const args = leerArgumentos(process.argv.slice(2));
export const DATOS = path.resolve(args.datos || process.env.ORBITA_DATA || carpetaPorDefecto());
// Aquí solo va orbita.json (la lista de proyectos y lo global) y config.json:
// cada proyecto se guarda en su propia carpeta de trabajo (ver almacen.mjs)
const CONFIG_FILE = path.join(DATOS, "config.json");

try {
  fs.mkdirSync(DATOS, { recursive: true });
} catch (err) {
  salir(`No se puede usar la carpeta de datos ${DATOS}: ${err.message}`);
}

// Ajustes que se recuerdan entre arranques (sobre todo el puerto: la configuración MCP de la IA lo lleva escrito)
function leerConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
const config = leerConfig();

const puertoPedido = args.puerto ?? process.env.PORT;
export const PORT = Number(puertoPedido ?? config.port ?? 4321);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) salir(`Puerto no válido: ${puertoPedido}`);
if (config.port !== PORT) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, port: PORT }, null, 2));
  } catch {}
}

export const ABRIR_NAVEGADOR = !args.noAbrir && !process.env.ORBITA_NO_OPEN && !process.env.ORBITA_PRUEBAS;

// --- La interfaz (public/) --------------------------------------------------------------

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// Lee un archivo de la interfaz: del ejecutable si lo es, si no de public/. Devuelve null si no existe.
export function leerPublico(rel) {
  const limpio = path.posix.normalize("/" + String(rel).replaceAll("\\", "/")).slice(1);
  if (!limpio || limpio.startsWith("..")) return null;
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(`public/${limpio}`));
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(path.join(PUBLIC, limpio));
  } catch {
    return null;
  }
}

// --- Navegador ---------------------------------------------------------------------------

export function abrirNavegador(url) {
  const [cmd, argumentos] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const hijo = spawn(cmd, argumentos, { stdio: "ignore", detached: true, windowsHide: true });
    hijo.on("error", () => console.log(`  Abre ${url} en tu navegador.`));
    hijo.unref();
  } catch {
    console.log(`  Abre ${url} en tu navegador.`);
  }
}
