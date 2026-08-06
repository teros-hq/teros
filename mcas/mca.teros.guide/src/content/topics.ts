/**
 * Teros platform guide — agent-oriented distillation.
 *
 * This is the SOURCE the agent consumes to instruct the user on how to use
 * Teros. It is NOT the human-facing prose of 
 * ("click here…"); it is rewritten as "for need X → use window/action Y" so the
 * agent can translate it into natural language for the user, in the user's own
 * language.
 *
 * Kept in TypeScript (not a loose .md) on purpose: type-safe, testable, and
 * robust inside the MCA container (no runtime file IO / path resolution). The
 * content is versioned in git and reviewed in PR. If we ever need to edit it
 * without a redeploy, Phase 2 moves it to DB/volume (see TER-583).
 *
 * Editing rules:
 *  - `id` is a STABLE kebab-case key. It is the enum value `get-guide-section`
 *    accepts. Renaming an id is a breaking change for the tool surface.
 *  - `summary` is one line for the index (`list-guide-topics`); keep it short.
 *  - `body` is agent-oriented markdown. Use the REAL window/action names the
 *    user sees in the UI (Create Agent, Providers, Catalog, Board…).
 *  - Keep it faithful to USER_GUIDE.md. When the platform changes, update both.
 */

export interface GuideTopic {
  /** Stable kebab-case id. The enum value `get-guide-section` accepts. */
  id: string;
  /** Short human title. */
  title: string;
  /** One-line description for the index (`list-guide-topics`). */
  summary: string;
  /** Synonyms/keywords to help the agent pick the right topic (hint only, no embeddings). */
  keywords: string[];
  /** Agent-oriented markdown: "for need X → use window/action Y", real UI names. */
  body: string;
  /** Related topic ids to suggest as follow-ups. */
  related?: string[];
}

