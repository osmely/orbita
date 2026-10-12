// Utilidades de las pruebas de la interfaz: una Órbita aparte (carpetas temporales y un puerto libre, nunca los datos
// reales) y un Chrome sin ventana manejado por CDP, que apunta todo error de JavaScript de la página.
// Se ejecutan con «npm run test:interfaz». Si no hay Chrome, se saltan con un aviso (CHROME=<ruta> para indicar otro).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome --------------------------------------------------------------------------------

const CANDIDATOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const EN_EL_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
export function buscarChrome() {
  if (process.env.CHROME) return fs.existsSync(process.env.CHROME) ? process.env.CHROME : null;
  for (const c of CANDIDATOS) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || "").split(path.delimiter))
    for (const n of EN_EL_PATH) if (dir && fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}
export const CHROME = buscarChrome();
// Para describe(): sin Chrome, la prueba se salta con este motivo (node --test lo muestra)
export const SIN_CHROME = CHROME ? false : "No encuentro Chrome: instálalo o indica su ruta con CHROME=<ruta>";

// --- Órbita aparte -------------------------------------------------------------------------

function puertoLibre() {
  return new Promise((ok, mal) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
    s.on("error", mal);
  });
}

export async function arrancarOrbita() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-interfaz-"));
  const puerto = await puertoLibre();
  const B = `http://127.0.0.1:${puerto}`;
  const proceso = spawn(process.execPath, [path.join(RAIZ, "server.mjs"), "--data", path.join(tmp, "datos"), "--port", String(puerto), "--no-open"], {
    env: { ...process.env, ORBITA_PRUEBAS: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ok, mal) => {
    proceso.stdout.on("data", (d) => String(d).includes("está en") && ok());
    proceso.on("exit", (c) => mal(new Error(`Órbita terminó al arrancar (código ${c})`)));
  });
  const api = async (ruta, body, method = body ? "POST" : "GET") => {
    const r = await fetch(B + ruta, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const texto = await r.text();
    const datos = texto ? JSON.parse(texto) : null;
    if (!r.ok) throw new Error(`${method} ${ruta}: ${datos?.error || r.status}`);
    return datos;
  };
  const mcp = async (name, args) => {
    const r = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const { result } = await r.json();
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  };
  // Una carpeta de trabajo nueva para cada proyecto
  const carpeta = (nombre) => {
    const dir = path.join(tmp, "proyectos", nombre.replace(/[^\w-]+/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const proyecto = (name) => api("/api/projects", { name, dir: carpeta(name) });
  const tarjeta = async (id) => (await api("/api/board")).cards.find((c) => c.id === id);
  const parar = async () => {
    if (proceso.exitCode === null && proceso.signalCode === null) {
      const fin = new Promise((ok) => proceso.once("exit", ok));
      proceso.kill("SIGTERM");
      await Promise.race([fin, esperar(5000)]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { B, tmp, api, mcp, carpeta, proyecto, tarjeta, parar };
}

// --- Chrome por CDP ------------------------------------------------------------------------

export async function abrirNavegador({ ancho = 1400, alto = 900, movil = false } = {}) {
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-chrome-"));
  // Puerto 0: Chrome elige uno libre y lo escribe en DevToolsActivePort (así varias pruebas pueden ir a la vez)
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${perfil}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const activo = path.join(perfil, "DevToolsActivePort");
  let puerto;
  for (let i = 0; i < 100 && !puerto; i++) {
    await esperar(100);
    if (fs.existsSync(activo)) puerto = fs.readFileSync(activo, "utf8").split("\n")[0];
  }
  if (!puerto) throw new Error("Chrome no arrancó");
  let pagina;
  for (let i = 0; i < 50 && !pagina; i++) {
    pagina = (await fetch(`http://127.0.0.1:${puerto}/json`).then((r) => r.json()).catch(() => [])).find((t) => t.type === "page");
    if (!pagina) await esperar(100);
  }
  const ws = new WebSocket(pagina.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const pendientes = new Map();
  const errores = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description?.split("\n").slice(0, 2).join(" ") || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errores.push("console.error: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
    pendientes.get(m.id)?.(m);
    pendientes.delete(m.id);
  };
  // Cada orden a Chrome tiene un plazo: si no contesta, la prueba falla en vez de quedarse colgada
  const cdp = (method, params = {}) =>
    new Promise((r, mal) => {
      const id = ++n;
      const plazo = setTimeout(() => (pendientes.delete(id), mal(new Error(`Chrome no respondió a ${method}`))), 20_000);
      pendientes.set(id, (m) => (clearTimeout(plazo), r(m)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  // Evalúa en la página y devuelve el valor; si la expresión lanza, lanza aquí también
  const ev = async (expresion) => {
    const r = await cdp("Runtime.evaluate", { expression: expresion, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expresion.slice(0, 70)} → ${r.result.exceptionDetails.exception?.description?.split("\n")[0]}`);
    return r.result?.result?.value;
  };
  const CODIGOS = { Enter: 13, Escape: 27 };
  const tecla = async (key, modificadores = 0, code = key) => {
    for (const type of ["keyDown", "keyUp"])
      await cdp("Input.dispatchKeyEvent", { type, key, code, modifiers: modificadores, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : CODIGOS[key] || 0, ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) });
  };
  const escribir = (texto) => cdp("Input.insertText", { text: texto });
  const tamano = (w, h, esMovil = false) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: esMovil ? 2 : 1, mobile: esMovil });
  const ir = async (url, ms = 2000) => {
    await cdp("Page.navigate", { url });
    await esperar(ms);
  };
  const captura = async (archivo) => fs.writeFileSync(archivo, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  const cerrar = async () => {
    ws.close();
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const fin = new Promise((ok) => chrome.once("exit", ok));
      chrome.kill();
      await Promise.race([fin, esperar(5000)]);
    }
    fs.rmSync(perfil, { recursive: true, force: true });
  };
  await cdp("Runtime.enable");
  await tamano(ancho, alto, movil);
  return { cdp, ev, tecla, escribir, tamano, ir, captura, cerrar, errores };
}

export const META = process.platform === "darwin" ? 4 : 2; // ⌘ en Mac, Ctrl en el resto (para ⌘K)
