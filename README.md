# Órbita: un Trello con cerebro

Un tablero kanban que funciona a mano y que **cualquier IA conectada por MCP** puede trabajar: Claude Code, Cursor, Claude Desktop u otra. Órbita no usa API keys; la inteligencia la pone la IA que conectes.

## Cómo funciona

Órbita se descarga de su web, pero **se ejecuta en la máquina de cada persona**: un servidor pequeño en `127.0.0.1` sirve el tablero al navegador y la IA local de esa persona (Claude Code, Cursor…) se conecta a él por MCP. No hay servidor central: los datos no salen de su equipo y funciona sin internet (la interfaz lleva dentro sus fuentes y librerías).

## Usarla (ejecutable, sin instalar Node)

Descarga el ejecutable de tu sistema, ábrelo y se abre el tablero en el navegador.

```bash
./orbita
```

Opciones: `--port <n>` (por defecto 4321; se recuerda), `--data <carpeta>`, `--no-open`, `--version`, `--help`.

Los datos se guardan en la carpeta de datos del sistema, no junto al programa (así una actualización no los toca):

| Sistema | Carpeta |
|---|---|
| macOS | `~/Library/Application Support/Orbita` |
| Windows | `%APPDATA%\Orbita` |
| Linux | `~/.local/share/orbita` |

Si ya hay una Órbita abierta, abrirla otra vez solo abre el navegador.

## Desarrollar

```bash
npm install
npm start
```

Abre http://localhost:4321. `npm start` usa esta misma carpeta como carpeta de datos (`data/board.json` y `entregables/`).

- `npm run build`: crea el ejecutable para tu sistema en `dist/` (ver [DISTRIBUCION.md](DISTRIBUCION.md)).
- `npm run vendor`: vuelve a copiar fuentes y librerías de la interfaz a `public/vendor/` (tras cambiar sus versiones).

## Conectar el cerebro

Claude Code (una sola vez; queda disponible en todas tus sesiones):

```bash
claude mcp add --transport http --scope user orbita http://localhost:4321/mcp
```

Después, en cualquier sesión de Claude Code, escribe `/mcp__orbita__trabajar` y Claude se queda escuchando el tablero.

Para empezar un proyecto **sin tocar la app**, pídeselo a la IA en su chat: *«Abre en Órbita un proyecto llamado Web de la tienda y quédate escuchando»*, o en Claude Code `/mcp__orbita__nuevo_proyecto Web de la tienda`. La IA crea el proyecto (o abre el que ya tenga ese nombre), pasa a ser su IA y se queda escuchando sus tarjetas. El tablero cambia solo a ese proyecto. Cada sesión de Claude puede llevar su propio proyecto en paralelo.

Para Cursor, Claude Desktop y otras, pulsa **Conectar IA** en el tablero: ahí está la configuración lista para copiar.

## Cómo se usa

- **A mano**: crea tarjetas, arrástralas entre columnas y escribe resultados tú mismo. Es un Trello normal.
- **Con IA**: arrastra una tarjeta a **«En curso»**. La IA conectada la toma, muestra su progreso en vivo y la deja en **«Para revisar»**. Desde ahí la apruebas o se la devuelves con un comentario.
- **Búsqueda global** (⌘K / Ctrl+K, o 🔍 junto a las pestañas): busca en títulos, descripciones, resultados y sus versiones, conversaciones, adjuntos, entregables y preguntas, también en lo archivado. Sin importar tildes ni mayúsculas; con varias palabras, deben estar todas. ↑ ↓ y Enter para abrir.
- **Criterios de aceptación («Terminado cuando…»)**: cada tarjeta puede llevar su lista, en el panel o al crearla, uno por línea. La IA los recibe y **no puede entregar sin revisarlos todos**: cada uno queda como ✓ o ✗, con su evidencia. En la tarjeta se ve «2/3 ✓». Al revisar, «✗ No se cumple» marca los que fallan, y al devolver la tarjeta la IA recibe cuáles son. Se incluyen al exportar y en la búsqueda.
- **Papelera**: lo que borra una IA no se pierde. Sale un aviso «🗑 Claude borró…» con **Deshacer**, y en **Archivo → Papelera** se restaura o se borra del todo. Se vacía sola a los 30 días. Ninguna IA puede editar ni borrar una tarjeta que esté trabajando otra.
- **Vista previa de entregables**: al abrir un archivo (desde «Entregables» o desde una tarjeta) se ve en el panel:
  - **Páginas HTML funcionando**: el juego se puede jugar, con «⛶ En grande», «↻» y «↗ Pestaña nueva».
  - **CSV** como tabla, **código** y **JSON** con colores, **Markdown**, imágenes/SVG, **PDF**, audio y vídeo. Todos con «⤓ Descargar».
  - **Seguridad**: lo que escribe una IA se sirve desde `/vista/` con la cabecera *sandbox* y en un iframe aislado. Se ejecuta, pero **no puede leer ni cambiar el tablero** ni tocar la ventana de Órbita, ni siquiera abierto en otra pestaña. `/files/` sigue sirviendo texto plano.
