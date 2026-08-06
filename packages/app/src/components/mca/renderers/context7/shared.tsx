/**
 * mca.context7 — shared building blocks
 *
 * Patrón TER-281 zero-local-components: este módulo SOLO exporta constantes,
 * tipos, helpers de datos y helpers de props para primitivos globales. La
 * única excepción es `Context7ToolShell`, un wrapper compose-only sobre
 * `ToolCallCard` que pre-rellena defaults — no introduce visuals propios.
 *
 * Si descubres que estás escribiendo un componente JSX aquí, párate: o va a
 * `primitives/` (si es transversal a varios MCAs) o queda inline en el
 * sub-renderer que lo necesita.
 */

import type React from 'react';
import type { BadgeVariant, McaStatusType } from '../../primitives';
import { colors as semanticColors, parseOutput, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps, ToolStatus } from '../../types';

// ────────────────────────────────────────────────────────────────────────────
// Tipos del structuredContent (mirror del backend mcas/mca.context7/src/lib/parser.ts)
// ────────────────────────────────────────────────────────────────────────────

export type Reputation = 'High' | 'Medium' | 'Low' | 'Unknown';

export interface LibraryCandidate {
  id: string;
  title: string;
  description: string;
  snippetsCount: number;
  reputation: Reputation;
  benchmarkScore: number;
  versions?: string[];
}

export interface ResolveLibraryOutput {
  libraryName: string;
  query: string;
  candidates: LibraryCandidate[];
  cached: boolean;
  resolvedFrom: 'user' | 'anonymous';
}

export interface DocSnippet {
  title: string;
  source: string;
  description: string;
  code?: string;
  language?: string;
}

export interface GetDocsOutput {
  libraryId: string;
  query: string;
  snippets: DocSnippet[];
  totalReturned: number;
  resolvedFrom: 'user' | 'anonymous';
}

// ────────────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────────────

/** Labels humanos por shortToolName. Fallback a humanize automático si falta. */
export const TOOL_LABELS: Record<string, string> = {
  'resolve-library': 'Resolve library',
  'get-docs': 'Library docs',
  '-health-check': 'Health check',
};

/** Tools cuyo output justifica auto-expansión al renderizar (alta señal). */
export const DEFAULT_EXPANDED_TOOLS = new Set<string>(['resolve-library', 'get-docs']);

/** Cap visual para listas de candidatos (paginación lazy en el futuro). */
export const LIST_RENDER_CAP = 50;

/** Identity palette derivada del logo Context7 (placeholder hoy — actualizar
 * cuando el icono oficial llegue). NO se usa para accents semánticos —
 * mantener señal con `reputation` y estado. */
export const CONTEXT7_BRAND_ACCENT = semanticColors.indigo;

// ────────────────────────────────────────────────────────────────────────────
// Helpers de datos
// ────────────────────────────────────────────────────────────────────────────

/**
 * Desempaqueta el `structuredContent` del MCP tool result. El backend envía
 * `{ content: [{ type, text }], structuredContent: T }` y el frontend recibe
 * el JSON serialized. parseOutput hace el parsing inicial.
 */
export function unwrap<T>(output?: string): T | null {
  if (!output) return null;
  const parsed = parseOutput(output);
  if (parsed && typeof parsed === 'object' && 'structuredContent' in parsed) {
    return (parsed as { structuredContent: T }).structuredContent;
  }
  return parsed as T;
}

export function statusType(status: ToolStatus): McaStatusType {
  return status === 'pending' ? 'running' : status;
}

