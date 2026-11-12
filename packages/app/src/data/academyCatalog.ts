/**
 * Academy Catalog — static content (TER-716)
 *
 * Source of truth for the Academy section: learning phases + videotutorials.
 * NOT synced with Notion or any backend. To add a video, append one AcademyVideo
 * object with objective/steps/transcript in BOTH `en` and `es`.
 *
 * Real catalog (2026-09): 28 recorded tutorials. YouTube titles use the global
 * numbering "NNN. Title" (001-030 — 004 and 024 were never recorded). `number`
 * keeps that global numbering so the in-app card matches the YouTube title.
 * Transcripts are interim synopses of each video; full transcripts pending.
 *
 * Video content is bilingual (EN/ES, switched by the detail-view toggle). Phase
 * titles/descriptions stay in Spanish. UI chrome is translated separately via i18n.
 */

export type PhaseId =
  | 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase5'
  | 'phase6' | 'phase7' | 'phase8' | 'phase9';

/** Content language for a video (independent of the UI/i18n language). */
export type ContentLang = 'en' | 'es';

export interface LocalizedText { en: string; es: string }
export interface LocalizedSteps { en: string[]; es: string[] }

export interface AcademyPhase {
  id: PhaseId;
  order: number;
  title: string;
  description: string;
}

export interface AcademyVideo {
  id: string;
  number: number;
  phase: PhaseId;
  title: string;
  objective: LocalizedText;
  steps: LocalizedSteps;
  youtubeId: string;
  transcript: LocalizedText;
}

export const ACADEMY_PHASES: AcademyPhase[] = [
  { id: 'phase1', order: 1, title: 'FASE 1 — Primeros Pasos (Onboarding)', description: 'Registro, provider LLM, primer mensaje, asistente de configuración.' },
  { id: 'phase2', order: 2, title: 'FASE 2 — Apps y Herramientas', description: 'Catálogo de apps, instalar/configurar, OAuth vs API key, permisos de tools.' },
  { id: 'phase3', order: 3, title: 'FASE 3 — Agentes', description: 'Crear, personalizar, elegir modelo, eliminar.' },
  { id: 'phase4', order: 4, title: 'FASE 4 — Skills e Instrucciones', description: 'Crear skills y asignarlas a agentes.' },
  { id: 'phase5', order: 5, title: 'FASE 5 — Archivos y Media', description: 'Subir archivos, explorador, visualizadores, compartir con enlace, guardar en workspace.' },
  { id: 'phase6', order: 6, title: 'FASE 6 — Boards, Proyectos y Autorun', description: 'Proyecto/Kanban, tareas, dependencias, autorun, revisión, límites de seguridad.' },
  { id: 'phase7', order: 7, title: 'FASE 7 — Workspaces y Colaboración', description: 'Crear workspace compartido, invitar miembros/roles, cambiar de workspace, mover conversaciones.' },
  { id: 'phase8', order: 8, title: 'FASE 8 — Voz y Extras', description: 'Modo voz, recordatorios, perfil.' },
  { id: 'phase9', order: 9, title: 'FASE 9 — Avanzado / Power User', description: 'Tiling layout, borradores, agentes especializados, delegación, consumo de tokens, errores frecuentes.' },
];

