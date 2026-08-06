/**
 * TaskStatusBadge — badge coloreado para el estado de una tarea del Kanban.
 *
 * El estado real de una task se deriva del slug de su columna en Teros (no
 * hay campo `status` explícito). Los handlers backend inyectan `columnSlug`
 * en el shape (ver `packages/backend/src/handlers/domains/board/_helpers.ts`)
 * para que el renderer del MCA de Board no tenga que cross-referencear.
 *
 * Mapping canónico de slugs → variant:
 *   backlog     → gray
 *   todo        → info
 *   in_progress → info (+ indicador `•` si running=true)
 *   blocked     → error
 *   review      → warning
 *   done        → success
 *
 * Otros slugs desconocidos se muestran con variant=gray y el slug como label.
 */

import { Badge, type BadgeVariant } from './Badge';

interface SlugConfig {
  label: string;
  variant: BadgeVariant;
}

const SLUG_MAP: Record<string, SlugConfig> = {
  backlog: { label: 'backlog', variant: 'gray' },
  todo: { label: 'todo', variant: 'info' },
  in_progress: { label: 'in progress', variant: 'info' },
  blocked: { label: 'blocked', variant: 'error' },
  review: { label: 'review', variant: 'warning' },
  done: { label: 'done', variant: 'success' },
};

interface TaskStatusBadgeProps {
  /** columnSlug del handler backend (backlog|todo|in_progress|blocked|review|done|...) */
  slug?: string;
  /** columnName como fallback si el slug es desconocido. */
  fallbackLabel?: string;
  /** true = añade un "•" al label para indicar running (pulse visual). */
  running?: boolean;
  /** true = tarea archivada (override a gray con label "archived"). */
  archived?: boolean;
}

export function TaskStatusBadge({ slug, fallbackLabel, running, archived }: TaskStatusBadgeProps) {
  if (archived) {
    return <Badge text="archived" variant="gray" />;
  }

  const mapped = slug ? SLUG_MAP[slug] : undefined;
  const cfg: SlugConfig =
    mapped ?? {
      label: fallbackLabel ?? slug ?? 'unknown',
      variant: 'gray',
    };

  const label = running ? `${cfg.label} •` : cfg.label;
  return <Badge text={label} variant={cfg.variant} />;
}
