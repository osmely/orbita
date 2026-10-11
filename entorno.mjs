// Dónde y cómo se ejecuta Órbita en la máquina de cada persona: argumentos, carpeta de datos,
// la interfaz (public/) y abrir el navegador.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import paquete from "./package.json" with { type: "json" };

export const NOMBRE = "Órbita";
export const VERSION_APP = paquete.version;

// --- Argumentos -------------------------------------------------------------------------

const AYUDA = `${NOMBRE} ${VERSION_APP}: tu tablero kanban que trabaja con tu propia IA (por MCP)

Uso: orbita [opciones]

  --port <n>      Puerto local (por defecto 4321, o el último que usaste)
  --data <dir>    Carpeta de datos de Órbita (la lista de proyectos; cada
                  proyecto se guarda en su carpeta de trabajo, en orbita/)
  --no-open       No abrir la ventana de Órbita al arrancar
  --tab           Abrir Órbita en una pestaña del navegador, no en su propia ventana
  --version       Muestra la versión
  --help          Muestra esta ayuda

Variables de entorno equivalentes: PORT, ORBITA_DATA, ORBITA_NO_OPEN=1, ORBITA_TAB=1
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
    else if (a === "--tab") opciones.pestana = true;
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

// Clave de la vista previa (/vista/<clave>/…): solo la conoce el tablero, así que una web ajena no puede cargar
// los entregables con <script src> o <img>. Se guarda para que los enlaces «Pestaña nueva» sigan valiendo al reiniciar.
export const CLAVE_VISTA = /^[0-9a-f]{32}$/.test(config.claveVista || "") ? config.claveVista : crypto.randomBytes(16).toString("hex");
if (config.claveVista !== CLAVE_VISTA) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...leerConfig(), claveVista: CLAVE_VISTA }, null, 2));
  } catch {}
}

export const ABRIR_NAVEGADOR = !args.noAbrir && !process.env.ORBITA_NO_OPEN && !process.env.ORBITA_PRUEBAS;
const EN_PESTANA = args.pestana || !!process.env.ORBITA_TAB;

// --- La interfaz (public/) --------------------------------------------------------------

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// Lee un archivo de la interfaz (de public/). Devuelve null si no existe.
export function leerPublico(rel) {
  const limpio = path.posix.normalize("/" + String(rel).replaceAll("\\", "/")).slice(1);
  if (!limpio || limpio.startsWith("..")) return null;
  try {
    return fs.readFileSync(path.join(PUBLIC, limpio));
  } catch {
    return null;
  }
}

// Los archivos de la interfaz que cuentan para su versión (si cambian al reiniciar, las páginas abiertas se recargan)
export function archivosDeLaInterfaz() {
  const base = ["index.html", "styles.css"];
  try {
    return [...base, ...fs.readdirSync(path.join(PUBLIC, "js")).filter((f) => f.endsWith(".js")).sort().map((f) => `js/${f}`)];
  } catch {
    return base;
  }
}

// Versión de la interfaz: si cambia al reiniciar, las páginas abiertas se recargan solas
export const VERSION = crypto
  .createHash("sha1")
  .update([VERSION_APP, ...archivosDeLaInterfaz().map((f) => leerPublico(f)?.toString("utf8") ?? "")].join("\n"))
  .digest("hex")
  .slice(0, 10);

// La vista previa aislada de los entregables: /vista/<clave>/…
export const VISTA = `/vista/${CLAVE_VISTA}/`;

// --- Navegador ---------------------------------------------------------------------------

// La ventana de Órbita. Con un navegador Chromium (Chrome, Edge, Brave, Chromium) se abre en «modo app»: una
// ventana propia, sin pestañas ni barra de direcciones, que se ve como una aplicación. Si no hay ninguno
// (o con --tab), en una pestaña del navegador de siempre.
export function abrirVentana(url) {
  const chromium = EN_PESTANA ? null : buscarChromium();
  if (!chromium) return abrirNavegador(url);
  const argumentos = [`--app=${url}`, "--window-size=1360,880"];
  // En macOS, «open -n» le pasa los argumentos aunque el navegador ya esté abierto
  const [cmd, todos] = process.platform === "darwin" ? ["open", ["-na", chromium, "--args", ...argumentos]] : [chromium, argumentos];
  try {
    const hijo = spawn(cmd, todos, { stdio: "ignore", detached: true, windowsHide: true });
    hijo.on("error", () => abrirNavegador(url));
    hijo.unref();
  } catch {
    abrirNavegador(url);
  }
}

function buscarChromium() {
  const existe = (f) => {
    try {
      return fs.statSync(f) && f;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi"];
    for (const carpeta of ["/Applications", path.join(os.homedir(), "Applications")]) for (const app of apps) if (existe(path.join(carpeta, `${app}.app`))) return path.join(carpeta, `${app}.app`);
    return null;
  }
  if (process.platform === "win32") {
    const raices = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const rutas = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    for (const ruta of rutas) for (const raiz of raices) if (existe(path.join(raiz, ruta))) return path.join(raiz, ruta);
    return null;
  }
  const nombres = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) for (const n of nombres) if (dir && existe(path.join(dir, n))) return path.join(dir, n);
  return null;
}

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