export const ACADEMY_VIDEOS: AcademyVideo[] = [
  // ── FASE 1 — Primeros Pasos (Onboarding) ─────────────────────────────────
  {
    id: 'video-001', number: 1, phase: 'phase1',
    title: 'Registration and Access to Teros',
    youtubeId: 't347bIJQC00',
    objective: {
      en: 'Learn how to sign up on Teros and get access to the platform, from creating your account to entering the app for the first time.',
      es: 'Aprende a registrarte en Teros y conseguir acceso a la plataforma, desde crear tu cuenta hasta entrar en la app por primera vez.',
    },
    steps: {
      en: ['Go to the Teros sign-up page', 'Create your account', 'Enter the app for the first time'],
      es: ['Ve a la página de registro de Teros', 'Crea tu cuenta', 'Entra en la app por primera vez'],
    },
    transcript: {
      en: 'Walkthrough of the Teros registration flow and first access to the platform.',
      es: 'Recorrido por el flujo de registro de Teros y el primer acceso a la plataforma.',
    },
  },
  {
    id: 'video-002', number: 2, phase: 'phase1',
    title: 'Add Provider',
    youtubeId: 'kO1wotURbis',
    objective: {
      en: 'Connect your first LLM provider to Teros: where to add your API key, how to pick a provider, and how to check everything is ready.',
      es: 'Conecta tu primer provider LLM a Teros: dónde añadir tu API key, cómo elegir provider y cómo comprobar que todo está listo.',
    },
    steps: {
      en: ['Open the Providers window', 'Add your API key', 'Verify the provider is ready'],
      es: ['Abre la ventana de Providers', 'Añade tu API key', 'Verifica que el provider está listo'],
    },
    transcript: {
      en: 'How to add an LLM provider with its API key and get the workspace ready for its first conversation.',
      es: 'Cómo añadir un provider LLM con su API key y dejar el workspace listo para su primera conversación.',
    },
  },
  {
    id: 'video-003', number: 3, phase: 'phase1',
    title: 'First Message with Iria',
    youtubeId: 'q8T-YA2bWac',
    objective: {
      en: 'Send your first message in Teros and meet Iria, your super agent — what she can do out of the box and how she helps you set up the platform.',
      es: 'Envía tu primer mensaje en Teros y conoce a Iria, tu super agente — qué puede hacer de serie y cómo te ayuda a configurar la plataforma.',
    },
    steps: {
      en: ['Open your first conversation', 'Send a message to Iria', 'See what she can do for you'],
      es: ['Abre tu primera conversación', 'Envía un mensaje a Iria', 'Descubre qué puede hacer por ti'],
    },
    transcript: {
      en: 'First conversation with Iria, the Teros super agent, and an overview of what she can do.',
      es: 'Primera conversación con Iria, la super agente de Teros, y repaso de lo que puede hacer.',
    },
  },
  {
    id: 'video-010', number: 10, phase: 'phase1',
    title: 'Your Super Agent can configure Teros for you',
    youtubeId: 'UyhOgVTsy-Y',
    objective: {
      en: 'Let your super agent do the setup for you: ask in plain language to install an app, create an agent or connect a provider.',
      es: 'Deja que tu super agente haga la configuración por ti: pídele en lenguaje natural instalar una app, crear un agente o conectar un provider.',
    },
    steps: {
      en: ['Ask for what you need in chat', 'Watch the agent run the flow', 'Confirm the result'],
      es: ['Pide lo que necesites en el chat', 'Observa cómo el agente ejecuta el flujo', 'Confirma el resultado'],
    },
    transcript: {
      en: 'Using the super agent to configure Teros: installing apps, creating agents and connecting providers from chat.',
      es: 'Usar el super agente para configurar Teros: instalar apps, crear agentes y conectar providers desde el chat.',
    },
  },

  // ── FASE 2 — Apps y Herramientas ─────────────────────────────────────────
  {
    id: 'video-005', number: 5, phase: 'phase2',
    title: 'Configure an Installed App',
    youtubeId: '4a1gGNjIUKA',
    objective: {
      en: 'Configure an app you have installed so your agent can actually use it: app settings, what each option means, and how to verify the connection.',
      es: 'Configura una app instalada para que tu agente pueda usarla: ajustes de la app, qué significa cada opción y cómo verificar la conexión.',
    },
    steps: {
      en: ['Open the app settings', 'Review each option', 'Verify the connection works'],
      es: ['Abre los ajustes de la app', 'Revisa cada opción', 'Verifica que la conexión funciona'],
    },
    transcript: {
      en: 'Configuring an installed app and checking that the connection works before using it in a conversation.',
      es: 'Configurar una app instalada y comprobar que la conexión funciona antes de usarla en una conversación.',
    },
  },
  {
    id: 'video-006', number: 6, phase: 'phase2',
    title: 'Connect your accounts with OAuth',
    youtubeId: 'lmvM6Oj1UJw',
    objective: {
      en: 'Connect external accounts like Gmail or Google Drive with OAuth — one click, no API keys, and your agent works with your real data.',
      es: 'Conecta cuentas externas como Gmail o Google Drive con OAuth — un clic, sin API keys, y tu agente trabaja con tus datos reales.',
    },
    steps: {
      en: ['Pick the app in the catalog', 'Authorize with OAuth', 'Check the connected account'],
      es: ['Elige la app en el catálogo', 'Autoriza con OAuth', 'Comprueba la cuenta conectada'],
    },
    transcript: {
      en: 'Connecting external accounts via OAuth and getting agents ready to work with real data.',
      es: 'Conectar cuentas externas vía OAuth y dejar a los agentes listos para trabajar con datos reales.',
    },
  },
  {
    id: 'video-007', number: 7, phase: 'phase2',
    title: 'Give your Agent Access to an App',
    youtubeId: 'Cr6gnslisxw',
    objective: {
      en: 'Grant your agent access to an installed app — how app access works, why agents only see what you give them, and how to test it.',
      es: 'Da a tu agente acceso a una app instalada — cómo funciona el acceso, por qué los agentes solo ven lo que les das, y cómo probarlo.',
    },
    steps: {
      en: ['Open the agent app access', 'Grant access to the app', 'Test it in a conversation'],
      es: ['Abre el acceso a apps del agente', 'Concede acceso a la app', 'Pruébalo en una conversación'],
    },
    transcript: {
      en: 'Granting app access to an agent and testing the connection in a real conversation.',
      es: 'Conceder acceso a una app a un agente y probar la conexión en una conversación real.',
    },
  },
  {
    id: 'video-008', number: 8, phase: 'phase2',
    title: 'Manage your Tool Permissions',
    youtubeId: 'ayvU5kPd8JQ',
    objective: {
      en: 'Control exactly what your agent can do: the permission system — allow, ask or block per tool — and how to keep full control of every action.',
      es: 'Controla exactamente qué puede hacer tu agente: el sistema de permisos — allow, ask o block por tool — y cómo mantener el control de cada acción.',
    },
    steps: {
      en: ['Open tool permissions', 'Set allow / ask / block per tool', 'Understand what each level means'],
      es: ['Abre los permisos de tools', 'Configura allow / ask / block por tool', 'Entiende qué significa cada nivel'],
    },
    transcript: {
      en: 'The Teros tool permission system: allow, ask and block, and how to stay in control of agent actions.',
      es: 'El sistema de permisos de tools de Teros: allow, ask y block, y cómo mantener el control sobre las acciones de los agentes.',
    },
  },
  {
    id: 'video-009', number: 9, phase: 'phase2',
    title: 'API key vs OAuth When to use each one',
    youtubeId: 'WDeIXeLATPg',
    objective: {
      en: 'API key or OAuth? The difference between both connection methods, when each one makes sense, and what it means for security and control.',
      es: '¿API key u OAuth? La diferencia entre ambos métodos de conexión, cuándo tiene sentido cada uno y qué implica para seguridad y control.',
    },
    steps: {
      en: ['Understand what an API key is', 'Understand what OAuth gives you', 'Pick the right method per app'],
      es: ['Entiende qué es una API key', 'Entiende qué te da OAuth', 'Elige el método adecuado por app'],
    },
    transcript: {
      en: 'Comparison of API keys and OAuth as connection methods, and guidance on when to use each.',
      es: 'Comparación de API keys y OAuth como métodos de conexión, y guía sobre cuándo usar cada uno.',
    },
  },

  // ── FASE 3 — Agentes ──────────────────────────────────────────────────────
  {
    id: 'video-011', number: 11, phase: 'phase3',
    title: 'Create your first Agent',
    youtubeId: 'tNo9BTJp5OM',
    objective: {
      en: 'Create your first specialized agent in Teros: pick a name, a role and a personality, and get a dedicated assistant for a specific job.',
      es: 'Crea tu primer agente especializado en Teros: elige nombre, rol y personalidad, y ten un asistente dedicado a un trabajo concreto.',
    },
    steps: {
      en: ['Open the create-agent window', 'Fill in name, role and personality', 'Start its first conversation'],
      es: ['Abre la ventana de crear agente', 'Rellena nombre, rol y personalidad', 'Inicia su primera conversación'],
    },
    transcript: {
      en: 'Creating a first specialized agent and starting a conversation with it.',
      es: 'Crear un primer agente especializado e iniciar una conversación con él.',
    },
  },
  {
    id: 'video-012', number: 12, phase: 'phase3',
    title: 'Customize your Agent',
    youtubeId: 'ChLDQ_4aFoo',
    objective: {
      en: 'Make each agent yours: avatar, name, role, instructions and context — what every field does and how small prompt changes shape behavior.',
      es: 'Haz tuyo cada agente: avatar, nombre, rol, instrucciones y contexto — qué hace cada campo y cómo pequeños cambios moldean el comportamiento.',
    },
    steps: {
      en: ['Edit identity and role', 'Write instructions and context', 'See how behavior changes'],
      es: ['Edita identidad y rol', 'Escribe instrucciones y contexto', 'Observa cómo cambia el comportamiento'],
    },
    transcript: {
      en: 'Customizing an agent: identity fields, instructions and context, and their effect on behavior.',
      es: 'Personalizar un agente: campos de identidad, instrucciones y contexto, y su efecto en el comportamiento.',
    },
  },
  {
    id: 'video-013', number: 13, phase: 'phase3',
    title: 'Choose Your Agent Model',
    youtubeId: 'aW1HrvMSv7s',
    objective: {
      en: 'Pick the right LLM for each agent: how providers and models relate, and how to balance cost, speed and quality depending on the job.',
      es: 'Elige el LLM adecuado para cada agente: cómo se relacionan providers y modelos, y cómo equilibrar coste, velocidad y calidad según el trabajo.',
    },
    steps: {
      en: ['Open the model settings', 'Compare available models', 'Assign the model per agent'],
      es: ['Abre los ajustes de modelo', 'Compara los modelos disponibles', 'Asigna el modelo a cada agente'],
    },
    transcript: {
      en: 'Choosing models per agent and the trade-offs between cost, speed and quality.',
      es: 'Elegir modelos por agente y los equilibrios entre coste, velocidad y calidad.',
    },
  },
  {
    id: 'video-014', number: 14, phase: 'phase3',
    title: 'Delete an Agent',
    youtubeId: 'GG7WKs0Xu4s',
    objective: {
      en: 'Clean up agents you no longer need: how deleting works, what happens to conversations, and when archiving is the better option.',
      es: 'Limpia los agentes que ya no necesitas: cómo funciona el borrado, qué pasa con las conversaciones y cuándo es mejor archivar.',
    },
    steps: {
      en: ['Find the agent to remove', 'Delete or archive it', 'Understand what happens to its data'],
      es: ['Localiza el agente a eliminar', 'Bórralo o archívalo', 'Entiende qué pasa con sus datos'],
    },
    transcript: {
      en: 'Deleting agents, what happens to their conversations, and archiving as an alternative.',
      es: 'Borrar agentes, qué pasa con sus conversaciones, y archivar como alternativa.',
    },
  },

  // ── FASE 4 — Skills e Instrucciones ──────────────────────────────────────
  {
    id: 'video-015', number: 15, phase: 'phase4',
    title: 'Create a Skill',
    youtubeId: 'QpV8h3P4acQ',
    objective: {
      en: 'Create your first skill: a reusable block of instructions your agents can load on demand. Write it once and reuse it everywhere.',
      es: 'Crea tu primera skill: un bloque reutilizable de instrucciones que tus agentes pueden cargar a demanda. Escríbela una vez y reutilízala.',
    },
    steps: {
      en: ['Open the Skills window', 'Write the skill content', 'Save it for reuse'],
      es: ['Abre la ventana de Skills', 'Escribe el contenido de la skill', 'Guárdala para reutilizarla'],
    },
    transcript: {
      en: 'Creating a reusable skill and how skills store instructions for agents.',
      es: 'Crear una skill reutilizable y cómo las skills guardan instrucciones para agentes.',
    },
  },
  {
    id: 'video-016', number: 16, phase: 'phase4',
    title: 'Assign Skills to your Agent',
    youtubeId: '9DG2Be3WuWY',
    objective: {
      en: 'Assign skills to your agents and toggle them per agent — combine multiple skills to build specialized assistants without duplicating instructions.',
      es: 'Asigna skills a tus agentes y actívalas por agente — combina varias skills para construir asistentes especializados sin duplicar instrucciones.',
    },
    steps: {
      en: ['Open the agent skills list', 'Assign the skills it needs', 'Enable or disable per agent'],
      es: ['Abre la lista de skills del agente', 'Asigna las que necesita', 'Actívalas o desactívalas por agente'],
    },
    transcript: {
      en: 'Assigning and toggling skills per agent to compose specialized assistants.',
      es: 'Asignar y activar skills por agente para componer asistentes especializados.',
    },
  },

  // ── FASE 5 — Archivos y Media ────────────────────────────────────────────
  {
    id: 'video-017', number: 17, phase: 'phase5',
    title: 'Upload files to the Chat',
    youtubeId: 'nJhIKCKBvek',
    objective: {
      en: 'Upload files to any conversation — images, documents, PDFs and more — and let your agent read them and act on the content.',
      es: 'Sube archivos a cualquier conversación — imágenes, documentos, PDFs y más — y deja que tu agente los lea y actúe sobre su contenido.',
    },
    steps: {
      en: ['Attach a file in the composer', 'Send it with your message', 'Ask the agent about the file'],
      es: ['Adjunta un archivo en el composer', 'Envíalo con tu mensaje', 'Pregunta al agente por el archivo'],
    },
    transcript: {
      en: 'Uploading files to a conversation and having the agent work with their content.',
      es: 'Subir archivos a una conversación y hacer que el agente trabaje con su contenido.',
    },
  },
  {
    id: 'video-018', number: 18, phase: 'phase5',
    title: 'The File Explorer',
    youtubeId: 'Egi_C_li0co',
    objective: {
      en: 'Browse your workspace volume with the file explorer: navigate folders, preview files and run quick actions without leaving Teros.',
      es: 'Navega el volumen de tu workspace con el explorador de archivos: carpetas, previsualizaciones y acciones rápidas sin salir de Teros.',
    },
    steps: {
      en: ['Open the file explorer', 'Navigate the workspace folders', 'Use quick actions on files'],
      es: ['Abre el explorador de archivos', 'Navega las carpetas del workspace', 'Usa acciones rápidas sobre archivos'],
    },
    transcript: {
      en: 'Tour of the file explorer: folders, previews and quick actions in the workspace volume.',
      es: 'Tour por el explorador de archivos: carpetas, previsualizaciones y acciones rápidas en el volumen del workspace.',
    },
  },
  {
    id: 'video-019', number: 19, phase: 'phase5',
    title: 'View files HTML, Markdown, and code',
    youtubeId: '4zHRpQUew-w',
    objective: {
      en: 'Open files in dedicated viewers: HTML with live preview, Markdown rendered as formatted text, and code with syntax highlighting.',
      es: 'Abre archivos en visores dedicados: HTML con previsualización en vivo, Markdown renderizado y código con resaltado de sintaxis.',
    },
    steps: {
      en: ['Open a file from the explorer', 'Pick the right viewer', 'Interact with the preview'],
      es: ['Abre un archivo desde el explorador', 'Elige el visor adecuado', 'Interactúa con la previsualización'],
    },
    transcript: {
      en: 'The HTML, Markdown and code viewers and how each renders workspace files.',
      es: 'Los visores de HTML, Markdown y código, y cómo cada uno renderiza los archivos del workspace.',
    },
  },
  {
    id: 'video-020', number: 20, phase: 'phase5',
    title: 'Share a file with Public Link',
    youtubeId: 'SDu51A-_oDk',
    objective: {
      en: 'Share any workspace file with a public link: create the URL, send it to anyone — even outside Teros — and revoke access whenever you want.',
      es: 'Comparte cualquier archivo del workspace con un enlace público: crea la URL, envíala a quien quieras — incluso fuera de Teros — y revoca el acceso cuando quieras.',
    },
    steps: {
      en: ['Generate the public link', 'Share the URL', 'Revoke access when done'],
      es: ['Genera el enlace público', 'Comparte la URL', 'Revoca el acceso al terminar'],
    },
    transcript: {
      en: 'Creating, sharing and revoking public links for workspace files.',
      es: 'Crear, compartir y revocar enlaces públicos para archivos del workspace.',
    },
  },
  {
    id: 'video-021', number: 21, phase: 'phase5',
    title: 'Save chat files to Workspace',
    youtubeId: '7d8aN6jynxA',
    objective: {
      en: 'Save the files your agent generates in chat — reports, images, code — to your workspace volume, so they persist and stay organized.',
      es: 'Guarda en el volumen del workspace los archivos que tu agente genera en el chat — informes, imágenes, código — para que persistan y queden organizados.',
    },
    steps: {
      en: ['Generate a file in chat', 'Save it to the workspace', 'Find it in the explorer'],
      es: ['Genera un archivo en el chat', 'Guárdalo en el workspace', 'Encuéntralo en el explorador'],
    },
    transcript: {
      en: 'Saving chat-generated files to the workspace volume and finding them later.',
      es: 'Guardar en el volumen del workspace los archivos generados en el chat y encontrarlos después.',
    },
  },

  // ── FASE 6 — Boards, Proyectos y Autorun ─────────────────────────────────
  {
    id: 'video-022', number: 22, phase: 'phase6',
    title: 'Create a project and its Kanban board',
    youtubeId: 'shZAW9BNVL8',
    objective: {
      en: 'Create a project and get its Kanban board automatically: columns, tasks and a single source of truth for the work of your team and agents.',
      es: 'Crea un proyecto y obtén su tablero Kanban automáticamente: columnas, tareas y una única fuente de verdad para el trabajo de tu equipo y tus agentes.',
    },
    steps: {
      en: ['Create a new project', 'See its Kanban board', 'Understand the default columns'],
      es: ['Crea un proyecto nuevo', 'Mira su tablero Kanban', 'Entiende las columnas por defecto'],
    },
    transcript: {
      en: 'Creating a project and the Kanban board that comes with it.',
      es: 'Crear un proyecto y el tablero Kanban que lo acompaña.',
    },
  },
  {
    id: 'video-023', number: 23, phase: 'phase6',
    title: 'Manage Tasks on the Board',
    youtubeId: 'GPVF1wE0YYw',
    objective: {
      en: 'Manage tasks on the board: create them, assign owners, set priorities and move work across columns as it progresses.',
      es: 'Gestiona tareas en el tablero: créalas, asigna responsables, marca prioridades y mueve el trabajo entre columnas según avanza.',
    },
    steps: {
      en: ['Create a task', 'Assign it and set priority', 'Move it across columns'],
      es: ['Crea una tarea', 'Asígnala y marca la prioridad', 'Muévela entre columnas'],
    },
    transcript: {
      en: 'Task lifecycle on the board: creation, assignment, priority and column moves.',
      es: 'Ciclo de vida de una tarea en el tablero: creación, asignación, prioridad y movimiento entre columnas.',
    },
  },
  {
    id: 'video-025', number: 25, phase: 'phase6',
    title: 'Autorun mode',
    youtubeId: '_S5ZcYCJ5_E',
    objective: {
      en: 'Turn on autorun and let your agents pick up tasks by themselves: how slots control parallel execution — and how you keep the last word.',
      es: 'Activa autorun y deja que tus agentes tomen tareas por sí mismos: cómo los slots controlan la ejecución en paralelo — y cómo tú tienes la última palabra.',
    },
    steps: {
      en: ['Enable autorun for an agent', 'Understand slots and limits', 'Watch it pick up tasks'],
      es: ['Activa autorun para un agente', 'Entiende los slots y sus límites', 'Observa cómo toma tareas'],
    },
    transcript: {
      en: 'Autorun mode: slots, parallel execution limits and how agents self-assign board tasks.',
      es: 'Modo autorun: slots, límites de ejecución en paralelo y cómo los agentes se autoasignan tareas del tablero.',
    },
  },
  {
    id: 'video-026', number: 26, phase: 'phase6',
    title: 'Review and Approve the work of Agent',
    youtubeId: '0zwJbhQ2F1E',
    objective: {
      en: 'Review what your agents did before it counts as done: the review column, reading progress notes, and approving or sending work back.',
      es: 'Revisa lo que hicieron tus agentes antes de darlo por hecho: la columna de revisión, leer las notas de progreso, y aprobar o devolver el trabajo.',
    },
    steps: {
      en: ['Open the review column', 'Read the progress notes', 'Approve or send back'],
      es: ['Abre la columna de revisión', 'Lee las notas de progreso', 'Aprueba o devuelve el trabajo'],
    },
    transcript: {
      en: 'The review flow for agent work: notes, approval and rejection on the board.',
      es: 'El flujo de revisión del trabajo de los agentes: notas, aprobación y rechazo en el tablero.',
    },
  },

  // ── FASE 7 — Workspaces y Colaboración ───────────────────────────────────
  {
    id: 'video-027', number: 27, phase: 'phase7',
    title: 'Switch between Workspaces',
    youtubeId: 'mGNWjapEuhY',
    objective: {
      en: 'Create and switch between workspaces: separate contexts for different projects or teams — what lives inside each and how to move around.',
      es: 'Crea y cambia entre workspaces: contextos separados para distintos proyectos o equipos — qué vive en cada uno y cómo moverse entre ellos.',
    },
    steps: {
      en: ['Open the workspaces menu', 'Switch to another workspace', 'See what changes with it'],
      es: ['Abre el menú de workspaces', 'Cambia a otro workspace', 'Mira qué cambia con él'],
    },
    transcript: {
      en: 'Switching workspaces and what each workspace contains.',
      es: 'Cambiar de workspace y qué contiene cada workspace.',
    },
  },

  // ── FASE 8 — Voz y Extras ────────────────────────────────────────────────
  {
    id: 'video-028', number: 28, phase: 'phase8',
    title: 'Create Reminders with your Agent',
    youtubeId: 'izeI9VtcquU',
    objective: {
      en: 'Ask your agent to set reminders and recurring tasks: one-shot or repeating, they arrive in your chat at the right time so nothing falls through.',
      es: 'Pide a tu agente que cree recordatorios y tareas recurrentes: de una vez o repetidos, llegan a tu chat en el momento justo para que no se te escape nada.',
    },
    steps: {
      en: ['Ask for a reminder in chat', 'Set it one-shot or recurring', 'Receive it at the right time'],
      es: ['Pide un recordatorio en el chat', 'Configúralo único o recurrente', 'Recíbelo en el momento justo'],
    },
    transcript: {
      en: 'Creating one-shot and recurring reminders with your agent.',
      es: 'Crear recordatorios únicos y recurrentes con tu agente.',
    },
  },
  {
    id: 'video-029', number: 29, phase: 'phase8',
    title: 'Configure your Profile',
    youtubeId: 'ax7bJfqv_0U',
    objective: {
      en: 'Set up your profile: name, avatar, language and account preferences — small settings that make Teros feel like yours.',
      es: 'Configura tu perfil: nombre, avatar, idioma y preferencias de cuenta — pequeños ajustes que hacen que Teros se sienta tuyo.',
    },
    steps: {
      en: ['Open your profile', 'Set name and avatar', 'Adjust preferences'],
      es: ['Abre tu perfil', 'Configura nombre y avatar', 'Ajusta las preferencias'],
    },
    transcript: {
      en: 'Profile settings: name, avatar, language and account preferences.',
      es: 'Ajustes del perfil: nombre, avatar, idioma y preferencias de cuenta.',
    },
  },

  // ── FASE 9 — Avanzado / Power User ───────────────────────────────────────
  {
    id: 'video-030', number: 30, phase: 'phase9',
    title: 'Windows and Splits tiling layout',
    youtubeId: 'LbExTbr21ig',
    objective: {
      en: 'Master the tiling layout: open windows, split the screen and arrange everything side by side to multitask across chats, boards and files.',
      es: 'Domina el tiling layout: abre ventanas, divide la pantalla y coloca todo en paralelo para hacer multitarea entre chats, tableros y archivos.',
    },
    steps: {
      en: ['Open multiple windows', 'Split the screen', 'Arrange your layout'],
      es: ['Abre varias ventanas', 'Divide la pantalla', 'Ordena tu layout'],
    },
    transcript: {
      en: 'The tiling window system: splits, layout arrangement and multitasking in Teros.',
      es: 'El sistema de ventanas en tiling: splits, organización del layout y multitarea en Teros.',
    },
  },
];

