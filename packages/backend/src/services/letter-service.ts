/**
 * Letter Service — generates the "live letter" for new-conversation empty states.
 *
 * Two layers:
 *  1. assembleFacts() — deterministic data collection (board activity in the
 *     workspace, agent identity). No LLM, no invention: every fact comes from
 *     the DB. This is also the fallback when generation fails.
 *  2. generateLetter() — the agent's own voice: InternalLLMService redacts the
 *     prose + starter prompts from the structured facts, taking the agent's
 *     role and context into account (a marketing agent writes about campaigns,
 *     a platform developer writes about deploys).
 *
 * Output shape (shared with the app's LetterEmptyState):
 *   segments: [{type:'text'|'em'|'link', value, target?}]
 *   prompts:  [{label, message}]
 * Links carry a target ({kind:'agent'|'board', ...}) so the client can call
 * openWindow() — the LLM only chooses wording, never destinations.
 */

import type { Db } from 'mongodb'
import type { InternalLLMService } from './internal-llm-service'

// ============================================================================
// TYPES
// ============================================================================

export interface LetterLinkTarget {
  kind: 'agent' | 'board' | 'channel'
  id: string
  name?: string
}

export interface LetterSegment {
  type: 'text' | 'em' | 'link'
  value: string
  target?: LetterLinkTarget
}

export interface LetterPrompt {
  label: string
  message: string
}

export interface LetterData {
  segments: LetterSegment[]
  prompts: LetterPrompt[]
  /** true when prose was LLM-generated; false → deterministic fallback */
  generated: boolean
}

interface BoardFact {
  projectId: string
  projectName: string
  inProgress: number
  todo: number
  blocked: number
  review: number
  backlog: number
  blockedTaskTitles: string[]
  /** Titles of in-progress/blocked/review tasks, freshest first (max 3; 6 when active today) */
  liveTaskTitles: string[]
  /** Project context excerpt — only included for boards active today */
  projectContext?: string
  agents: { agentId: string; name: string }[]
  /** ISO date of the most recent task update on this board */
  lastActivity: string
}

/** A recent conversation thread, keyed by its original ask. */
interface ThreadFact {
  channelId: string
  /** The channel's original ask — first user message (last messages are often replies) */
  topic: string
  /** ISO of the user's most recent message in the channel */
  when: string
  /** true when the user's last message has no assistant reply yet, or the channel is still running */
  open: boolean
}

export interface LetterFacts {
  agent: { agentId: string; name: string; role: string; context?: string }
  workspaceName?: string
  boards: BoardFact[]
  /** Recent conversation threads, newest first — open threads are resumable */
  recentThreads: ThreadFact[]
}

// ============================================================================
// FACT ASSEMBLY (deterministic)
// ============================================================================

const COLUMN_SLUGS = ['in_progress', 'todo', 'blocked', 'review', 'backlog', 'done'] as const

export class LetterService {
  constructor(
    private db: Db,
    private internalLLM: InternalLLMService,
  ) {}