- **Plantillas de tarjetas**: en «＋ Nueva tarjeta» están las plantillas (Investigación, Informe, Revisión de código, Corregir un fallo y las tuyas).
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
- **IA de preguntas**: en el panel 💬 se asigna una IA aparte que **solo** responde preguntas rápidas, al momento y sin interrumpir a las que trabajan tarjetas. Mientras está conectada, las demás no reciben preguntas; si se desconecta, las responde cualquier otra, así que nunca se quedan sin respuesta. Se lanza en otra sesión de Claude con la instrucción del panel, o la IA se apunta sola con `wait_for_work(solo: "preguntas")`.
- **Una IA por proyecto (en paralelo)**: en la pestaña de un proyecto, «🧠 Su propia IA» le asigna una IA con nombre propio. Esa IA solo toma las tarjetas y preguntas de ese proyecto, y las demás IAs no las tocan, así que dos proyectos avanzan a la vez, cada uno en su sesión de Claude. El panel da la instrucción para lanzarla en una sesión nueva y muestra si está escuchando, trabajando o desconectada. Una IA también puede apuntarse sola con `wait_for_work(project: …)`.
- **Play / pausa por proyecto**: «⏸ Pausar» en la pestaña de un proyecto hace que la IA no tome sus tarjetas. La tarjeta muestra si la IA ya se enteró («Avisando a Claude…» → «Claude se detuvo ✓»): una IA solo recibe el aviso en su siguiente llamada a Órbita, y si reanudas antes de que se entere, sigue sin interrupción. Si estaba trabajando en una, recibe «DETENTE» y la tarjeta vuelve a la cola con todo lo que llevaba; al «▶ Reanudar», la misma IA la retoma donde lo dejó. «▶ Solo este» pausa los demás proyectos para darle prioridad total a uno, y en «Todos» está «Reanudar todos». También desde ⌘K.
- **Paleta de comandos** (también en ⌘K): sin escribir, muestra las acciones útiles para lo que tienes delante. Con una tarjeta abierta puedes moverla de columna, subirla o bajarla, archivarla, copiar o exportar su resultado. También: nueva tarjeta, planificar, pregunta rápida, ir a un proyecto, abrir sus secciones, archivar las hechas, nuevo proyecto y conectar una IA. Empieza con «>» para ver solo comandos. «Atajos de teclado» muestra la lista completa.
- **Pregunta rápida**: cambia la barra de arriba a 💬 **Preguntar** (o abre 💬 Preguntas, tecla `?`). La IA conectada responde ahí mismo, sin crear tarjeta; en la pestaña de un proyecto, con su contexto. Cualquier pregunta se puede convertir en tarjeta.
- **Objetivos**: escribe un objetivo grande arriba. La IA lo divide en tarjetas, y el objetivo se convierte en un **proyecto**.
- **Proyectos como pestañas** (como en el navegador): cada proyecto tiene su pestaña y dentro está todo lo suyo: **Tablero**, **Instrucciones y memoria**, **Conocimiento**, **Entregables** y **Archivo**. ✕ cierra la pestaña sin borrar el proyecto; ＋ crea uno nuevo o reabre uno cerrado; doble clic renombra. «⌂ Todos» lo muestra todo junto. También vale `?proyecto=<id>` en la dirección.
- **Instrucciones, memoria y conocimiento** (dentro de la pestaña del proyecto): instrucciones fijas, una memoria que la IA va actualizando y archivos de referencia que puedes arrastrar. La IA lo recibe con cada tarjeta del proyecto.
- **Archivo**: «Archivar» en la columna Hecho guarda las tarjetas terminadas del proyecto visible. No se borra nada: la sección «Archivo» del proyecto las lista y cada una se puede restaurar.
- **Mientras la IA trabaja** ves en la tarjeta los últimos pasos, el porcentaje y cuánto lleva, y en su panel la sección **«En vivo»** con lo que va produciendo antes de entregar.
- Si a la IA le falta una decisión, **te pregunta** y la tarjeta parpadea en ámbar.
- **Conversación**: cada tarjeta tiene un hilo con tus comentarios y respuestas, y las preguntas, notas y entregas de la IA. Puedes escribirle mientras trabaja: lo recibe en su próximo paso, sin detenerse. Cmd/Ctrl + Enter envía.
- **Versiones del resultado**: cada entrega (o edición a mano) es una versión. En el panel, ‹ › para moverte entre versiones y «Ver cambios» para ver qué cambió respecto a la anterior. ↻ en la tarjeta indica cuántas versiones lleva.
- **Copiar y exportar resultados**: junto al resultado, «Copiar» (Markdown al portapapeles), «.md» (descarga con título, fecha y las imágenes metidas dentro), «Página» (una página limpia para leer o compartir) y «PDF» (esa página con el diálogo de imprimir → «Guardar como PDF»). Siempre se exporta la versión que estás viendo.
- **Visor de imágenes**: toca cualquier imagen (resultado, «En vivo», conversación, adjuntos o entregables) para verla a pantalla completa. Tócala otra vez para verla a tamaño real. «Copiar imagen» (o la tecla C) la copia al portapapeles para pegarla donde quieras. ← → pasan de una imagen a otra. También se puede descargar o abrir el original. Esc la cierra.
- **Adjuntos**: arrastra archivos desde tu ordenador sobre una tarjeta (o a la zona «Adjuntos» de su panel). La IA los recibe con la tarjeta; si ya está trabajando, se lo dice en su siguiente paso. 📎 = tus adjuntos, ✎ = archivos de la IA.
- **Orden**: arrastra una tarjeta dentro de su columna (o a otra) y queda justo donde la sueltas. En el panel, ↑ ↓ o Alt+↑/↓ la mueven una posición (útil en el móvil). **El orden de «En curso» es la prioridad**: la IA toma primero la de arriba.
- **Dependencias**: en el panel de una tarjeta, «Espera a…» indica qué tarjetas tienen que estar hechas antes. Mientras falten, la tarjeta muestra 🔒 y ninguna IA la toma; al aprobar la última se libera sola. La IA también puede indicarlas al planificar.
- **Avisos**: la pestaña muestra cuántas tarjetas te esperan, «(2) Órbita», con un número en su icono. Desde 🔔 Avisos puedes activar el aviso del navegador y un sonido suave para cuando la IA entregue o te pregunte algo y no estés mirando. Al pulsar el aviso se abre esa tarjeta.
- Si **le quitas una tarjeta** a la IA mientras trabaja (la devuelves a Ideas, la eliminas, la das por hecha o la reinicias), su siguiente llamada recibe «DETENTE» y deja de trabajar en ella. En la tarjeta verás cuándo recibió el aviso.
- Cada tarjeta tiene **enlace directo**: `http://localhost:4321/#t=<id>` abre su panel.
- Si no hay ninguna IA conectada, las tarjetas esperan en cola hasta que llegue una.

