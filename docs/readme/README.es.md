<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="Estrellas en GitHub" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Última versión de Orca NP" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Licencia: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Builds de Orca NP: macOS y Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a></sub>
</p>

<p align="center">
  <strong>🔱 Este es <a href="#qué-hay-de-distinto-en-este-fork">Orca NP</a>: un fork de <a href="https://github.com/stablyai/orca">stablyai/orca</a> con sus propias funciones, correcciones y versiones.</strong><br/>
  <sub>Se instala junto al Orca oficial · <a href="https://github.com/nplez1/orca/releases/latest">Descarga la última build de Orca NP</a> · <a href="#qué-hay-de-distinto-en-este-fork">Mira qué es diferente ↓</a></sub>
</p>

<p align="center">
  <strong>El orquestador de IA para desarrolladores 100x.</strong><br/>
  Ejecuta Codex, Claude Code, OpenCode u Pi en paralelo — cada uno en su propio worktree, supervisados desde un solo lugar.
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Descargar Orca NP</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="La app de escritorio de Orca ejecutando agentes en worktrees paralelos, con la app companion móvil de Orca en la esquina" width="960" />
</p>

## Qué hay de distinto en este fork

Orca NP es [stablyai/orca](https://github.com/stablyai/orca) más una serie de funciones y correcciones exclusivas del fork. La lista de funciones de upstream de más abajo sigue vigente (salvo donde aquí no se publica una build; consulta [Instalación](#instalación)); esto es lo que Orca NP añade encima. La lista completa está en los [pull requests fusionados](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged), y la serie de parches exclusivos del fork está documentada en [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md).

### Tareas, issues y Jira

- **Vista de tablero de Jira** — elige un tablero predeterminado y la pestaña de Jira muestra columnas, el sprint activo y el backlog, con arrastrar y soltar entre columnas, un cuadro de filtro y colores por prioridad.
- **Soltar en un carril se mantiene** — al soltar un elemento de Jira en un carril se resuelve la transición, se piden los campos que exige la pantalla de esa transición, y la tarjeta se mueve antes de que Jira lo confirme, revirtiendo solo si Jira lo rechaza.
- **Sprints, story points y campos personalizados** — mueve un elemento del backlog a un sprint desde su fila o el cajón del issue, define o borra los story points junto al estado, la prioridad y el responsable, y edita los campos personalizados de tipo selector de usuarios (Dev, QE) desde el detalle del issue. Un cambio de sprint hecho en el issue abierto recarga el tablero.
- **«Me» coincide con todos los campos de rol** — un issue donde eres el Dev o el QE, no solo el responsable, aparece ahora bajo el filtro Me del tablero.
- **Selector de responsable con búsqueda** — contigo y con tu equipo fijados arriba.
- **Issue vinculado en la barra lateral derecha** — un workspace creado desde un issue de Jira, Linear o GitHub recibe una pestaña Issue con estado, responsable, prioridad, etiquetas, descripción y un botón Abrir. Los issues de Jira también permiten desvincular/revincular, tienen un cuadro de comentarios en Markdown en vivo y muestran correctamente las descripciones de Jira autoalojado (Server/Data Center). Un issue de GitHub se lee del repo del que vino, así que un workspace en otro proyecto lo carga igualmente; cuando ese repo no está en esta máquina, la pestaña lo indica en lugar de fallar.
- **Vincula un workspace a un issue de Jira** con la clave o la URL desde su diálogo de detalles; la página de Tareas muestra un chip de workspace asociado y abre el workspace existente en lugar de crear un duplicado.

### Revisión de pull requests y CI

- **Comentarios de PR de GitHub en línea** — los comentarios aparecen bajo su línea en el editor, con responder, resolver y contraer (solo se muestran cuando tu checkout coincide con el commit head del PR).
- **Estado de fusión de un vistazo** — el icono del PR conserva el color de CI y añade un punto para aprobaciones pendientes, conflictos o bloqueos, con el motivo en el tooltip. Funciona con GitHub, GitLab, Bitbucket, Azure DevOps y Gitea.
- **Veredictos de revisión en el panel de Checks** — Aprobado / Cambios solicitados con los nombres de los revisores, y el panel se actualiza cuando cambia la CI en vez de esperar a cambiar de pestaña.
- **Panel de Checks en vivo** — mientras una ejecución está en curso, un panel abierto se refresca cada 10s en vez de esperar al ciclo de revisión, y espacia a 20s y luego a 30s mientras nada cambia; su veredicto actualiza la tarjeta de la barra lateral y los iconos de la barra de actividades (GitHub).
- **Detalles de builds de Jenkins** — expande un check de Jenkins para ver sus etapas, cuál está en ejecución o ha fallado, y los datos de la build.
- **Fusión como admin de PRs que requieren revisión** — si tu cuenta puede saltarse la protección de rama, se ofrece Merge tras una confirmación que indica qué se omite.

### Agentes

- **Resúmenes de sesión** — un informe escrito de una sesión de agente (actividad, objetivo, plan, bloqueos, cronología) en la barra lateral derecha, con su propio ajuste de agente/modelo. También cubre sesiones de Pi, Copilot, OpenCode y Cursor; una sesión en un host emparejado se resume en ese host, y una en un destino SSH se resume a partir de su transcripción en streaming.
- **Estado de agentes más preciso** — las filas de Pi ya no se quedan en «Working» ni pasan a «Done» cuando termina un sub-agente auxiliar; Copilot CLI ya no pide tu atención por prompts autoaprobados; un sub-agente de Grok que espera tu respuesta mantiene su fila en espera; y un panel restaurado en otro cliente descarta el aviso de «necesita información» que dejó su diálogo. Además, un sub-agente de Claude que una sesión de Pi lanza por la CLI `claude` se queda en la fila de esa sesión de Pi (requiere un plugin pi-subagents actualizado).
- **Los prompts de Copilot se leen de la pantalla** — una aprobación de shell o de URL y el diálogo «Copilot needs information» se muestran como prompts en vez de un spinner, mientras un permiso que el CLI aprobó por su cuenta pasa desapercibido.
- **El foco se queda en la pestaña del agente** — al hacer clic en una tarjeta de la barra lateral, en una pestaña de actividad de la barra lateral derecha o en el fondo del panel, el teclado vuelve a la pestaña del agente, y al cerrar un menú o un diálogo el cursor también regresa, así que la siguiente pulsación sigue significando lo que significaba.
- **El portapapeles sigue al lector** — una copia desde un panel de Pi observado desde un cliente emparejado aterriza en el portapapeles de ese cliente además del del host.
- **Agente predeterminado con un clic** — el botón `+` de la barra de pestañas lanza tu agente predeterminado; mantenlo pulsado o usa la flecha para abrir el menú completo.
- **Agent Dashboard como página** — se abre en la ventana principal con atrás/adelante, y al hacer clic en una tarjeta se abre el workspace de ese agente.
- **Historial de sesiones de agentes** — «All» ahora lista todas las sesiones, las sesiones de sub-agentes se anidan bajo su sesión padre, y la indexación de transcripciones hace buscables las transcripciones existentes. El historial de un host emparejado se carga por páginas y solo refresca lo que cambió, así que un historial remoto grande llega en lugar de fallar.
- **Seguimiento de uso para más proveedores** — presupuestos de créditos de IA de Copilot Enterprise, saldo de DeepSeek y gasto de Fireworks.ai en la barra de estado, además de un interruptor por proveedor que detiene el sondeo y la lectura de credenciales. Una sesión de Claude caducada se renueva con el refresh token guardado en lugar de quedarse en «Se actualiza cuando Claude se ejecuta», y el inicio de sesión renovado se vuelve a escribir donde Claude lo guarda.

### Workspaces y organización

- **Una carpeta por proyecto** — el checkout principal y todos sus worktrees viven juntos en una carpeta con un `AGENTS.md` compartido; `orca repo relocate` mueve allí los checkouts existentes.
- **Workspaces agrupados entre máquinas** — la misma rama en dos hosts se convierte en una sola tarjeta con un menú desplegable de host. Un workspace en un host emparejado lee su issue y su PR de GitHub desde ese host, y su punto de estado deja de girar cuando terminan los agentes del host.
- **Los clientes emparejados se mantienen al día** — los proyectos y workspaces que un host añade o elimina, incluidos los creados en la propia ventana de ese host o desde su CLI, llegan a sus clientes emparejados sin necesidad de una recarga manual.
- **Filtro de estado** — oculta los estados elegidos de la barra lateral y de Cmd+J mientras el tablero sigue mostrándolo todo.
- **Indicador «Setting up…»** mientras se ejecuta el script de configuración de un repo, también en workspaces iniciados sin agente.
- **Modos de directorios compartidos** — enlace simbólico, clon APFS, copia u omitir para los directorios compartidos entre worktrees.
- **Workspace flotante** — una carpeta propia, un asa de arrastre en la barra de título y el mismo control de lanzamiento de agentes que la barra de pestañas principal.
- **Oculta los hosts SSH importados automáticamente** de los selectores y la barra de estado; los hosts ocultos siguen listados en Ajustes.
- **Filtro de archivos más rápido y honesto** — el filtro por nombre de Explore busca en todo el workspace desde un índice precalculado, y avisa cuando los resultados son parciales en lugar de decir «no files match».
- **Replicación de ajustes entre hosts** _(base preparada)_ — los ajustes y las credenciales de proveedores de una máquina pueden replicarse a los hosts emparejados.

### Entornos efímeros

Añadidos a las recetas de entorno por workspace de upstream (Ajustes → Experimental → VM en la nube):

- **Cuenta atrás de la concesión y Extend** — una receta que publica cuándo el proveedor se lleva el host recibe una cuenta atrás en la tarjeta del workspace y en Ajustes, y, si además declara cómo ampliarla, una acción Extend limitada a las duraciones que indique. Pasado el plazo, la tarjeta y Ajustes muestran la concesión como caducada; cuando han pasado otros 15 minutos y la conexión de Orca con el host ha fallado, Orca quita el workspace de su lista y la máquina del proveedor queda sujeta a su propio vencimiento o a «Limpiar» en Ajustes.
- **Elementos de menú contextual declarados en la receta** — hasta 20 acciones que declara una receta tienen su propia entrada en el menú contextual de ese workspace y se ejecutan con el host, el nombre y la ruta del workspace. Al estar declaradas en `orca.yaml`, quedan cubiertas por la aprobación de la receta, y una receta que no declara ninguna no añade entradas.

### Fiabilidad

- Los hooks de git y la autenticación de ssh-agent funcionan cuando la app empaquetada se abre desde el Dock, porque git ahora ve las variables exportadas de tu perfil de shell.
- Los permisos de computer use en macOS ya no se dividen entre dos identidades del helper.
- Pegar con clic derecho en Copilot CLI pega una vez, no dos.
- Un diagnóstico opcional «Log UI hangs» escribe registros de bloqueos, con contexto de foco, suspensión y CPU, para ayudar a rastrear los beachballs.

### Cómo se ejecuta

- **Identidad propia** — Orca NP usa su propio app id (`com.nplez1.orca`), directorio de datos, directorio home (`~/.orca-np`) y CLI (`orca-np`), así que se instala y se ejecuta junto a un Orca oficial sin compartir estado.
- **Versiones y actualizaciones propias** — las builds se etiquetan `v<versión de upstream>-np.<n>` y el actualizador integrado sigue las [versiones de este repositorio](https://github.com/nplez1/orca/releases), no las de upstream.
- **Firma** — las builds de macOS están firmadas y notarizadas; el instalador de Windows no está firmado, así que SmartScreen avisa una vez al instalar.
- **Sin telemetría** — las notas de la versión indican que las builds no envían diagnósticos ni datos de uso.
- **Los skills apuntan a esta app** — los skills incluidos y los stubs publicados llaman a `orca-np` (y a `orca-np-dev` en desarrollo) en lugar de caer en el `orca` de una instalación oficial.
- **Perfil nuevo** — Orca NP no puede leer los repos, credenciales ni dispositivos emparejados de una instalación oficial de Orca; esa separación es deliberada, así que empareja tu teléfono con Orca NP por separado.
- **Sigue a upstream** — `main` de upstream se fusiona con regularidad (el procedimiento está en [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)), así que el fork también recibe las funciones y correcciones de upstream.

---

## Características

La lista de funciones de abajo es la de Orca upstream; sus enlaces «Docs» llevan a la documentación de upstream en onorca.dev, que no cubre las funciones exclusivas del fork de arriba.

<table>
<tr>
<td width="50%" valign="middle">

### App companion móvil

Supervisa y dirige a tus agentes desde el teléfono — recibe una notificación cuando un agente termine y envía instrucciones de seguimiento desde cualquier lugar.

[App Store de iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [APK para Android](https://www.onorca.dev/download/android) · [Docs →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca de escritorio con la app companion móvil" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees en paralelo

Lanza un mismo prompt a cinco agentes, cada uno en su propio worktree de git aislado — compara los resultados y haz merge del ganador.

[Docs →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="Orquestación de worktrees en paralelo" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminales divididas

Terminales de nivel Ghostty con renderizado WebGL, divisiones infinitas y un scrollback que sobrevive a los reinicios.

[Docs →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Terminales divididas" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Modo diseño

Haz clic en cualquier elemento de UI en una ventana real de Chromium para enviar su HTML, su CSS y una captura recortada directo al prompt de tu agente.

[Docs →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Navegador integrado y modo diseño" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub y Linear, nativos

Explora PRs, issues y tableros de proyecto dentro de la app — abre un worktree desde cualquier tarea y revisa sin cambiar de contexto.

[Docs →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Flujos de trabajo de GitHub y Linear en Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees por SSH

Ejecuta agentes en una máquina remota potente con edición completa de archivos, git y terminales — con reconexión automática y reenvío de puertos incluidos.

[Docs →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Worktrees remotos por SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Anotar diffs de IA

Deja comentarios en cualquier línea de un diff y envíalos de vuelta al agente — revisa, edita y haz commit sin salir de Orca.

[Docs →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Anotar diffs generados por IA" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Arrastra archivos a los agentes

El editor de VS Code con autoguardado en todas partes — arrastra archivos o imágenes directo al prompt de un agente.

[Docs →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Arrastra archivos e imágenes al prompt de un agente" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Los agentes también manejan Orca — automatiza cualquier flujo de trabajo con `orca worktree create`, `snapshot`, `click` y `fill`.

[Docs →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Automatiza Orca desde la CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**También incluye:**

- **[Apertura rápida](https://www.onorca.dev/docs/model/quick-open)** — Busca entre worktrees, archivos, agentes, comandos y contexto del repo sin salir de tu flujo.
- **[Cambio de cuenta y seguimiento de uso](https://www.onorca.dev/docs/agents/usage-tracking)** — Consulta el uso de Claude y Codex y los reinicios de límites de uso, y cambia de cuenta al instante sin volver a iniciar sesión.
- **[Previews ricos del repo](https://www.onorca.dev/docs/editing/markdown)** — Previsualiza Markdown, imágenes, PDFs y documentos del repo en el workspace.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Deja que los agentes manejen apps de escritorio y UI visible cuando un flujo de trabajo necesita interacción real.
- **[Notificaciones y estado de no leído](https://www.onorca.dev/docs/notifications)** — Entérate cuando un agente termine o necesite tu atención, y marca hilos como no leídos para retomarlos después.
- **Y muchas, muchas más** — lanzamos a diario, así que esta lista siempre va atrasada. Las [versiones de Orca NP](https://github.com/nplez1/orca/releases) son la verdadera lista de funciones de este fork, y las [de upstream](https://github.com/stablyai/orca/releases) lo son para todo lo que hereda.

---

## Agentes compatibles

Funciona con **cualquier agente CLI** — si corre en una terminal, corre en Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

---

## Instalación

### Escritorio — macOS, Windows

- **[Descarga la última versión de Orca NP](https://github.com/nplez1/orca/releases/latest)**
- O descarga un build directamente: [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [Todos los builds](https://github.com/nplez1/orca/releases)

Orca NP se instala junto a un Orca oficial y se actualiza desde las versiones de este repositorio. Este fork no publica un build para Linux ni un paquete de Homebrew/AUR: en Linux, [compila desde el código fuente](../../.github/CONTRIBUTING.md) o usa [Orca upstream](https://github.com/stablyai/orca/releases/latest).

### App companion móvil — iOS, Android

Vincula la app móvil de Orca con Orca NP para supervisar y dirigir a tus agentes desde el teléfono. Las apps las publica Orca upstream y funcionan con Orca NP.

- **iOS:** [Descargar desde App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Descargar el APK](https://www.onorca.dev/download/android)

---

## Comunidad y soporte

- **Issues e ideas de Orca NP:** [Abre un issue](https://github.com/nplez1/orca/issues) para cualquier cosa específica de este fork.
- **Comunidad de upstream:** los canales de Orca upstream cubren todo lo que este fork hereda: [Discord](https://discord.gg/fzjDKHxv8Q), [@orca_build en X](https://x.com/orca_build) y los [issues de upstream](https://github.com/stablyai/orca/issues) para bugs que también se reproducen en el Orca oficial.
- **Docs:** [onorca.dev/docs](https://www.onorca.dev/docs) documenta Orca upstream.
- **Muéstranos tu apoyo:** Dale una [estrella](https://github.com/nplez1/orca) a este repo para seguir el fork, o a [upstream](https://github.com/stablyai/orca).

---

## Desarrollo

¿Quieres contribuir o ejecutar Orca localmente? Consulta nuestra guía [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Contribuidores de Orca" />
</a>

## Licencia

Orca es libre y de código abierto bajo la [Licencia MIT](../../LICENSE).
