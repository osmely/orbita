# Órbita en GitHub Pages: qué hace falta para que funcione

## El problema
GitHub Pages solo sirve archivos estáticos (HTML, CSS, JS). Hoy Órbita depende de un servidor propio (`server.mjs`) para:

| Qué hace el servidor | ¿Lo puede hacer una página estática? |
|---|---|
| Recibir a la IA por **MCP** (`/mcp`, 24 herramientas, `wait_for_work` en espera) | **No**: una web no puede escuchar conexiones |
| Guardar el tablero en `<carpeta>/orbita/tablero.json` y los entregables | Solo en Chrome/Edge, con la *File System Access API* |
| Avisar en vivo a la página (SSE) | No hay servidor; habría que leer los archivos cada poco |
| Selector de carpetas nativo, abrir en Finder, vista previa aislada | Parcialmente (el selector del navegador sí) |

**Conclusión:** la interfaz puede vivir en Pages, pero la IA siempre necesita *algo* que hable MCP. Hay tres formas de dárselo.

## Opción A · Interfaz en Pages + servidor local con `npx` (recomendada para empezar)
- La web se publica en `https://osmely.github.io/orbita/`.
- En lugar del ejecutable, el servidor de siempre se reparte como **paquete npm**: `npx orbita`, que necesita Node instalado.
- La página de Pages se conecta a `http://localhost:4321`. Hay que añadir CORS para ese origen.
  - **Chrome 142+** pide una vez el permiso *Acceso a la red local / Apps en el dispositivo* para que una web pública hable con `localhost`.
  - **Safari** puede bloquear las llamadas de una web `https` a `http://localhost`: hay que probarlo.
- La IA, igual que hoy: `claude mcp add --transport http orbita http://localhost:4321/mcp`.
- **Coste:** poco, porque se reutiliza todo. Hacen falta un *workflow* de Pages, configurar la URL de la API en la interfaz, CORS y publicar en npm.
- **Contra:** sigue habiendo un proceso local que arrancar. Pages solo aloja la interfaz.

## Opción B · Web pura en Pages + MCP por stdio que la IA arranca sola (sin nada que arrancar a mano)
- La web abre la carpeta del proyecto con `showDirectoryPicker()`, y lee y escribe `orbita/` directamente.
- La IA se conecta a un MCP **stdio** que arranca ella misma: `claude mcp add orbita -- npx -y orbita-mcp`. Ese MCP lee y escribe los mismos archivos.
- La web y la IA se coordinan **a través de los archivos**. La web mira cada 1–2 s si cambiaron, y `wait_for_work` también.
- **Coste:** alto, porque es una reescritura.
  - Ya no hay servidor central: hay que repartir el estado (una tarjeta por archivo, bloqueos cuando escriben a la vez la web y varias IAs).
  - Las preguntas rápidas y lo global necesitan su sitio en disco.
  - La vista previa aislada hay que rehacerla.
- **Contras:**
  - Solo funciona en Chrome, Edge, Brave y Opera. Firefox y Safari no tienen `showDirectoryPicker`.
  - El navegador pide permiso a la carpeta en cada sesión, salvo que se recuerde.

## Opción C · Pages + backend en la nube (Cloudflare Workers, Supabase…)
- La IA se conecta a un MCP remoto (HTTP) y los datos viven en la nube, con cuentas de usuario.
- **Contras:**
  - Rompe la promesa actual: *«los datos no salen de tu equipo»*.
  - Exige autenticación, costes y mantenimiento.
  - Además, la IA trabaja con archivos locales, así que los entregables y la carpeta de trabajo seguirían siendo locales.

## Recomendación
1. **Ahora, la opción A.** En poco tiempo Órbita queda publicada en Pages sin ejecutable: `npx orbita` + la web.
2. **Después, si quieres que no haya nada que arrancar**, migrar a B por partes, primero el MCP stdio. A no lo impide.

C solo tiene sentido si quieres un producto multiusuario o en la nube.

## Fuentes
- [Chrome · Local Network Access](https://developer.chrome.com/blog/local-network-access) · [Chromium 142: enforcement de LNA](https://www.dynamsoft.com/web-twain/docs/faq/chromium-142-local-network-access-issue.md) · [Guía de LNA (OpenReplay)](https://blog.openreplay.com/es/chrome-local-network-access-lna-permiso/)
- [web.dev · Abrir un directorio (`showDirectoryPicker`, soporte por navegador)](https://web.dev/articles/files/open-a-directory?hl=es)