export function getPhase(id: PhaseId): AcademyPhase | undefined {
  return ACADEMY_PHASES.find((p) => p.id === id);
}

const phaseOrder = (id: PhaseId): number => getPhase(id)?.order ?? 999;

export function getVideosByPhase(phase: PhaseId): AcademyVideo[] {
  return ACADEMY_VIDEOS.filter((v) => v.phase === phase).sort((a, b) => a.number - b.number);
}

export function filterVideos(phase: PhaseId | 'all', query: string): AcademyVideo[] {
  const q = query.trim().toLowerCase();
  return ACADEMY_VIDEOS
    .filter((v) => (phase === 'all' ? true : v.phase === phase))
    .filter((v) =>
      q === ''
        ? true
        : v.title.toLowerCase().includes(q) ||
          v.objective.en.toLowerCase().includes(q) ||
          v.objective.es.toLowerCase().includes(q),
    )
    .sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase) || a.number - b.number);
}

export function getAdjacentVideos(videoId: string): { prev: AcademyVideo | null; next: AcademyVideo | null } {
  const video = ACADEMY_VIDEOS.find((v) => v.id === videoId);
  if (!video) return { prev: null, next: null };
  const siblings = getVideosByPhase(video.phase);
  const idx = siblings.findIndex((v) => v.id === videoId);
  return {
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx < siblings.length - 1 ? siblings[idx + 1] : null,
  };
}

export function localize(text: LocalizedText, lang: ContentLang): string {
  return text[lang];
}

export function localizeSteps(steps: LocalizedSteps, lang: ContentLang): string[] {
  return steps[lang];
}

export function resolveContentLang(uiLanguage: string): ContentLang {
  return uiLanguage.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export function youtubeEmbedUrl(youtubeId: string): string {
  return `https://www.youtube-nocookie.com/embed/${youtubeId}`;
}

export function youtubeThumbnailUrl(youtubeId: string): string {
  return `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
}