Lo que escribe la IA queda en `entregables/` y el tablero en `data/board.json`, dentro de la carpeta de datos.

## Herramientas MCP

| Herramienta | Qué hace |
|---|---|
| `wait_for_work` | Escucha el tablero y toma la siguiente tarjeta (o la que le devolviste). En `notices` le cuenta las tarjetas que le quitaste |
| `report_progress` | Mueve la barra de progreso y, con `detalle` (Markdown, con imágenes), publica el avance intermedio en la sección «En vivo» de la tarjeta |
| `open_project` | Crea un proyecto (o abre uno que ya existe), hace a la IA su IA y cambia el tablero a ese proyecto. Con `goal` deja además una tarjeta de planificación que será lo primero que reciba |
| `wait_for_work` (con `project`) | Ser la IA de un solo proyecto: solo recibe su trabajo |
| `update_card` | Edita una tarjeta: título, descripción, criterios, proyecto o dependencias (queda en su actividad) |
| `delete_card` | Borra una o varias tarjetas: van a la **Papelera** (Archivo), con aviso y «Deshacer» |
| `list_trash` / `restore_card` | Ver la papelera y restaurar |
| `submit_result` | Entrega el resultado para revisión (con `criteria`: la autorrevisión de cada criterio de aceptación, con evidencia) |
| `ask_human` | Te hace una pregunta; tu respuesta le llega por `wait_for_work` |
| `answer_question` | Responde una pregunta rápida que le llegó por `wait_for_work` (campo `question`) |
| `update_memory` | Reescribe la memoria del proyecto de su tarjeta con lo que conviene recordar |
| `add_comment` | Deja una nota en la conversación sin entregar ni pausar la tarjeta |
| `create_card` | Crea tarjetas (por ejemplo, al planificar un objetivo); con `depends_on` indica a qué tarjetas espera |
| `list_cards`, `get_card`, `claim_card` | Consulta el tablero (filtrable por proyecto; las archivadas solo con `include_archived`) y toma tarjetas concretas |
| `move_card` | Mueve tarjetas si se lo pides |
| `list_files`, `read_file`, `write_file` | Comparte entregables. Con `card_id`, el archivo va a la carpeta del proyecto de la tarjeta |

También incluye los prompts `trabajar` (pone a la IA en modo cerebro) y `nuevo_proyecto` (abre un proyecto y lo escucha).

Por seguridad, el servidor solo escucha en `127.0.0.1` y rechaza peticiones con otro `Host` u `Origin` (así ninguna web puede usar tu tablero desde tu navegador). La página del tablero lleva una política de seguridad de contenido (CSP) que solo deja cargar lo suyo y no se puede incrustar en otras webs. Usa `--port` (o `PORT`) para cambiar el puerto.

Atajos: `⌘K` busca, `/` enfoca la barra de arriba, `?` abre las preguntas, `n` crea una tarjeta, `Alt+↑/↓` mueve la tarjeta abierta y `Esc` cierra.