  /**
   * Collect structured facts: the agent's identity + board activity in the
   * workspace. Cheap DB reads only — no LLM here.
   */
  async assembleFacts(agentId: string, workspaceId?: string): Promise<LetterFacts | null> {
    // Agent identity (role + context drive the letter's voice)
    const agent = await this.db.collection('agents').findOne(
      { agentId },
      { projection: { agentId: 1, name: 1, fullName: 1, role: 1, context: 1 } },
    )
    if (!agent) return null

    const facts: LetterFacts = {
      agent: {
        agentId: agent.agentId,
        name: agent.name || agent.fullName || 'Agent',
        role: agent.role || '',
        context: agent.context || undefined,
      },
      boards: [],
      recentThreads: [],
    }

    if (workspaceId) {
      const ws = await this.db
        .collection('workspaces')
        .findOne({ workspaceId }, { projection: { name: 1 } })
      if (ws) facts.workspaceName = ws.name

      // ── Recent conversation threads (keyed by their original ask) ────────
      // For each recent channel: the FIRST user message is the thread's
      // topic (the original intent — last messages are often replies), and
      // the thread is OPEN when the user's last message has no assistant
      // reply yet or the channel is still running. Open threads are what
      // the letter offers to resume.
      // PRIVACY: conversations are private between an agent and the user —
      // only THIS agent's own channels are considered. Vera's letter never
      // references what the user asked Alice.
      // NOTE: lastMessageAt/timestamp are stored as ISO STRINGS — compare
      // against an ISO string, not a Date, or nothing matches.
      const recentChannels = await this.db
        .collection('channels')
        .find(
          { workspaceId, agentId, lastMessageAt: { $gte: new Date(Date.now() - 14 * 86400_000).toISOString() } },
          { projection: { channelId: 1, running: 1 }, sort: { lastMessageAt: -1 } },
        )
        .limit(12)
        .toArray()
      if (recentChannels.length) {
        const channelIds = recentChannels.map((c: any) => c.channelId)
        const runningByChannel = new Map(recentChannels.map((c: any) => [c.channelId, !!c.running]))

        // First + last user message per channel (ascending sort → $first/$last)
        const userMsgs = await this.db
          .collection('channel_messages')
          .aggregate([
            { $match: { channelId: { $in: channelIds }, role: 'user' } },
            { $sort: { timestamp: 1 } },
            {
              $group: {
                _id: '$channelId',
                first: { $first: '$content' },
                last: { $last: '$content' },
                lastAt: { $last: '$timestamp' },
              },
            },
          ])
          .toArray()
        // Last assistant reply per channel — a thread is open when the
        // user spoke after it (or there is none yet)
        const assistantMsgs = await this.db
          .collection('channel_messages')
          .aggregate([
            { $match: { channelId: { $in: channelIds }, role: 'assistant' } },
            { $sort: { timestamp: -1 } },
            { $group: { _id: '$channelId', lastAt: { $first: '$timestamp' } } },
          ])
          .toArray()
        const lastAssistantAt = new Map(assistantMsgs.map((m: any) => [m._id, m.lastAt]))

        const asText = (c: unknown) => {
          const t = typeof c === 'string' ? c : (c as any)?.text ?? ''
          // Skip voice blobs and system-ish payloads — we want words
          return t && !t.startsWith('{') ? t.replace(/\s+/g, ' ').slice(0, 160) : ''
        }
        for (const m of userMsgs) {
          const topic = asText(m.first) || asText(m.last)
          if (!topic) continue
          const when = typeof m.lastAt === 'string' ? m.lastAt : String(m.lastAt ?? '')
          const repliedAt = lastAssistantAt.get(m._id)
          const open = runningByChannel.get(m._id) === true || !repliedAt || when > String(repliedAt)
          facts.recentThreads.push({ channelId: m._id, topic, when, open })
        }
        facts.recentThreads.sort((a, b) => b.when.localeCompare(a.when))
        facts.recentThreads = facts.recentThreads.slice(0, 4)
      }

      // Boards with recent activity. Only boards that moved in the LAST WEEK
      // make it into the letter — anything older is noise. Boards active TODAY
      // get double detail (more live tasks + project context) because that is
      // where the user's attention actually is.
      const nowMs = Date.now()
      const projects = await this.db
        .collection('projects')
        .find(
          { workspaceId, status: { $ne: 'archived' } },
          { projection: { projectId: 1, name: 1, boardId: 1, context: 1, updatedAt: 1 }, sort: { updatedAt: -1 } },
        )
        .limit(8)
        .toArray()

      for (const p of projects) {
        if (!p.boardId) continue

        // Column slug map from the board document (tasks reference columnId)
        const boardDoc = await this.db.collection('boards').findOne(
          { boardId: p.boardId },
          { projection: { columns: 1 } },
        )
        const columns: Array<{ columnId: string; slug: string }> = boardDoc?.columns ?? []
        if (columns.length === 0) continue
        const slugByColumnId = new Map(columns.map((c: any) => [c.columnId, c.slug]))

        const tasks = await this.db
          .collection('tasks')
          .find(
            { boardId: p.boardId, archived: { $ne: true } },
            { projection: { columnId: 1, title: 1, assignedAgentId: 1, updatedAt: 1 } },
          )
          .limit(200)
          .toArray()
        if (tasks.length === 0) continue

        const bySlug = (slug: string) =>
          tasks.filter((t: any) => slugByColumnId.get(t.columnId) === slug)
        const inProgress = bySlug('in_progress')
        const blocked = bySlug('blocked')
        const review = bySlug('review')
        const lastUpdate = tasks.reduce<Date | null>((acc, t: any) => {
          const d = t.updatedAt instanceof Date ? t.updatedAt : new Date(t.updatedAt ?? 0)
          return !acc || d > acc ? d : acc
        }, null)
        // Boards active today carry double detail — that is where the
        // user's attention is right now.
        const activeToday = !!lastUpdate && nowMs - lastUpdate.getTime() < 86400_000
        const board: BoardFact = {
          projectId: p.projectId,
          projectName: p.name,
          inProgress: inProgress.length,
          todo: bySlug('todo').length,
          blocked: blocked.length,
          review: review.length,
          backlog: bySlug('backlog').length,
          blockedTaskTitles: blocked.slice(0, 2).map((t: any) => t.title),
          liveTaskTitles: [...inProgress, ...blocked, ...review]
            .sort((a: any, b: any) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0))
            .slice(0, activeToday ? 6 : 3)
            .map((t: any) => t.title),
          projectContext:
            activeToday && typeof p.context === 'string' && p.context.trim()
              ? p.context.replace(/\s+/g, ' ').slice(0, 400)
              : undefined,
          agents: [],
          lastActivity: lastUpdate ? lastUpdate.toISOString() : new Date(0).toISOString(),
        }

        // Assigned agent names (for prose links)
        const agentIds = [...new Set(tasks.map((t: any) => t.assignedAgentId).filter(Boolean))]
        if (agentIds.length) {
          const found = await this.db
            .collection('agents')
            .find({ agentId: { $in: agentIds } }, { projection: { agentId: 1, name: 1 } })
            .toArray()
          board.agents = found.map((a: any) => ({ agentId: a.agentId, name: a.name }))
        }

        facts.boards.push(board)
      }

      // ── Ranking: freshness-weighted aliveness ────────────────────────────
      // HARD RULE: only boards that moved in the last 7 days appear at all —
      // anything older is stale noise the user does not care about. Within
      // that window: live columns first, then pending volume (review+backlog)
      // as a tie-breaker, freshness-weighted.
      const now = Date.now()
      const ageDays = (b: BoardFact) => Math.max(0, (now - Date.parse(b.lastActivity)) / 86400_000)
      const score = (b: BoardFact) => {
        const live = b.inProgress + b.blocked
        const pending = b.review + b.backlog
        const freshness = 1 / (1 + ageDays(b) / 7) // 1.0 today → ~0.5 at 7d
        return (live * 2 + pending) * freshness
      }
      facts.boards = facts.boards.filter((b) => ageDays(b) <= 7)
      facts.boards.sort((a, b) => score(b) - score(a))
      facts.boards = facts.boards.slice(0, 3)
    }

