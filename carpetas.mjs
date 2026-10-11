// Selector de carpetas del sistema, para elegir la carpeta de trabajo de un proyecto.
// El navegador no puede dar rutas completas de carpetas, pero el servidor corre en la máquina
// de la persona: abre el diálogo nativo (Finder, Explorador de Windows, zenity/kdialog en Linux).
import { execFile } from "node:child_process";

const ejecutar = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: false }, (err, stdout) => {
      if (err) return resolve({ error: err });
      resolve({ salida: String(stdout).trim() });
    });
  });

// Devuelve { dir } con la carpeta elegida, { dir: null } si se canceló, o { dir: null, sinSelector: true }
// si este sistema no tiene un selector disponible (la interfaz pide entonces la ruta escrita).
export async function elegirCarpeta(titulo) {
  const texto = String(titulo).replace(/["\\]/g, "");
  if (process.platform === "darwin") {
    // «activate» trae el diálogo al frente, por encima del navegador
    const r = await ejecutar("osascript", ["-e", "activate", "-e", `POSIX path of (choose folder with prompt "${texto}")`]);
    if (r.error) return { dir: null, sinSelector: r.error.code === "ENOENT" }; // si no, se canceló
    return { dir: r.salida.replace(/\/$/, "") || null };
  }
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$f.Description = '${texto.replace(/'/g, "''")}'`,
      "$f.ShowNewFolderButton = $true",
      "$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
      "if ($f.ShowDialog($top) -eq 'OK') { $f.SelectedPath }",
    ].join("; ");
    const r = await ejecutar("powershell", ["-NoProfile", "-STA", "-Command", ps]);
    if (r.error) return { dir: null, sinSelector: true };
    return { dir: r.salida || null };
  }
  for (const [cmd, args] of [
    ["zenity", ["--file-selection", "--directory", `--title=${texto}`]],
    ["kdialog", ["--getexistingdirectory", process.env.HOME || "/", "--title", texto]],
  ]) {
    const r = await ejecutar(cmd, args);
    if (r.error?.code === "ENOENT") continue; // no está instalado: probar el siguiente
    return { dir: r.error ? null : r.salida || null };
  }
  return { dir: null, sinSelector: true };
}