export const GUIDE_TOPICS: GuideTopic[] = [
  {
    id: 'overview',
    title: 'What Teros is',
    summary: 'What Teros is, the problem it solves, and the core concepts (agent, workspace, channel, board, MCA/app, provider).',
    keywords: ['what is teros', 'overview', 'concepts', 'glossary', 'terms', 'mca', 'app', 'definitions'],
    body: `# What Teros is

Teros is a platform where the user creates **personalized AI assistants (agents)** that can act, not just answer. Unlike a plain chatbot, a Teros agent can connect to the user's apps (Gmail, Calendar, GitHub, Notion, Linear, and many more), work on Kanban boards, remember things and wake itself up, talk by voice, and collaborate with other people inside a shared workspace. Teros is currently in **private alpha**.

## Core concepts (use these exact terms when explaining)
- **Agent** — an AI assistant with a personality, an LLM model, granted apps and skills. The user's main unit of work. A default agent named **Iria Devon** is created at signup.
- **Workspace** — a collaborative space with its own files, agents, apps, members and boards. **Everything in Teros is scoped to a workspace**; switching workspace changes which chats, agents, apps and boards are visible. Each user gets a **private workspace** at signup that cannot be deleted or archived.
- **Channel / Chat** — a conversation between the user and an agent (or between agents in autorun).
- **Project / Board / Task** — a project has a Kanban **board** with columns (Backlog, To Do, In Progress, Blocked, Review, Done); each **task** lives in a column and can be assigned to an agent.
- **MCA / App** — the same thing. An "MCA" is the technical plugin that exposes **tools**; in the UI it is called an "app". It can be an external integration (Gmail, GitHub…) or an internal Teros utility (Filesystem, Memory…).
- **Tool** — one concrete action an agent can run (read an email, create an issue, list files). Each app exposes several tools.
- **Provider** — an AI model credential (Anthropic, OpenAI, Gemini…). It is what makes the agent "think". Teros supports 16 provider types.
- **Skill** — a reusable block of instructions assignable to several agents.

> Alpha caveat: features may change without notice — tell the user not to store critical data yet.`,
    related: ['getting-started', 'agents', 'apps-and-providers'],
  },
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'How to access, sign up, the waitlist, the onboarding steps, and connecting the first LLM provider so the agent can respond.',
    keywords: ['access', 'sign up', 'signup', 'register', 'login', 'waitlist', 'onboarding', 'first steps', 'private beta', 'google login'],
    body: `# Getting started

## Access & sign up
- Open **https://os.teros.ai** in a modern browser. Teros is a PWA, so it can be installed as a standalone app from the browser menu ("Install Teros…").
- Access is invite-only during the private alpha.
- Sign up needs **email**, **password (min. 8 chars)**, and a **display name**. After **5 failed logins** the account is locked for 15 minutes.
- "Continue with Google" also works (popup → authorize). GitHub and Microsoft show as "SOON" and are not active yet.

At signup the user automatically gets: a welcome email from \`hello@teros.ai\`, a default agent **Iria Devon**, and a **private workspace** (cannot be deleted/archived).

## Waitlist (Private Beta)
New accounts start **waitlisted**: instead of the app they see a "Private Beta" screen. A founder must grant access; an email arrives when approved. After approval, **reloading the page** enters the app — no re-login needed. The message "Platform access not granted" means still waitlisted.

## First 5 minutes / onboarding
> The automatic setup **wizard is temporarily disabled** in the current alpha — the user lands directly on the desktop and must configure a provider manually before sending messages.

The recommended setup, in order:
1. **Provider (required to think)** — connect an LLM. See the apps-and-providers topic. Without a provider the agent cannot reply.
2. **About you (optional)** — pick a use case and a preferred name (max 40 chars).
3. **Apps (optional)** — install apps the agent will use (e.g. Web Fetch, Bash, Filesystem, Gmail, Notion, GitHub).
4. **Access (optional)** — toggle ON which installed apps the agent may use (installing ≠ granting access).

The shortest path to a first message: configure a provider in **Providers**, click **+** (new chat) in the left sidebar, pick Iria Devon, and send a message.

> No self-service password reset exists yet — if you sign up with email/password and forget it, use "Continue with Google" or contact support.`,
    related: ['apps-and-providers', 'interface', 'chat-and-voice', 'profile'],
  },
  {
    id: 'interface',
    title: 'The interface',
    summary: 'How the app is organized: the tiling window layout, the left chat sidebar, and the kinds of windows you can open.',
    keywords: ['interface', 'layout', 'windows', 'tiling', 'sidebar', 'navigation', 'panels', 'desktop'],
    body: `# The interface

## Tiling layout (windows, not pages)
Teros works like a **desktop with windows** you can split, drag and arrange (think VS Code panels), not separate web pages. Opening a "route" **adds a window**, it doesn't replace what you had — so the user can have a chat, a Kanban board and a file viewer open at once. Splits are done from the window area (drag a window to an edge or use a panel's split controls). On mobile everything collapses into tabs.

## Opening windows & saving your layout
Click **+** (in the navbar or an empty panel) to open the **Launcher**, which lists every window type — pick one to open it. Some windows open on their own when relevant (e.g. a **Browserbase** live view when an agent drives a browser). Your window layout is **saved per workspace** and restored when you come back.

## Left sidebar (chats)
Always on the left. Conversations are grouped into **Active** (activity in the last 3h), **Inactive** (collapsible) and **Archived** (collapsible). Each row shows the agent avatar, chat name, last-message time, and a cyan unread count. At the top: **+ New Chat** and a **pending approvals** button when an agent is waiting for tool permission. The sidebar collapses to avatars-only (56px) or expands (260px).

## Windows you can open (point the user to the right one)
Chat, Conversations, Archived Conversations, Pending Approvals, **Agent** (agent editor), **Create Agent**, **Apps**, **App** (one app's config), **Catalog** (install apps), **Providers** (AI keys), **Profile**, **Board**, **Project**, **Skills**, **Workspaces** / **Workspaces List**, Launcher, **File Viewer** (live HTML), **File Browser**, **Markdown Viewer**, Code Editor, Terminal, Browserbase, Console.

> Admin-only windows (🔒): **Mcas**, **Usage**, **Users**, **Agent Cores**, **Agent Activity**, **Feature Flags**. If a non-admin asks for these, explain they need admin/super role.`,
    related: ['chat-and-voice', 'agents', 'files'],
  },
  {
    id: 'chat-and-voice',
    title: 'Chatting & voice',
    summary: 'Creating a chat, what you can send, tool-permission bars (Allow/Deny/always), inline forms, voice mode, stopping the agent, and queued messages.',
    keywords: ['chat', 'message', 'voice', 'permissions', 'allow', 'deny', 'tool call', 'stop', 'interrupt', 'queue', 'attachments', 'microphone', 'private chat', 'search', 'form', 'forms', 'inline form', 'structured input', 'fill a form', 'request-user-input'],
    body: `# Chatting & voice

## Start a chat & what to send
Click **+** (new chat) in the left sidebar → a modal lists the user's agents → pick one → a chat window opens. The user can send **text** (Markdown), **files** (PDFs become text, audio is transcribed, images go to vision models), and **voice**. Images can be attached on the very first message of a new chat. If a message fails to send, a **Retry** button appears on it.

## Voice in the composer
The microphone button opens an audio **recorder** in the composer: record (live waveform), **pause**, **play back / scrub** the preview, **discard** (X or Escape). Then either **send the audio**, or hit **transcribe-to-text** to turn it into editable text before sending. Shortcut: **Alt+X** starts/sends a recording in the active window. (Different from "Voice mode" below.)

## Tool-permission bar (the key safety control)
When an agent wants to run a tool (e.g. "read your Gmail"), an **inline permission bar appears inside the tool card** (not a modal): "Awaiting your approval" with **Allow** (this run only) and **Deny**. The **⋮ menu** adds **Deny always / Deny / Allow / Allow always**. The card also shows a **risk level** (High/Medium/Low) and the key parameters, with an expander for the **full parameters (JSON)** so you can decide with context. The request has **no expiry** — it waits for the user's decision indefinitely (there is no auto-deny countdown). By default Teros **always asks** before anything sensitive.

**Grouped permissions**: if several tools need approval at once, they appear in one panel — one row per tool plus global **Allow all** / **Deny all**. "Allow all" only grants reversible tools; irreversible ones must be approved one by one.

## Inline forms (structured input)
When an agent needs several specific values at once (dates, choices, amounts, short texts), it can send an **inline form in the chat** instead of asking question by question: a card with typed fields (text, number, choice chips, checkbox, date/time), an always-present **Notes** field for free-text clarifications, and a **Send** button. The conversation **waits** until the user submits or taps **"I'd rather answer in the chat"** (then the agent asks conversationally instead — it will not re-send the form). Validation errors show inline and the form stays editable; after sending, the card becomes a **read-only summary** of the answers. Forms survive page reloads. In **voice mode** there are no forms — the agent asks for each field aloud.

> For you, the agent: you send one of these with the **request-user-input** tool (fields defined by you; a Notes field is appended automatically — never add your own). If the tool is not in your tool list, the feature is not enabled on this instance yet — just ask conversationally. Read the \`notes\` in the result: it may qualify or correct the answers.

## Stopping & queued messages
While the agent is generating, a **stop** (square) button shows: a tap is a soft-stop; press-and-hold (or Shift+click) opens an immediate hard-stop (it warns if an irreversible tool is mid-run); you can also just **clear the queue** without aborting the current turn. You don't have to wait — new messages are marked **"queued"** (shown with a shimmer + clock) and processed in order, and while the agent works you see a **"thinking"** indicator. Drafts are auto-saved per chat.

## Voice mode (live call)
Click the **phone** icon in the chat header (feature-flagged) for a spoken back-and-forth. States: Idle → Connecting → Listening → Thinking → Speaking, plus Muted. Controls are mute and hang-up; live transcription shows on screen.

## Private chats
Type **/private** in the composer to make a chat **private**: it gets a lock icon, is hidden from lists and search, and is **deleted when closed** (unlike Archive). Good for sensitive, throwaway conversations.

## Chat menu (⋮) & search
Rename conversation, View token usage, Archive. New chats are **auto-named by AI** from the first messages (you can rename them). The **Conversations** window has a **search box** that searches the content of all your chats.`,
    related: ['agents', 'apps-and-providers', 'files'],
  },
  {
    id: 'agents',
    title: 'Agents',
    summary: 'Creating an agent from a role template and editing it (name, context/system prompt, apps, skills, model).',
    keywords: ['agent', 'create agent', 'edit agent', 'template', 'role', 'context', 'system prompt', 'persona', 'iria'],
    body: `# Agents

## Create an agent
Open the **Create Agent** window. It shows a grid of **12 role templates**: Personal Assistant, Product Manager, Fullstack Developer, DevOps Engineer, QA Tester, Automation Specialist, Data Analyst, UX Designer, Technical Writer, Security Analyst, Marketing Specialist, Customer Support. Pick one and the agent is pre-configured — the template seeds the role, intro and response style; you then set the name (avatar/appearance can be customized afterwards).

> The user does not have to start from scratch — **Iria Devon** already exists from signup.

## Edit an agent
Open the **Agent** window (agent editor). Tabs:
- **Conversations** — active chats with this agent; you can start a chat or a voice call with it from here.
- **General** — name, full name, role, intro, **max steps** (default 20; **0 = unlimited reasoning**), agent id. Avatar is changed by clicking the agent image in the header; color/icon via the palette button ("Customize Appearance"). Avatars accept JPEG/PNG/GIF/WebP up to 5 MB.
- **Context** — the agent's own **system prompt**: instructions it always remembers. Put permanent instructions here instead of repeating them each chat.
- **Apps** — which apps this agent may use (ON/OFF toggle). See apps-and-providers.
- **Skills** — which reusable instruction blocks are assigned.
- **Model** — which provider and model it uses; leave it on **System Default** to use the default provider/model automatically.

The agent can be deleted from the same editor (with confirmation).

## Good practice to suggest
Create one agent per context (work, code, personal). If an agent gets stuck, try switching the model/provider in the **Model** tab.`,
    related: ['apps-and-providers', 'skills', 'chat-and-voice'],
  },
  {
    id: 'apps-and-providers',
    title: 'Apps & providers',
    summary: 'Installing apps (MCAs) from the catalog, connecting credentials, granting an agent access, per-tool permissions, and adding LLM providers.',
    keywords: ['app', 'apps', 'mca', 'catalog', 'install', 'connect', 'oauth', 'api key', 'grant access', 'tool permission', 'provider', 'llm', 'model', 'anthropic', 'openai'],
    body: `# Apps & providers

## Install an app (MCA)
Open the **Catalog** window to browse everything connectable (Gmail, Calendar, Drive, GitHub, Notion, Linear, Perplexity, Filesystem, Web Fetch, and many more); you can **search and filter by category**. Click **Install**. Installing and connecting are **separate steps**. You can install **several instances** of the same app (e.g. two Gmail accounts) under different names. (Admins also have a separate **Mcas** window to manage the catalog itself — admin-only; regular users use **Catalog**.)

## Connect credentials
- **OAuth** (Gmail, GitHub, Notion, Slack, Drive, Calendar…) opens a provider popup to authorize.
- **API key** asks for a key.
The app reaches **Ready** once configured. You can later **disconnect/reconnect** the OAuth account, or **uninstall/rename** the app, from the **App** window.

> **Admin setup may be required.** Many OAuth integrations need an administrator to configure the platform-level credentials first. Until then the app shows **"Requires configuration"** and the Connect button is **hidden** — the user cannot do it alone; ask an admin to set up that provider on the instance.

## Grant an agent access (installing is not enough)
Installing an app does **not** let an agent use it. Open the agent editor → **Apps** tab → toggle the app **ON**. ("You don't have access to app X" means this step is missing.)

## Per-tool permissions
Each app exposes several tools, each set to **Allow** / **Ask** (default) / **Forbid** from the **App** window. These apply at the **app level** (shared by every agent that uses the app), not per agent. A **Set all** button fixes every tool of the app to one level at once. Read-only tools inheriting the default "ask" run without prompting.

## App states
Starting, **Ready**, Standby (idle), Error (check credentials), Disabled (by admin), Stopping, plus **Requires configuration** (admin must set up the provider). An app idle for 30 min sleeps and wakes again when needed. Some system apps are pre-installed and cannot be uninstalled.

## Providers (the AI model keys)
Open the **Providers** window. Teros supports **16 provider types**: Anthropic, Claude Pro/Max (OAuth), ChatGPT Pro/Plus / Codex (OAuth device flow), OpenAI, Google Gemini, OpenRouter, Zhipu AI, Zhipu AI Coding, Ollama Local (server URL), Ollama Cloud, MiniMax, Cloudflare Workers AI, Fireworks AI, Together AI, **Teros** (hosted, no key), and Custom OpenAI-compatible (endpoint URL).

To add one: **+ Add Provider** → choose type → fill key/OAuth/URL → **Add Provider**. The connection is **tested automatically** when you add it (a Test button is also there to re-check and discover models). Green **Active** = ready; red **Error** = key invalid/expired. You can pick a **default model** per provider, set a provider as default for new agents, or assign one per agent in the agent's **Model** tab.

> When an agent uses the **Browserbase** app to drive a web browser, a **Browserbase Live View** window opens so you can watch it navigate in real time.`,
    related: ['agents', 'chat-and-voice', 'roles-and-troubleshooting'],
  },
  {
    id: 'boards-and-autorun',
    title: 'Boards & autorun',
    summary: 'Kanban boards: creating a project, tasks, dependencies, and autorun (autonomous agents working tasks with slots).',
    keywords: ['board', 'kanban', 'project', 'task', 'column', 'dependency', 'autorun', 'autoplay', 'slots', 'runner', 'autonomous', 'auto-wakes'],
    body: `# Boards & autorun

For agents working on real projects (not just loose chats), use **boards**.

## Structure
A workspace has one or more **projects**; each project has a **board** with default columns **Backlog, To Do, In Progress, Blocked, Review, Done**. Each **task** lives in a column.

## Create a project & tasks
Open the **Project** window → **New Project** → name + description → a board is created. A project can also carry a **context** — permanent instructions applied to all its tasks. In the board, click **+** in Backlog (or "Add Task") → title. A task has a description (Markdown), an assignee, a **priority** (Urgent/High/Medium/Low) and **tags** (to filter/search the board). You can ask an agent to create **many tasks at once**. Click a task to open the side panel: description, assign/reassign, **Start** (if assigned). Move tasks by drag-and-drop or "Move to…". When an agent works a task it runs in a **linked conversation** you can open to follow its progress.

> Normal flow: agents move their tasks to **Review** when done; the **user** reviews and moves to **Done** (workers don't move to Done).

## Dependencies
A task can depend on another. In autorun a task won't auto-start until all its dependencies are in **Done**. Teros prevents circular dependencies.

## Autorun (autonomous agents) — a flagship feature
1. In the board's **Autoplay** panel, add agents as **runners**.
2. Give each runner a number of **slots** (parallel tasks) and press **Play**. Slots = 0 hides/disables Play for that runner; you can also remove a runner.
3. Teros watches the board live: when an assigned task is ready (in To Do, dependencies in Done) it wakes the right agent and sends the instruction, respecting slots and **priority**.
4. Agents work, add progress notes, and move tasks to **Review**.
5. The user reviews and moves to **Done**.

> Safety limit: each agent has an **auto-wakes** counter (default 5). If it loops too many times, Teros stops it and moves the task to \`blocked\` — event \`task.auto_wakes_exhausted\`.

## Coordinating a board (Board Manager)
Two distinct apps: **Board Manager** (coordinator — full board control: create/edit tasks, dependencies, autorun, supervision) and **Board Runner** (worker — limited to its own assigned tasks). Assign the right one to each agent. A coordinator with **Board Manager** can **subscribe to live board events**, **check the board's status** (slots, workload, what each agent is doing), and **stop a running task** with a cooperative signal — the runner finishes its current step and moves the task to Blocked/Done with a note (it waits up to ~5 min before warning).`,
    related: ['agents', 'workspaces', 'reminders'],
  },
  {
    id: 'workspaces',
    title: 'Workspaces',
    summary: 'What a workspace is, private vs shared, creating one, inviting members with roles, and switching workspaces.',
    keywords: ['workspace', 'collaboration', 'members', 'invite', 'roles', 'owner', 'admin', 'shared', 'private', 'switch'],
    body: `# Workspaces

A **workspace** is a shared space with its own file volume, agents, apps and members. **Everything in Teros is scoped to a workspace** — switching workspace reloads which chats, agents, apps and boards are visible.

## Types
- **Private** — created at signup, only the user has access. **Cannot be deleted or archived** (it's the permanent "home").
- **Shared** — the user creates it and invites people.

## Create a workspace
Open **Workspaces List** → **Create Workspace** (or the **+ New** button → "New Workspace" modal) → name + description (color/icon adjusted later by editing the workspace). The creator is automatically the **Owner**.

## Members & roles
Membership is managed **by asking the agent** — an agent with the core platform tools adds/updates/removes members by email or user id. The **Members** section in the workspace editor **shows** the current members but is not where you invite from. Roles:
- **Owner** — everything, including deleting/archiving the workspace.
- **Admin** — manage members, app permissions, workspace settings.
- **Write** — use the whole workspace (chats, tasks, projects, installed apps); cannot manage members.
- **Read** — view content only.

## Workspace context
A workspace can carry a shared **context** — instructions or background that all its agents see (e.g. "this workspace is the ACME project; always reply in Spanish"). Set it when editing the workspace; it complements each agent's own Context.

## Switching
Use the workspace selector in the navbar. Chats, projects and files are tied to a workspace, not global to the user — to share a chat, move the conversation into the shared workspace.`,
    related: ['boards-and-autorun', 'roles-and-troubleshooting', 'files'],
  },
  {
    id: 'files',
    title: 'Files',
    summary: 'Uploading files to a chat, supported formats and limits, browsing the workspace volume, live viewers, and public share links.',
    keywords: ['file', 'files', 'upload', 'pdf', 'image', 'audio', 'video', 'attachment', 'file browser', 'viewer', 'code editor', 'terminal', 'share', 'public link', 'html'],
    body: `# Files

## Upload in a chat
Click **+** in the chat input and pick one or more files (several per message). Supported: **PDFs** (text extracted, so even non-vision models can read them), **images** (JPEG/PNG/GIF/WebP/SVG/BMP — SVG is rasterized), **audio** (MP3/WAV/OGG/FLAC/WebM — auto-transcribed; if transcription fails a **Retry** button appears), **video** (MP4/MOV/WebM), **documents** (Word/Excel/PowerPoint, CSV/JSON/XML/HTML/Markdown), **archives** (ZIP/TAR/GZIP/7Z), and **code files** (read as-is). **Limit: 100 MB per file.** You can ask the agent to **copy an attachment into the workspace volume** to reuse later.

## Browse, edit & run
- **File Browser** — navigate the workspace volume (everything agents create with Filesystem/Code). Sandboxed to the workspace (\`../\` is blocked).
- **Code Editor** — click a code file in the File Browser to edit it (CodeMirror 6, **Vim mode**); changes save back to the volume.
- **Terminal** — open a real shell (xterm.js, runs on the workspace's bash app) from the File Browser to run commands in the volume.

## Live viewers
When the agent generates an HTML or Markdown file, the chat bubble shows a button to open it:
- **File Viewer** — HTML, updates live as the file changes (great for reports).
- **Markdown Viewer** — \`.md\` with full CommonMark + GFM; loads once, use **Refresh** to reload.

## Share with a public link
In the chat or viewer, click **Share** → a public link \`/share/<id>\` that needs no login. Click **Unshare** to stop sharing.`,
    related: ['chat-and-voice', 'workspaces', 'interface'],
  },
  {
    id: 'skills',
    title: 'Skills',
    summary: 'Reusable instruction blocks: what a skill is, creating one, and assigning it to agents.',
    keywords: ['skill', 'skills', 'reusable', 'instructions', 'rules', 'create skill', 'assign skill', 'variables', 'workspace'],
    body: `# Skills

A **skill** is a reusable block of instructions that can be assigned to several agents — e.g. "Always use metric units", "Write code comments in English", "Double-check for typos before finishing".

## Create, edit, delete
Open the **Skills** window → **Create Skill** → fill name, description and content (monospaced editor) → **Save** (name and content required). From the same window you can **edit** (pencil) or **delete** (trash, with confirmation) — deleting a skill removes it from **every** agent that had it.

## Assign to an agent
In the agent editor → **Skills** tab, toggle on the skills the agent should have. Skills are assigned with an ON/OFF toggle; the injection order is **not** editable from the current UI.

## Workspace-scoped
A skill lives in the workspace where it was created — it only appears and can only be assigned **within that workspace**. An agent shared across workspaces sees a different skill set depending on the active workspace.

## Variables in skill content
Skill content may include placeholders filled in automatically when injected: \`{{agent.name}}\`, \`{{agent.fullName}}\`, \`{{agent.role}}\`, \`{{agent.intro}}\`, \`{{agent.email}}\`, \`{{workspace.name}}\`. An unrecognized placeholder is left as-is (not dropped).

## Skills vs the agent's Context
Use a **skill** for rules shared across several agents; use the agent's **Context** tab for instructions specific to one agent.`,
    related: ['agents', 'apps-and-providers', 'workspaces'],
  },
  {
    id: 'reminders',
    title: 'Reminders, schedules & event triggers',
    summary: 'Asking an agent to remind you or run a task on a schedule (cron), and subscribing a conversation to app events so the agent reacts (notify/wake).',
    keywords: ['reminder', 'remind', 'recurring', 'schedule', 'cron', 'periodic', 'snooze', 'wake', 'scheduler', 'event', 'subscribe', 'notify', 'proactive', 'trigger'],
    body: `# Reminders, schedules & event triggers

## Time-based reminders
Ask an agent in natural language: *"remind me tomorrow at 9 to review the PR"*, or for a recurring task. The agent understands natural-language dates.

## Cron format (recurring tasks)
For recurring schedules Teros uses **5-field cron** (\`minute hour day month weekday\`), e.g. \`0 9 * * *\` = every day at 09:00. **Seconds are not supported, and shortcuts like \`@daily\` are not accepted.** Time is interpreted in **your timezone** (set in the Profile window).

## Managing them
**List, snooze, pause or cancel** reminders and recurring tasks just by asking the agent.

## Event triggers (proactive)
Beyond time, a conversation can **subscribe to an app's events** so the agent reacts when something happens — e.g. *"ping me here when a new email arrives"*. Two modes: **notify** (a silent message lands in the chat) or **wake** (the agent is actually woken to act on it).`,
    related: ['boards-and-autorun', 'roles-and-troubleshooting', 'profile'],
  },
  {
    id: 'profile',
    title: 'Your profile & settings',
    summary: 'The Profile window: display name, bio, interface language (EN/ES/KO), timezone, avatar, badges, usage stats, and logout.',
    keywords: ['profile', 'settings', 'language', 'i18n', 'timezone', 'avatar', 'badges', 'stats', 'logout', 'preferences', 'account'],
    body: `# Your profile & settings

Open the **Profile** window for your account settings:
- **Display name** and **bio/description** — how you appear to other workspace members.
- **Interface language** — English, Español or 한국어 (applied instantly).
- **Timezone** — used to interpret reminders and scheduled tasks; set it so "tomorrow at 9" means your 9.
- **Avatar** — upload an image (JPEG/PNG/GIF/WebP, up to 5 MB).
- **Badges** — recognitions an admin can grant (e.g. Founding Partner, Early Bird).
- **Stats** — total conversations, number of agents, days on the platform.
- **Logout** — at the bottom.

> Not in the UI yet: notification preferences, a light/dark theme switch (the app stays dark), and managing other active sessions.`,
    related: ['getting-started', 'reminders'],
  },
  {
    id: 'roles-and-troubleshooting',
    title: 'Roles, limits & troubleshooting',
    summary: 'Platform/workspace roles, tool permission levels, common error messages and what they mean, and the key limits.',
    keywords: ['role', 'permissions', 'troubleshooting', 'error', 'problem', 'limit', 'blocked', 'access denied', 'faq', 'admin', 'super', 'help'],
    body: `# Roles, limits & troubleshooting

## Roles
**Platform:** Super admin (everything, incl. impersonation), Admin (manage users, catalog MCAs, grant waitlisted access), User (normal use). Account **status**: **Active** (normal), **Suspended** (admin-blocked), **Pending verification**. Separately, every new account starts **waitlisted** (the \`accessGranted: false\` flag, orthogonal to status) until a founder grants access.
**Workspace:** Owner, Admin, Write, Read (see the workspaces topic).
**Tool permissions** are set **per app** (in the App window), not per agent — a tool's Allow/Ask/Forbid applies to every agent that uses that app. Levels: **Allow** / **Ask** (default) / **Forbid**. Private internal tools (name prefixed with \`-\`) and read-only tools inheriting the default are auto-allowed.

## Common error messages → what to tell the user
- *"Platform access not granted"* → still waitlisted; wait for the founder's approval email, then reload.
- *Account locked* → 5 failed logins lock it for 15 min; wait, or use Google login.
- *Forgot password* → there is **no self-service password reset**. Use "Continue with Google" to sign in, or contact support (\`hello@teros.ai\`).
- *"You don't have access to app X"* → installed but not granted: agent editor → Apps → toggle ON.
- *"This MCA requires admin role. You have user role."* → ask an admin; it's restricted.
- *App shows "Requires configuration"* → an admin must set up that OAuth provider at the platform level first.
- *"No write access to this workspace"* → role is \`read\`; ask the owner to upgrade to \`write\`.
- *"You can only move tasks assigned to you"* → only assigned tasks are movable.
- *Task won't start in autorun* → in autorun a task waits until all dependencies are in Done.
- *\`auto_wakes_exhausted\`* → agent hit the 5 auto-wakes loop limit; fix the task and restart it.
- *Provider Test fails / spinner forever* → key invalid/expired, out of quota, or the chosen model isn't available on that plan; re-check **Providers**.
- *"Invalid session token" / "expired"* → session expired (30-day default); log out and back in.
- *"Unknown action"* → stale client; hard-refresh (Ctrl+Shift+R).
- *"No viewer available for this file type."* → that format has no registered viewer (\`.md\` does).

## Key limits to know
Chat message text ~4000 chars (a counter shows in the **native app**; the **web composer does not hard-limit**) · uploaded file 100 MB · avatar 5 MB · agent reasoning steps (maxSteps) 20 by default (**0 = unlimited**) · tool-call output 40,000 chars · session 30 days · auto-wakes 5. **Teros has no message rate limiting of its own** — the real limit is the LLM provider's plan.`,
    related: ['apps-and-providers', 'workspaces', 'boards-and-autorun'],
  },
];