/** Iniciales para `IconTile` cuando no hay logo del library. */
export function libraryInitials(title: string): string {
  return title.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

/** Hash-derived accent para el `IconTile` de cada library — diferenciación
 * visual estable por id. NO es señal semántica.
 *
 * Paleta construida exclusivamente con colores semánticos del DS:
 * indigo (brand), green, amber, violet, orange. Se evitan Tailwind blue
 * (#3b82f6) y cyan (#06b6d4) que no pertenecen a la paleta v2. */
export function libraryAccent(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  const palette = [
    semanticColors.indigo,
    semanticColors.green,
    semanticColors.amber,
    semanticColors.violet,
    semanticColors.orange,
  ];
  return palette[Math.abs(h) % palette.length];
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de props para primitivos globales
// ────────────────────────────────────────────────────────────────────────────

const REPUTATION_VARIANT: Record<Reputation, BadgeVariant> = {
  High: 'success',
  Medium: 'info',
  Low: 'warning',
  Unknown: 'gray',
};

/**
 * Props para un Badge de reputación, o `null` si no hay señal real.
 *
 * El upstream Context7 actualmente devuelve `Unknown` para todos los results
 * (verificado en audit TER-312, 2026-04-30 con API key válida). Mostrar un
 * badge gris "Unknown" en cada candidato es ruido visual sin información
 * (color-signal-over-noise) — lo omitimos. Si Context7 empieza a poblar
 * High/Medium/Low en el futuro, el badge aparece automáticamente.
 *
 * Mismo patrón aplica a `snippetsCount` (siempre 0 hoy): el sub-renderer
 * filtra `c.snippetsCount > 0` antes de mostrar el badge.
 */
export function reputationChipProps(
  rep: Reputation,
): { text: Reputation; variant: BadgeVariant } | null {
  if (rep === 'Unknown') return null;
  return { text: rep, variant: REPUTATION_VARIANT[rep] };
}

/** Pill que avisa cuando se está usando el pool anónimo (Context7 sin API key
 * personal). Solo aparece si `resolvedFrom === 'anonymous'`. */
export function anonymousChipProps(resolvedFrom: 'user' | 'anonymous'): { text: string; variant: BadgeVariant } | null {
  return resolvedFrom === 'anonymous' ? { text: 'anonymous', variant: 'warning' } : null;
}

type ToolHint = 'resolve-library' | 'get-docs' | '-health-check';

/** Hint genérico cuando el error no matchea ningún patrón específico —
 * el agente o el user siempre tiene una guía accionable. */
const GENERIC_HINT_BY_TOOL: Record<ToolHint, string> = {
  'resolve-library':
    'Try a different libraryName, or refine with the query parameter (e.g. "react" + "hooks").',
  'get-docs':
    'Verify the libraryId with `resolve-library` first; ensure query is specific to the library.',
  '-health-check': '',
};

/**
 * Enriquece un mensaje de error genérico con title + hint accionable.
 * Mapea heurísticamente patrones conocidos de Context7 a remediaciones útiles
 * (auth/quota/not-found/network). Si no encaja, cae a un hint genérico por
 * tool — siempre hay guía visible, nunca string desnudo.
 */
export function context7ErrorProps(
  error: string | undefined,
  toolName?: string,
): {
  title: string;
  message: string;
  hint?: string;
} {
  const trimmed = (error ?? '').trim();
  const sep = trimmed.indexOf(': ');
  let title = 'Context7 error';
  let message = trimmed || 'Unknown error';

  if (sep > 0 && sep < 80) {
    title = trimmed.slice(0, sep);
    message = trimmed.slice(sep + 2);
  }

  const specificHint =
    /401|auth|invalid api key/i.test(trimmed)
      ? 'Replace CONTEXT7_API_KEY in user secrets with a valid key from context7.com/dashboard.'
      : /429|rate.?limit|quota/i.test(trimmed)
        ? 'Add CONTEXT7_API_KEY in user secrets to use your own quota (anonymous pool is heavily rate-limited).'
        : /404|not found/i.test(trimmed)
          ? 'Verify the libraryId — use `resolve-library` first to get a valid id.'
          : /timeout|ECONN|fetch failed|unreachable/i.test(trimmed)
            ? 'Network issue reaching context7.com. Retry; check connectivity.'
            : /required/i.test(trimmed)
              ? 'Check the tool parameters — a required field is missing.'
              : undefined;

  const fallback = toolName && toolName in GENERIC_HINT_BY_TOOL
    ? GENERIC_HINT_BY_TOOL[toolName as ToolHint] || undefined
    : undefined;

  return { title, message, hint: specificHint ?? fallback };
}

// ────────────────────────────────────────────────────────────────────────────
// Context7ToolShell — wrapper compose-only sobre ToolCallCard
// ────────────────────────────────────────────────────────────────────────────

interface Context7ToolShellProps {
  toolName: string;
  status: ToolStatus;
  duration?: number;
  appIcon?: string;
  /** Override del label automático en TOOL_LABELS. */
  description?: string;
  badge?: React.ReactNode;
  /** Override del default-expand. Si se omite, se deriva de DEFAULT_EXPANDED_TOOLS. */
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

/**
 * Wrapper alrededor de `ToolCallCard` que pre-rellena defaults específicos de
 * Context7 (description del label table, default-expand para tools con high
 * signal). Compose-only — no introduce visuales propios.
 *
 * Mantiene `animateExpand` activado (signature motion del estándar v2.1).
 */
export function Context7ToolShell({
  toolName,
  status,
  duration,
  appIcon,
  description,
  badge,
  defaultExpanded,
  children,
}: Context7ToolShellProps): React.ReactNode {
  const verbLabel = description ?? TOOL_LABELS[toolName] ?? toolName;
  const expanded = defaultExpanded ?? DEFAULT_EXPANDED_TOOLS.has(toolName);
  return (
    <ToolCallCard
      status={statusType(status)}
      verb={verbLabel}
      iconUri={appIcon}
      badge={badge}
      defaultExpanded={expanded}
      animateExpand
    >
      {children}
    </ToolCallCard>
  );
}
