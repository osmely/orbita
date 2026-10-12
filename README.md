# Órbita: un Trello con cerebro

Un tablero kanban que funciona a mano y que **cualquier IA conectada por MCP** puede trabajar: Claude Code, Cursor, Claude Desktop u otra. Órbita no usa API keys; la inteligencia la pone la IA que conectes.

## Cómo funciona

Órbita **se ejecuta en la máquina de cada persona**: un servidor pequeño en `127.0.0.1` sirve el tablero al navegador y la IA local de esa persona (Claude Code, Cursor…) se conecta a él por MCP. No hay servidor central: los datos no salen de su equipo y funciona sin internet (la interfaz lleva dentro sus fuentes y librerías). Su web, que explica cómo funciona, está en https://osmely.github.io/orbita/.

## Usarla

Necesitas [Node.js](https://nodejs.org) 22 o posterior.

```bash
git clone https://github.com/osmely/orbita
cd orbita
npm install
npm start
```

El tablero se abre en http://localhost:4321, **en su propia ventana** si tienes Chrome, Edge, Brave o Chromium (en «modo app»: sin pestañas ni barra de direcciones). Si no, en una pestaña de tu navegador.

Para cerrar Órbita: Ctrl+C en la Terminal, o ⌘K → «Cerrar Órbita». Cerrar solo su ventana no la detiene, así que la IA puede seguir trabajando. Si ya hay una Órbita abierta, arrancarla otra vez solo abre la ventana.

Opciones (tras `npm start --`, o con `node server.mjs`): `--port <n>` (por defecto 4321; se recuerda), `--data <carpeta>`, `--no-open`, `--tab` (en una pestaña del navegador, no en su propia ventana), `--version`, `--help`.

### Dónde se guarda todo

**Cada proyecto vive en su carpeta de trabajo** (la del código o los documentos con los que trabaja la IA). Órbita guarda dentro una carpeta `orbita/`:

```
mi-web/                 ← la carpeta de trabajo: aquí trabaja la IA
└── orbita/
    ├── tablero.json    ← el proyecto: instrucciones, memoria y todas sus tarjetas
    ├── adjuntos/       ← lo que adjuntas a las tarjetas
    ├── conocimiento/   ← archivos de referencia del proyecto
    └── …               ← lo que entrega la IA (informes, capturas…)
```

Si copias la carpeta, o la subes a un repositorio, el proyecto va con ella: al elegir esa carpeta en otra máquina, Órbita abre el proyecto tal cual. Al crear un proyecto se elige su carpeta con el selector del sistema; desde la IA, `open_project` usa su directorio de trabajo.

En la carpeta de datos de Órbita solo queda `orbita.json`, con la lista de proyectos (y dónde está cada uno) y lo que no es de ningún proyecto: plantillas y papelera. Junto a él está `secretos.json`, con los secretos de cada proyecto. Está en la carpeta de datos del sistema, no junto al código, así que actualizar Órbita (`git pull`) no la toca:

| Sistema | Carpeta |
|---|---|
| macOS | `~/Library/Application Support/Orbita` |
| Windows | `%APPDATA%\Orbita` |
| Linux | `~/.local/share/orbita` |

## Desarrollar

```bash
npm install
npm run dev
```

`npm run dev` es como `npm start`, pero guarda los datos en esta misma carpeta (`orbita.json`), para no mezclar las pruebas con tus proyectos. Si encuentra un `data/board.json` del formato anterior, todo en un JSON, lo migra solo: cada proyecto pasa a `entregables/<proyecto>/` como carpeta de trabajo, y el JSON antiguo queda como `data/board.v1.json`.

- El servidor: `server.mjs` (HTTP, solo en 127.0.0.1), `estado.mjs` (el tablero y sus operaciones), `rutas.mjs` (la API como tabla `[método, ruta, manejador]`), `mcp.mjs` (las herramientas de la IA), `programadas.mjs`, `almacen.mjs` (dónde se guarda cada cosa), `secretos.mjs` y `entidades.mjs`.
- La interfaz está en `public/`: `index.html`, `styles.css` y sus módulos en `public/js/` (`main.js` los arranca en orden; ninguno pasa de unas 500 líneas). Se cargan como módulos nativos, sin compilar nada.
- `npm test`: las pruebas del servidor (`test/*.test.mjs`): guardado y ciclo MCP completo. Rápidas, sin navegador.
- `npm run test:interfaz`: las pruebas de la interfaz en Chrome sin ventana (`test/interfaz/`): un recorrido general, nueva tarjeta, avisos sin IA, Markdown saneado, entregables, Claude en vivo (hooks) y móvil. Cada archivo arranca su propia Órbita con un puerto libre y carpetas temporales, así que nunca tocan tus datos, y falla si la página da algún error de JavaScript. Busca Chrome, Chromium o Edge en los sitios habituales; si está en otro, `CHROME=/ruta/al/navegador npm run test:interfaz`. Sin navegador, se saltan con un aviso.
- `npm run vendor`: vuelve a copiar fuentes y librerías de la interfaz a `public/vendor/` (tras cambiar sus versiones).

## Conectar el cerebro

Claude Code (una sola vez; queda disponible en todas tus sesiones):

```bash
claude mcp add --transport http --scope user orbita http://localhost:4321/mcp
```

Después, abre el panel 🧠 de tu proyecto en Órbita, copia su instrucción y pégala en una sesión de Claude: se queda escuchando las tarjetas de ese proyecto.

Para empezar un proyecto **sin tocar la app**, pídeselo a la IA en su chat: *«Abre en Órbita un proyecto llamado Web de la tienda y quédate escuchando»*. La IA crea el proyecto (o abre el que ya tenga ese nombre), pasa a ser su IA y se queda escuchando sus tarjetas. El tablero cambia solo a ese proyecto. Cada sesión de Claude puede llevar su propio proyecto en paralelo.

Para Cursor, Claude Desktop y otras, pulsa **Conectar IA** en el tablero: ahí está la configuración lista para copiar.

## Cómo se usa

- **A mano**: crea tarjetas, arrástralas entre columnas y escribe resultados tú mismo. Es un Trello normal.
- **Con IA**: arrastra una tarjeta a **«En curso»**. La IA conectada la toma, muestra su progreso en vivo y la deja en **«Para revisar»**. Desde ahí la apruebas o se la devuelves con un comentario.
- **Criterios de aceptación («Terminado cuando…»)**: cada tarjeta puede llevar su lista, en el panel o al crearla, uno por línea. La IA los recibe y **no puede entregar sin revisarlos todos**: cada uno queda como ✓ o ✗, con su evidencia. En la tarjeta se ve «2/3 ✓». Al revisar, «✗ No se cumple» marca los que fallan, y al devolver la tarjeta la IA recibe cuáles son. Se incluyen al exportar y en la búsqueda.
- **Papelera**: lo que borra una IA no se pierde. Sale un aviso «🗑 Claude borró…» con **Deshacer**, y en **🗄 Archivo → Papelera** se restaura o se borra del todo. Se vacía sola a los 30 días. Ninguna IA puede editar ni borrar una tarjeta que esté trabajando otra.
- **Entregables**: marca como **📦 Entregable** las tarjetas cuyo resultado es lo que se queda el proyecto (un informe, un documento, una versión final…). Se marca al crearla o en su panel (⚙ Ajustes); la IA también puede marcarla al planificar.
  - **Al aprobarla**, su resultado se guarda en `orbita/entregables/<título>.md`.
  - **La sección «Entregables»** del proyecto muestra solo esas tarjetas, con su resultado, su documento y sus archivos.
  - **Lo intermedio** (capturas, borradores, pruebas) queda plegado aparte, en «Archivos de trabajo».
- **Vista previa de archivos**: al abrir un archivo (desde «Entregables» o desde una tarjeta) se ve en el panel:
  - **Páginas HTML funcionando**: el juego se puede jugar, con «⛶ En grande», «↻» y «↗ Pestaña nueva».
  - **CSV** como tabla, **código** y **JSON** con colores, **Markdown**, imágenes/SVG, **PDF**, audio y vídeo. Todos con «⤓ Descargar».
  - **Seguridad**: lo que escribe una IA se sirve desde `/vista/` con la cabecera *sandbox* y en un iframe aislado. Se ejecuta, pero **no puede leer ni cambiar el tablero** ni tocar la ventana de Órbita, ni siquiera abierto en otra pestaña. La ruta lleva una clave que solo conoce el tablero (`/vista/<clave>/…`), así que ninguna otra web puede cargar tus entregables. `/files/` sigue sirviendo texto plano, y ninguna ruta sigue un enlace simbólico que lleve fuera de `orbita/`.
- **Nueva tarjeta en un paso**: «＋ Nueva tarjeta» pide solo el título (y, si quieres, detalles). Enter = «Crear y pedírsela a la IA»; «Solo crear» la deja en Ideas. Criterios, proyecto, entregable y plantillas están en «Más opciones», con un resumen al lado (p. ej. «en Web · 2 criterios»).
- **Plantillas de tarjetas**: en «＋ Nueva tarjeta › Más opciones» están las plantillas (Investigación, Informe, Revisión de código, Corregir un fallo y las tuyas).
  - **Crear**: un clic rellena título, descripción y criterios, y otro clic en «Crear».
  - **Campos**: los {campos} entre llaves («Investigar {tema}») se piden al usarla y se ven al momento.
  - **Con el teclado**: ⌘K → «Nueva desde plantilla: …».
  - **Guardar**: «⧉ Guardar como plantilla» en el panel de cualquier tarjeta. Las tuyas se borran con ✕.
  - **Enter** en el título de una tarjeta nueva la crea.
- **Tareas programadas y recurrentes**: «🔁 Repetir» en el panel de cada tarjeta.
  - **Opciones**: una vez (fecha y hora), cada día, cada semana (elige los días) o cada mes (el 31 cae el último día en meses cortos).
  - **A su hora**, la de una vez pasa sola a «En curso». Las repetidas crean una tarjeta nueva con fecha, copiando la descripción, los criterios y el proyecto.
  - **Se ve** la próxima y la última, y en la tarjeta «🔁 lun, mié 9:00».
  - **Respeta la pausa** del proyecto. Si Órbita estaba apagada, al arrancar crea **una** (no una por cada vez perdida).
- **Una IA por proyecto (en paralelo)**: en la pestaña de un proyecto, «🧠 Su propia IA» le asigna una IA con nombre propio. Esa IA solo toma las tarjetas y preguntas de ese proyecto, y las demás IAs no las tocan, así que dos proyectos avanzan a la vez, cada uno en su sesión de Claude. El panel da la instrucción para lanzarla en una sesión nueva y muestra si está escuchando, trabajando o desconectada. Una IA también puede apuntarse sola con `wait_for_work(project: …)`.
- **La IA del proyecto, en un solo control**: a la derecha de las secciones, «🧠 Claude · ia ▶ Trabajando». La primera mitad dice quién es su IA (o «Cualquier IA») y si está conectada; al pulsarla, abre su panel con la instrucción para lanzarla. La segunda pausa y reanuda. **Pausar no interrumpe**: la IA termina la tarjeta que tiene entre manos (la tarjeta lo dice: «⏸ terminará esta y parará») y no toma más hasta que reanudes. «Reanudar todos los proyectos» está en ⌘K.
- **Modo claro y oscuro**: el botón ◐ junto a 🔔 Avisos cambia entre automático (sigue al sistema), claro y oscuro. También desde ⌘K («Tema claro»). Se recuerda en cada navegador.
- **Paleta de comandos** (⌘K / Ctrl+K): sin escribir, muestra las acciones útiles para lo que tienes delante. Con una tarjeta abierta puedes moverla de columna, subirla o bajarla, archivarla, copiar o exportar su resultado. También: nueva tarjeta, planificar, ir a un proyecto, abrir sus secciones, archivar las hechas, nuevo proyecto y conectar una IA. Empieza con «>» para ver solo comandos. «Atajos de teclado» muestra la lista completa.
- **Objetivos**: escribe un objetivo grande arriba y pulsa Planificar. La IA lo divide en tarjetas dentro del **proyecto que estás viendo**. Solo si aún no hay ninguno se crea un proyecto nuevo, eligiendo su carpeta.
- **Proyectos como pestañas** (como en el navegador): cada proyecto tiene su pestaña y dentro está todo lo suyo: **Tablero**, **Contexto para la IA** (instrucciones, memoria, conocimiento y secretos), **Entidades** y **Entregables**. El archivo y la papelera se abren con «🗄 Archivo» en la columna Hecho. ✕ cierra la pestaña sin borrar el proyecto; ＋ crea uno nuevo o reabre uno cerrado; doble clic renombra. Siempre hay un proyecto a la vista: al cerrar su pestaña se pasa a la de al lado, y la última abierta no se cierra. Si todavía no hay ninguno, Órbita propone crear el primero. También vale `?proyecto=<id>` en la dirección.
- **Instrucciones, memoria y conocimiento** (dentro de la pestaña del proyecto): instrucciones fijas, una memoria que la IA va actualizando y archivos de referencia que puedes arrastrar. La IA lo recibe con cada tarjeta del proyecto.
- **Entidades del proyecto** (sección «Entidades»): lo que existe en el proyecto y perdura, por categorías. Por ejemplo, los personajes de un juego, sus armas y objetos, las personas de un informe o los lugares de una historia.
  - **Fichas**: cada entidad tiene nombre, categoría, resumen, detalles en Markdown, etiquetas e imagen. Se agrupan por categoría, cada una con su icono y su color, y se pueden filtrar y buscar.
  - **La IA** recibe con cada tarjeta el índice (nombres por categoría). Guarda con `entities` (`action: "save"`) lo que crea o descubre; si ya existe con esa categoría y nombre, la actualiza en vez de duplicarla. Con `action: "list"` lee los detalles.
  - **Tú** las creas, editas y les pones imagen (pulsando o arrastrándola sobre la ficha).
  - Viven en el `tablero.json` del proyecto, y sus imágenes en `orbita/entidades/`: viajan con la carpeta.
- **Secretos del proyecto** (en «Contexto para la IA» → Secretos): claves de API, tokens o contraseñas de servicios, con un nombre como `STRIPE_API_KEY`.
  - **La IA** recibe solo los nombres con cada tarjeta y pide el valor con `get_secret` cuando lo necesita, desde una tarjeta suya. Queda apuntado en la actividad, sin el valor.
  - **Tapados**: si una IA pega un valor en un resultado, su progreso, un comentario, una pregunta o un entregable, se guarda como `«secreto NOMBRE»`.
  - **Dónde**: en `secretos.json`, en la carpeta de datos de Órbita (solo la persona puede leerlo). No van en `orbita/`, así que no viajan con la carpeta ni acaban en un repositorio.
  - **Solo se escriben**: una vez guardado, el valor no se vuelve a mostrar. Para cambiarlo, se guarda otra vez con el mismo nombre.
- **Archivo**: «Archivar» en la columna Hecho guarda las tarjetas terminadas del proyecto visible. No se borra nada: «🗄 Archivo» (en la columna Hecho) las lista y cada una se puede restaurar.
- **Mientras la IA trabaja** ves en la tarjeta los últimos pasos, el porcentaje y cuánto lleva, y en su panel la sección **«En vivo»** con lo que va produciendo antes de entregar.
- **Todo lo que hace Claude, en vivo** (opcional): añade a tus ajustes de Claude Code el bloque de hooks de **Conectar IA → «Todo lo que hace Claude, en vivo»**. Órbita no toca esa configuración: la añades tú.
  - **Qué se ve:** en «En vivo → Claude ahora» aparece cada comando, archivo leído o editado y búsqueda (en marcha, ✓ con su duración o ✗ con el error), su lista de tareas y lo que dice.
  - **Si va a parar con la tarjeta en curso**, que es cuando se queda esperando en su chat, Órbita le pide que te pregunte por el tablero (`ask_human`) o que entregue.
  - Son hooks http: si Órbita está cerrada, Claude sigue sin más.
- **Si la IA te espera fuera de Órbita**, la tarjeta se pone en ámbar y te avisa: espera un permiso en su terminal, espera tu respuesta en su chat o paró sin entregar. Esto se sabe con los hooks de Claude. Sin ellos, Órbita lo sospecha cuando la IA lleva más de 2 minutos sin informar ni escuchar el tablero.
- Si a la IA le falta una decisión, **te pregunta** y la tarjeta parpadea en ámbar.
- **Conversación**: cada tarjeta tiene un hilo con tus comentarios y respuestas, y las preguntas, notas y entregas de la IA. Puedes escribirle mientras trabaja: lo recibe en su próximo paso, sin detenerse. Cmd/Ctrl + Enter envía.
- **Versiones del resultado**: cada entrega (o edición a mano) es una versión. En el panel, ‹ › para moverte entre versiones y «Ver cambios» para ver qué cambió respecto a la anterior. ↻ en la tarjeta indica cuántas versiones lleva.
- **Copiar y exportar resultados**: junto al resultado, «Copiar» (Markdown al portapapeles), «.md» (descarga con título, fecha y las imágenes metidas dentro), «Página» (una página limpia para leer o compartir) y «PDF» (esa página con el diálogo de imprimir → «Guardar como PDF»). Siempre se exporta la versión que estás viendo.
- **Visor de imágenes**: toca cualquier imagen (resultado, «En vivo», conversación, adjuntos o entregables) para verla a pantalla completa. Tócala otra vez para verla a tamaño real. «Copiar imagen» (o la tecla C) la copia al portapapeles para pegarla donde quieras. ← → pasan de una imagen a otra. También se puede descargar o abrir el original. Esc la cierra.
- **Adjuntos**: arrastra archivos desde tu ordenador sobre una tarjeta (o a la zona «Adjuntos» de su panel). La IA los recibe con la tarjeta; si ya está trabajando, se lo dice en su siguiente paso. 📎 = tus adjuntos, ✎ = archivos de la IA.
- **Tokens por tarjeta**: cada tarjeta muestra lo que gastó en ella la IA, «⇣ entrada · ⇡ salida» (en el panel, con el desglose de caché y el número de respuestas). Órbita lo saca de los registros de sesión de Claude Code (`~/.claude/projects/<carpeta>/*.jsonl`): solo los **lee**, solo los de las carpetas de trabajo de tus proyectos, y solo usa sus cifras de uso. Sabe de qué tarjeta es cada respuesta siguiendo las llamadas de la IA a Órbita (la tarjeta que le da `wait_for_work` o que nombra al informar, hasta que la entrega o pregunta). Se actualiza cada 20 s y al entregar. Con otras IAs (Cursor…) no hay cifras.
- **Orden**: arrastra una tarjeta dentro de su columna (o a otra) y queda justo donde la sueltas. En el panel, ↑ ↓ o Alt+↑/↓ la mueven una posición (útil en el móvil). **El orden de «En curso» es la prioridad**: la IA toma primero la de arriba, también entre las que vuelven a ella porque le respondiste o comentaste su resultado (esas entran al final; súbelas si corren prisa).
- **Dependencias**: en el panel de una tarjeta, «Espera a…» indica qué tarjetas tienen que estar hechas antes. Mientras falten, la tarjeta muestra 🔒 y ninguna IA la toma; al aprobar la última se libera sola. La IA también puede indicarlas al planificar.
- **Avisos**: la pestaña muestra cuántas tarjetas te esperan, «(2) Órbita», con un número en su icono. Desde 🔔 Avisos puedes activar el aviso del navegador y un sonido suave para cuando la IA entregue o te pregunte algo y no estés mirando. Al pulsar el aviso se abre esa tarjeta.
- Si **le quitas una tarjeta** a la IA mientras trabaja (la devuelves a Ideas, la eliminas, la das por hecha o la reinicias), su siguiente llamada recibe «DETENTE» y deja de trabajar en ella. En la tarjeta verás cuándo recibió el aviso.
- Cada tarjeta tiene **enlace directo**: `http://localhost:4321/#t=<id>` abre su panel.
- Si no hay ninguna IA conectada, las tarjetas esperan en cola hasta que llegue una.

Lo que escribe la IA con `write_file` queda en `<carpeta de trabajo>/orbita/`; el código del proyecto lo escribe la IA con sus propias herramientas en la carpeta de trabajo, que recibe en cada tarjeta (`project.working_directory`).

## Herramientas MCP

| Herramienta | Qué hace |
|---|---|
| `wait_for_work` | Escucha el tablero y toma la siguiente tarjeta (o la que le devolviste). En `notices` le cuenta las tarjetas que le quitaste |
| `report_progress` | Mueve la barra de progreso y, con `detalle` (Markdown, con imágenes), publica el avance intermedio en la sección «En vivo» de la tarjeta |
| `open_project` | Crea un proyecto en una carpeta de trabajo (`directory`, normalmente la de la propia IA), o abre el que ya haya. Hace a la IA su IA y cambia el tablero a ese proyecto. Con `goal` deja además una tarjeta de planificación que será lo primero que reciba |
| `wait_for_work` (con `project`) | Ser la IA de un solo proyecto: solo recibe su trabajo |
| `update_card` | Edita una tarjeta: título, descripción, criterios, proyecto, dependencias o columna (queda en su actividad) |
| `delete_card` | Borra una o varias tarjetas: van a la **Papelera** (Archivo), con aviso y «Deshacer» |
| `trash` | Sin `id`, lista la papelera; con `id`, restaura esa tarjeta |
| `submit_result` | Entrega el resultado para revisión (con `criteria`: la autorrevisión de cada criterio de aceptación, con evidencia) |
| `ask_human` | Te hace una pregunta; tu respuesta le llega por `wait_for_work` |
| `entities` | Con `action` `list`, `save` o `delete`: busca, guarda (crea o actualiza) y borra las entidades del proyecto: personajes, objetos, personas, lugares… |
| `get_secret` | Lee el valor de un secreto del proyecto de su tarjeta (los nombres vienen en `project.secrets`) |
| `update_memory` | Reescribe la memoria del proyecto de su tarjeta con lo que conviene recordar |
| `add_comment` | Deja una nota en la conversación sin entregar ni pausar la tarjeta |
| `create_card` | Crea tarjetas (por ejemplo, al planificar un objetivo); con `depends_on` indica a qué tarjetas espera |
| `list_cards`, `get_card` | Consulta el tablero (filtrable por proyecto; las archivadas solo con `include_archived`) |
| `read_file`, `write_file` | Lee (sin `path`, lista) y guarda archivos. Con `card_id`, el archivo va a la carpeta del proyecto de la tarjeta |


Por seguridad, el servidor solo escucha en `127.0.0.1` y rechaza peticiones con otro `Host` u `Origin` (así ninguna web puede usar tu tablero desde tu navegador). La página del tablero lleva una política de seguridad de contenido (CSP) que solo deja cargar lo suyo y no se puede incrustar en otras webs. Usa `--port` (o `PORT`) para cambiar el puerto.

Atajos: `⌘K` abre la paleta de comandos, `/` enfoca la barra de arriba, `n` crea una tarjeta, `Alt+↑/↓` mueve la tarjeta abierta y `Esc` cierra.
