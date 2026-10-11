# Publicar Órbita

Órbita se publica en una web, pero cada persona la **descarga y la ejecuta en su máquina**. Su servidor solo escucha en `127.0.0.1` y la IA de esa persona se conecta por MCP a `http://localhost:4321/mcp`. No hay servidor central, cuentas ni API keys.

## Qué se reparte

Un único ejecutable por sistema (Node SEA): Node, el servidor, el MCP y la interfaz van dentro. El usuario no necesita instalar Node.

| Archivo | Sistema |
|---|---|
| `orbita-macos-arm64.zip` | Mac con Apple Silicon (`Órbita.app`) |
| `orbita-macos-x64.zip` | Mac con Intel (`Órbita.app`) |
| `orbita-windows-x64.zip` | Windows 10/11 |
| `orbita-linux-x64.zip` | Linux |

## Construir

```bash
npm run build
```

Crea `dist/orbita` para el sistema en el que lo ejecutas (en macOS, también `dist/Órbita.app`, con el icono de `recursos/orbita.icns`, que sale de `recursos/icono.svg`) (unos 140 MB; comprimido, menos de la mitad). La primera vez descarga el Node oficial de nodejs.org, comprueba su SHA-256 y lo guarda en `~/.cache/orbita-build`: el Node de Homebrew no sirve porque viene sin soporte para ejecutables. Con `ORBITA_NODE=/ruta/a/node` se usa otro Node oficial.

Para los cuatro sistemas a la vez está el flujo de GitHub Actions `.github/workflows/release.yml`. Al subir una etiqueta (`git tag v1.0.0 && git push --tags`), construye los cuatro y los adjunta a una release de GitHub. La web puede enlazar a la última release: `https://github.com/<usuario>/<repo>/releases/latest`.

La versión sale de `package.json`: súbela antes de etiquetar.

## Firmar (pendiente)

Sin firmar, los sistemas avisan al abrir un programa descargado:

- **macOS**: Gatekeeper lo bloquea («no se puede verificar el desarrollador»). Ahora el ejecutable lleva una firma *ad hoc*, que basta para tu Mac pero no para repartirlo. Hace falta una cuenta de Apple Developer (99 $/año) para firmar con un *Developer ID Application* y notarizar:
  ```bash
  codesign --force --options runtime --entitlements entitlements.plist --sign "Developer ID Application: Tu Nombre (TEAMID)" dist/orbita
  ```
  ```bash
  ditto -c -k dist/orbita orbita.zip && xcrun notarytool submit orbita.zip --apple-id … --team-id … --password … --wait
  ```
  Con el *hardened runtime*, Node (y por tanto el ejecutable) suele necesitar el permiso `com.apple.security.cs.allow-jit` en `entitlements.plist`: compruébalo al notarizar.
- **Windows**: SmartScreen avisa hasta que el ejecutable gana reputación. Se evita con un certificado de firma de código (Authenticode), por ejemplo con Azure Trusted Signing.
- **Linux**: no hace falta firmar.

Hasta entonces, la web debe explicar cómo abrirlo: en macOS, clic derecho → Abrir; en Windows, «Más información» → «Ejecutar de todas formas».

## Qué hace Órbita para funcionar bien en la máquina de otra persona

- **Datos fuera del programa**: cada proyecto se guarda en su carpeta de trabajo (`<carpeta>/orbita/`), y la lista de proyectos en la carpeta de datos del sistema (ver README). Así las actualizaciones no tocan nada. `--data` cambia la carpeta de datos.
- **Elegir carpetas**: el navegador no puede dar rutas completas, así que el servidor abre el selector nativo (AppleScript en macOS, PowerShell en Windows, zenity o kdialog en Linux). Si no hay ninguno, la interfaz pide escribir la ruta.
- **Sin internet**: fuentes (Inter, JetBrains Mono), `marked` y `DOMPurify` van dentro (`public/vendor/`, generado por `npm run vendor`). La página no llama a ningún servidor externo.
- **Puerto estable**: 4321 por defecto. Si se elige otro con `--port`, se recuerda en `config.json`, porque la configuración MCP de la IA lo lleva escrito.
- **Una sola instancia**: si Órbita ya está abierta, abrirla otra vez solo abre el navegador. Si el puerto lo usa otro programa, lo dice y propone otro.
- **Se abre el navegador** al arrancar (`--no-open` para no hacerlo).
- **No pierde nada al cerrar**: con Ctrl+C, al cerrar la terminal o al apagar el equipo, guarda lo pendiente antes de salir.
- **Seguridad local**:
  - Solo escucha en `127.0.0.1`.
  - Rechaza `Host` y `Origin` que no sean los suyos, para que ninguna web pueda usar tu tablero (DNS rebinding o CSRF).
  - La página del tablero lleva una CSP: solo `'self'`, sin scripts externos y sin poder incrustarse en otras webs.
  - Los entregables de la IA se muestran aislados en `/vista/` (sandbox).

## Pendiente para una versión pública

1. **Firmar y notarizar** (ver arriba).
2. **Avisar de actualizaciones**: que Órbita consulte la última release (por ejemplo, un `latest.json` en la web) y muestre «Hay una versión nueva» con un enlace de descarga. No se actualiza sola.
3. **La web de descarga**: detecta el sistema, ofrece el ejecutable correspondiente y explica cómo conectar la IA (`claude mcp add --transport http --scope user orbita http://localhost:4321/mcp`).
4. ~~Mostrar la carpeta desde la interfaz~~: hecho, con «Abrir» en los ajustes de cada proyecto.
5. **Tests**: no hay pruebas automáticas (`npm test`).
6. **Repositorio git**: todavía no lo es; el flujo de releases necesita un repositorio en GitHub.
