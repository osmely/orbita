// Construye Órbita como un único ejecutable (Node SEA) para el sistema en el que se ejecuta:
// el usuario no necesita instalar Node. La interfaz (public/) va dentro del binario.
// Uso: npm run build  →  dist/orbita (o dist/orbita.exe en Windows)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(RAIZ, "dist");
const OBRA = path.join(DIST, "obra"); // intermedios
const WIN = process.platform === "win32";
const SALIDA = path.join(DIST, WIN ? "orbita.exe" : "orbita");
const paso = (texto) => console.log(`▸ ${texto}`);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(OBRA, { recursive: true });

// 1. Las fuentes y librerías de la interfaz, al día
paso("Copiando fuentes y librerías de la interfaz");
execFileSync(process.execPath, [path.join(RAIZ, "scripts", "vendor.mjs")], { stdio: "inherit" });

// 2. Todo el servidor (con sus dependencias) en un solo archivo CommonJS, que es lo que ejecuta Node SEA
paso("Empaquetando el servidor");
const MAIN = path.join(OBRA, "orbita.cjs");
await esbuild.build({
  entryPoints: [path.join(RAIZ, "server.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: MAIN,
  minify: true,
  legalComments: "eof", // los avisos de licencia de las dependencias quedan dentro
  define: { "import.meta.url": "__orbitaUrl" },
  banner: { js: 'const __orbitaUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

// 3. La interfaz como recursos del ejecutable
const PUBLIC = path.join(RAIZ, "public");
const recursos = {};
for (const archivo of fs.readdirSync(PUBLIC, { recursive: true })) {
  const completo = path.join(PUBLIC, archivo);
  if (fs.statSync(completo).isFile() && !archivo.endsWith(".DS_Store")) recursos[`public/${archivo.split(path.sep).join("/")}`] = completo;
}
paso(`${Object.keys(recursos).length} archivos de interfaz dentro del ejecutable`);

// 4. El ejecutable: una copia de Node oficial con el servidor y la interfaz dentro.
// El Node de Homebrew (y otros de distribuciones) viene sin soporte para ejecutables, así que se usa el de nodejs.org.
const NODE = process.env.ORBITA_NODE || (await nodeOficial(process.version));
paso(`Creando ${path.relative(RAIZ, SALIDA)} con Node ${process.version} (${process.platform}-${process.arch})`);
const CONFIG = path.join(OBRA, "sea-config.json");
fs.writeFileSync(CONFIG, JSON.stringify({ main: MAIN, output: SALIDA, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets: recursos }, null, 2));
execFileSync(NODE, ["--build-sea", CONFIG], { stdio: "inherit" });

// 5. macOS no ejecuta binarios modificados sin firma: firma local (ad hoc).
// Para repartirlo sin avisos de Gatekeeper hace falta firmar con un Developer ID y notarizar (ver DISTRIBUCION.md).
if (process.platform === "darwin") {
  paso("Firmando (ad hoc)");
  execFileSync("codesign", ["--force", "--sign", "-", SALIDA], { stdio: "inherit" });
  crearAppMac();
}

fs.rmSync(OBRA, { recursive: true, force: true });
const mb = (fs.statSync(SALIDA).size / 1048576).toFixed(0);
console.log(`\n✓ ${path.relative(RAIZ, SALIDA)} (${mb} MB). Pruébalo con: ${path.relative(process.cwd(), SALIDA) || SALIDA} --data /tmp/orbita-prueba`);
if (process.platform === "darwin") console.log(`✓ dist/Órbita.app: ábrela con doble clic (o arrástrala a Aplicaciones)`);

// Órbita.app: el mismo ejecutable dentro de una app de macOS, con su icono. Se abre con doble clic, sin ventana
// de Terminal (LSUIElement: el servidor no tiene ventana propia; la de Órbita la abre el navegador en modo app).
// Abrirla otra vez con Órbita ya en marcha solo vuelve a mostrar su ventana.
function crearAppMac() {
  const APP = path.join(DIST, "Órbita.app");
  paso(`Creando ${path.relative(RAIZ, APP)}`);
  fs.mkdirSync(path.join(APP, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(APP, "Contents", "Resources"), { recursive: true });
  fs.copyFileSync(SALIDA, path.join(APP, "Contents", "MacOS", "orbita"));
  fs.copyFileSync(path.join(RAIZ, "recursos", "orbita.icns"), path.join(APP, "Contents", "Resources", "orbita.icns"));
  const version = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;
  const plist = {
    CFBundleName: "Órbita",
    CFBundleDisplayName: "Órbita",
    CFBundleIdentifier: "app.orbita.tablero",
    CFBundleExecutable: "orbita",
    CFBundleIconFile: "orbita",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: "11.0",
    LSUIElement: true,
    NSHighResolutionCapable: true,
  };
  const valor = (v) => (v === true ? "<true/>" : `<string>${v}</string>`);
  fs.writeFileSync(
    path.join(APP, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${Object.entries(plist)
      .map(([k, v]) => `  <key>${k}</key>\n  ${valor(v)}`)
      .join("\n")}\n</dict>\n</plist>\n`,
  );
  execFileSync("codesign", ["--force", "--sign", "-", APP], { stdio: "inherit" });
}

// Descarga (una vez) el Node oficial de nodejs.org y comprueba su SHA-256 con la lista oficial de la versión.
async function nodeOficial(version) {
  const plataforma = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
  const nombre = `node-${version}-${plataforma}-${process.arch}`;
  const cache = path.join(os.homedir(), ".cache", "orbita-build", nombre);
  const binario = WIN ? path.join(cache, "node.exe") : path.join(cache, "bin", "node");
  if (fs.existsSync(binario)) return binario;

  const archivo = WIN ? `${nombre}.zip` : `${nombre}.tar.gz`;
  const base = `https://nodejs.org/dist/${version}`;
  paso(`Descargando ${archivo} de nodejs.org (solo la primera vez)`);
  const sumas = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const esperado = sumas.split("\n").find((l) => l.endsWith(`  ${archivo}`))?.split(" ")[0];
  if (!esperado) throw new Error(`nodejs.org no publica ${archivo}`);
  const respuesta = await fetch(`${base}/${archivo}`);
  if (!respuesta.ok) throw new Error(`No se pudo descargar ${archivo}: ${respuesta.status}`);
  const datos = Buffer.from(await respuesta.arrayBuffer());
  const real = crypto.createHash("sha256").update(datos).digest("hex");
  if (real !== esperado) throw new Error(`La suma SHA-256 de ${archivo} no coincide con la oficial: no se usa`);

  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const comprimido = path.join(path.dirname(cache), archivo);
  fs.writeFileSync(comprimido, datos);
  execFileSync("tar", ["-xf", comprimido, "-C", path.dirname(cache)]); // tar también abre .zip en Windows 10+
  fs.rmSync(comprimido);
  return binario;
}