    return facts
  }

  // ============================================================================
  // LETTER GENERATION (agent's voice)
  // ============================================================================

  /**
   * Redact the letter with the internal LLM. The facts are fixed — the model
   * only writes prose around them. On any failure, returns null so the caller
   * falls back to the deterministic template.
   */
  async generateLetter(facts: LetterFacts, locale: string): Promise<LetterData | null> {
    const prompt = this.buildPrompt(facts, locale)
    try {
      const raw = await this.internalLLM.generateStructured(
        prompt,
        1200, // letter JSON + prompts; reasoning is capped via reasoning_effort
      )
      if (!raw) return null
      return this.parseLetter(raw, facts)
    } catch (error) {
      console.error('[LetterService] Generation failed:', error)
      return null
    }
  }

  /** Calendar-day difference between an ISO date and now (0 = today, 1 = yesterday). */
  private dayDiff(iso: string): number {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return 99
    const now = new Date()
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    return Math.round((start(now) - start(d)) / 86400_000)
  }

  /** ISO date → YYYY-MM-DD in SERVER-LOCAL time — same clock as the NOW line in the prompt. */
  private localDate(iso: string): string {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString('en-CA')
  }

  private buildPrompt(facts: LetterFacts, locale: string): string {
    const langName: Record<string, string> = {
      es: 'Spanish', en: 'English', ko: 'Korean',
    }
    const lang = langName[locale.split('-')[0]] || 'English'

    const boardLines = facts.boards.map((b) => {
      const mine = b.agents.some((a) => a.agentId === facts.agent.agentId)
      const parts = [
        `- project "${b.projectName}" (projectId: ${b.projectId}), ${this.dayDiff(b.lastActivity) === 0 ? 'ACTIVE TODAY' : `last activity ${this.localDate(b.lastActivity)}`}${mine ? ' — YOU have tasks assigned on this board' : ''}`,
        `  in_progress: ${b.inProgress}, review: ${b.review}, blocked: ${b.blocked}, todo: ${b.todo}, backlog: ${b.backlog}`,
      ]
      if (b.liveTaskTitles.length) {
        parts.push(`  live tasks (freshest first): ${b.liveTaskTitles.map((t) => `"${t}"`).join(', ')}`)
      }
      if (b.projectContext) {
        parts.push(`  project context: ${b.projectContext}`)
      }
      return parts.join('\n')
    })

    const threadLines = facts.recentThreads.map(
      (t) =>
        `- ${this.localDate(t.when)}: "${t.topic}"${t.open ? ' [OPEN — no reply yet / still running]' : ''} (channelId: ${t.channelId})`,
    )

    // NOW context — the model has no clock of its own; without this it
    // guesses dates ("yesterday" for a thread from 30 minutes ago).
    // Server-local time (Europe/Madrid) — matches the user's context today.
    const nowStr = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date())

    const agentContext = facts.agent.context
      ? `\nAgent context (system prompt excerpt — mirror its tone, do NOT quote it verbatim):\n${facts.agent.context.slice(0, 600)}`
      : ''

    return `You are ${facts.agent.name}, a ${facts.agent.role || 'assistant'} agent in the Teros platform, writing a short welcome letter ("la carta") that greets the user when they open a NEW conversation with you. The user already knows who you are — this is not a first meeting.

Write in ${lang}. Write in YOUR OWN voice as ${facts.agent.name} — your role shapes what you highlight: a ${facts.agent.role || 'assistant'} naturally talks about what matters to that role.
It is now ${nowStr} (server local time). All dates below are in server local time.

FACTS (ground truth — use ONLY these, never invent numbers, names or events):
${boardLines.length ? `Board activity in this workspace (boards that moved this week, most alive first):\n${boardLines.join('\n')}` : '- (no board activity this week)'}
${threadLines.length ? `\nRecent threads in YOUR OWN conversations with the user (newest first):\n${threadLines.join('\n')}` : ''}

OUTPUT FORMAT (strict JSON, no markdown fences, no commentary):
{
  "segments": [
    {"type":"text","value":"..."},
    {"type":"link","value":"ProjectName","projectId":"proj_..."},
    {"type":"link","value":"the thread's topic","channelId":"ch_..."},
    {"type":"em","value":"3"},
    {"type":"text","value":"..."}
  ],
  "prompts": [
    {"label":"short starter (max 8 words)","message":"the exact message sent when tapped (one concrete actionable sentence)"}
  ]
}

RULES:
- segments: 6-12 segments forming ONE flowing paragraph (max ~60 words). Pick the 1-2 MOST relevant facts and weave them in naturally — do NOT list everything. End inviting the user to pick a direction. Keep each text segment SHORT — a few words or one phrase; never pack half the paragraph into a single segment.
- Do NOT open with a greeting ("Hello", "Hi", "Hey") — the header above the letter already greets the user by name. Start straight into the content. Do NOT introduce yourself ("Hi, I'm X, your assistant…"). Do NOT list team members or enumerate who is assigned where; mention a person only if they are directly relevant to a fact you are highlighting.
- Proportion: match the emphasis to the size of the fact. A queue of 45 in review is THE story — talk about the queue, do NOT headline one random task title out of it. Mention an individual task by title only when it is the single live thing or the user's own thread points at it.
- Role lens: you are a ${facts.agent.role || 'assistant'} — filter EVERY fact through your role. A CEO talks strategy, growth and priorities; a COO talks bottlenecks, stalled work and flow; a platform developer talks bugs, code and deploys; a PA talks the user's day, threads and what to tackle next. Same facts, different letter. If a fact is not something your role would care about, leave it out.
- Threads: the threads listed are YOUR OWN conversations with the user — frame them as "you asked me…", never "you asked another agent". They are private: do not reference or imply conversations you were not part of.
- Prioritize what is actually moving: a board ACTIVE TODAY beats one that moved days ago; an OPEN thread beats any board statistic. If an OPEN thread exists, lead with it — "you left X waiting" — and link the thread so the user can jump back into it. Boards where YOU have tasks assigned are your own work — mention them from that angle.
- Dates: the time above is NOW. Interpret dates literally against it — a thread dated today = "today", yesterday's date = "yesterday", anything older = "this week" or "on <date>". A thread from 30 minutes ago is TODAY, never "yesterday". Never guess.
- prompts: exactly 3. Each must follow from something mentioned in the paragraph (e.g. if you mention an open thread, one prompt resumes it; if you mention a review queue, one prompt clears it). Concrete, in your voice, no generic filler.
- If there are NO facts at all, write a warm one-liner about being ready to work and 3 prompts that showcase your role.
- Spacing: each value carries its own surrounding spaces so segments concatenate into flowing prose — never glue words together, never leave a space before "," or ".".
- No emojis. No quotes around the JSON. Output the JSON object only.${agentContext}`
  }

  /**
   * Parse + sanitize the LLM output against the facts. Any segment that
   * references an unknown project/agent is demoted to plain text — links are
   * only kept when the target exists in the facts.
   */
  private parseLetter(raw: string, facts: LetterFacts): LetterData | null {
    let parsed: any
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // Models sometimes wrap the JSON in prose or fences despite the
      // instructions — salvage the outermost object before giving up.
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start === -1 || end <= start) {
        console.warn('[LetterService] LLM output was not valid JSON — falling back')
        return null
      }
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        console.warn('[LetterService] LLM output was not valid JSON — falling back')
        return null
      }
    }

    const validProjects = new Map(facts.boards.map((b) => [b.projectId, b.projectName]))
    const validChannels = new Map(facts.recentThreads.map((t) => [t.channelId, t.topic]))
    const validAgents = new Map<string, string>()
    for (const b of facts.boards) for (const a of b.agents) validAgents.set(a.agentId, a.name)

    const segments: LetterSegment[] = []
    for (const s of parsed.segments ?? []) {
      if (typeof s?.value !== 'string' || !s.value.trim()) continue
      // collapse whitespace runs; inter-segment spacing is normalized below.
      // Cap at 300 chars cut at a WORD boundary — a hard slice used to cut
      // mid-word when the model packed half the paragraph into one segment
      // ("…so we can pick t" + link).
      const collapsed = s.value.replace(/\s+/g, ' ')
      const value = collapsed.length > 300 ? collapsed.slice(0, 300).replace(/\s+\S+$/, '') : collapsed
      if (!value.trim()) continue

      if (s.type === 'link' && s.projectId && validProjects.has(s.projectId)) {
        segments.push({ type: 'link', value, target: { kind: 'board', id: s.projectId, name: validProjects.get(s.projectId) } })
      } else if (s.type === 'link' && s.channelId && validChannels.has(s.channelId)) {
        segments.push({ type: 'link', value, target: { kind: 'channel', id: s.channelId, name: validChannels.get(s.channelId) } })
      } else if (s.type === 'link' && s.agentId && validAgents.has(s.agentId)) {
        segments.push({ type: 'link', value, target: { kind: 'agent', id: s.agentId, name: validAgents.get(s.agentId) } })
      } else if (s.type === 'em') {
        segments.push({ type: 'em', value })
      } else {
        segments.push({ type: 'text', value })
      }
    }

    const prompts: LetterPrompt[] = []
    for (const p of parsed.prompts ?? []) {
      if (typeof p?.message !== 'string' || !p.message.trim()) continue
      prompts.push({
        label: (typeof p.label === 'string' && p.label.trim() ? p.label : p.message).slice(0, 80),
        message: p.message.trim().slice(0, 300),
      })
    }

    if (segments.length === 0 || prompts.length === 0) return null
    return { segments: this.normalizeSpacing(segments), prompts: prompts.slice(0, 3), generated: true }
  }

  /**
   * Guarantee flowing prose regardless of how the LLM spaced its segments:
   * exactly one space between segments, none before tight punctuation
   * ("," "." ";" …) and none after opening brackets/quotes. Fixes glued
   * words ("wordMVP") and orphaned punctuation (" ." / newline-comma).
   */
  private normalizeSpacing(segments: LetterSegment[]): LetterSegment[] {
    const segs = segments
      .map((s) => ({ ...s, value: s.value.replace(/\s+/g, ' ') }))
      .filter((s) => s.value.trim().length > 0)
    if (segs.length === 0) return segs
    segs[0].value = segs[0].value.trimStart()
    segs[segs.length - 1].value = segs[segs.length - 1].value.trimEnd()
    const tightStart = /^\s*[,.:;!?)\]}'’”…]/
    const tightEnd = /[(\[{‘“]\s*$/
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]
      const cur = segs[i]
      if (tightEnd.test(prev.value) || tightStart.test(cur.value)) {
        prev.value = prev.value.trimEnd()
        cur.value = cur.value.trimStart()
      } else {
        prev.value = prev.value.trimEnd() + ' '
        cur.value = cur.value.trimStart()
      }
    }
    return segs
  }

  // ============================================================================
  // DETERMINISTIC FALLBACK
  // ============================================================================

  /**
   * Template letter from the facts, no LLM. Used when generation fails or is
   * disabled. Locale-agnostic labels are provided by the client i18n; this
   * returns only the data-bearing segments.
   */
  fallbackSegments(facts: LetterFacts): { segments: LetterSegment[]; boardNames: string[] } {
    const segments: LetterSegment[] = []
    const boardNames: string[] = []
    const top = facts.boards[0]
    if (top) {
      boardNames.push(top.projectName)
      const counts: string[] = []
      if (top.inProgress) counts.push(`${top.inProgress}`)
      if (top.todo) counts.push(`${top.todo}`)
      if (top.blocked) counts.push(`${top.blocked}`)
      segments.push({ type: 'link', value: top.projectName, target: { kind: 'board', id: top.projectId, name: top.projectName } })
      if (counts.length) {
        segments.push({ type: 'text', value: ` — ${counts.join(' · ')} — ` })
      }
    }
    return { segments, boardNames }
  }
}
