/**
 * mca.hunter — shared building blocks
 *
 * Patrón TER-281 zero-local-components: este módulo SOLO exporta constantes,
 * tipos, helpers de datos y helpers de props para primitivos globales. La
 * única excepción es `HunterToolShell`, un wrapper compose-only sobre
 * `ToolCallCard`.
 *
 * Identidad de marca por el logo oficial vía `iconUri`; la señal de estado va
 * exclusivamente por `BadgeVariant` + tokens semánticos (green/amber/red). No se
 * usan acentos de marca hardcoded como señal semántica.
 */

import type React from 'react';
import type { BadgeVariant, McaStatusType } from '../../primitives';
import { parseOutput, ToolCallCard } from '../../primitives';
import type { ToolStatus } from '../../types';

// ────────────────────────────────────────────────────────────────────────────
// Tipos del output (mirror del backend mcas/mca.hunter/src/tools/*.ts)
// ────────────────────────────────────────────────────────────────────────────

export interface DomainSearchEmail {
  value: string;
  type: string | null;
  confidence: number | null;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  linkedin: string | null;
  twitter: string | null;
  phoneNumber: string | null;
}

export interface DomainSearchOutput {
  domain: string;
  organization: string | null;
  pattern: string | null;
  webmail: boolean;
  disposable: boolean;
  acceptAll: boolean;
  total: number;
  emails: DomainSearchEmail[];
}

export interface EmailFinderOutput {
  email: string | null;
  score: number | null;
  domain: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  company: string | null;
  linkedin: string | null;
  twitter: string | null;
  phoneNumber: string | null;
  verificationStatus: string | null;
}

export interface EmailVerifierOutput {
  email: string;
  status: string | null;
  result: string | null;
  score: number | null;
  gibberish: boolean;
  disposable: boolean;
  webmail: boolean;
  acceptAll: boolean;
  block: boolean;
  mxRecords: boolean;
  smtpServer: boolean;
  smtpCheck: boolean;
}

export interface HealthCheckOutput {
  status: 'ok' | 'degraded' | 'down' | string;
  issues?: Array<{ code: string; message: string; action?: { description?: string } }>;
  version?: string;
  uptime?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Constantes + palette oficial
// ────────────────────────────────────────────────────────────────────────────

/** Verbos imperativos por shortToolName (el primitivo compone el tense). */
export const TOOL_VERBS: Record<string, string> = {
  'domain-search': 'Find emails',
  'email-finder': 'Find email',
  'email-verifier': 'Verify email',
  '-health-check': 'Health check',
};

/** Tools cuyo output justifica auto-expansión (alta señal). */
export const DEFAULT_EXPANDED_TOOLS = new Set<string>([
  'domain-search',
  'email-finder',
  'email-verifier',
]);

/** Cap visual para la lista de emails de domain-search. */
export const LIST_RENDER_CAP = 50;

// ────────────────────────────────────────────────────────────────────────────
// Helpers de datos
// ────────────────────────────────────────────────────────────────────────────

/** El backend devuelve datos planos serializados — parseOutput basta.
 *  parseOutput (compartido) tiene firma `(string): T | string | null`: exige string
 *  y puede devolver el string crudo si no parsea. Normalizamos a `T | null`. */
export function unwrap<T>(output?: string): T | null {
  if (output == null) return null;
  const parsed = parseOutput<T>(output);
  return typeof parsed === 'string' ? null : parsed;
}

export function statusType(status: ToolStatus): McaStatusType {
  return status === 'pending' ? 'running' : status;
}

export function fullName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de props para primitivos globales (signal-over-noise)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Badge de confianza (0-100). Verde ≥80, ámbar ≥50, gris <50. `null` si el
 * upstream no pobla el campo (ruido sin info).
 */
export function confidenceChipProps(
  confidence: number | null,
): { text: string; variant: BadgeVariant } | null {
  if (confidence === null || confidence === undefined) return null;
  const variant: BadgeVariant = confidence >= 80 ? 'success' : confidence >= 50 ? 'warning' : 'gray';
  return { text: `${confidence}%`, variant };
}

/** Igual que confidence pero etiquetado como "score" (email-finder). */
export function scoreChipProps(score: number | null): { text: string; variant: BadgeVariant } | null {
  if (score === null || score === undefined) return null;
  const variant: BadgeVariant = score >= 80 ? 'success' : score >= 50 ? 'warning' : 'gray';
  return { text: `score ${score}`, variant };
}

/**
 * Mapea el `result` del email-verifier (deliverable / risky / undeliverable) a
 * un BadgeVariant semántico. Cae a info para valores desconocidos.
 */
export function verifierResultProps(
  result: string | null,
): { text: string; variant: BadgeVariant } | null {
  if (!result) return null;
  const r = result.toLowerCase();
  const variant: BadgeVariant =
    r === 'deliverable' ? 'success' : r === 'risky' ? 'warning' : r === 'undeliverable' ? 'error' : 'info';
  return { text: result, variant };
}

/** Mapea el `status` del verifier (valid/invalid/accept_all/webmail/disposable/unknown). */
export function verifierStatusProps(
  status: string | null,
): { text: string; variant: BadgeVariant } | null {
  if (!status) return null;
  const s = status.toLowerCase();
  const variant: BadgeVariant =
    s === 'valid' ? 'success' : s === 'invalid' ? 'error' : s === 'unknown' ? 'gray' : 'warning';
  return { text: status, variant };
}

/**
 * Boolean technical check (MX / SMTP / SMTP-check): green tick when present,
 * gray cross when absent. Props helper para `Badge` (patrón TER-281: cero
 * componentes locales en los sub-renderers).
 */
export function checkChipProps(label: string, on: boolean): { text: string; variant: BadgeVariant } {
  return { text: `${on ? '✓' : '✗'} ${label}`, variant: on ? 'success' : 'gray' };
}

/**
 * Enriquece un mensaje de error con title + hint accionable. Mapea los códigos
 * `[CODE]` del backend (y patrones heurísticos) a remediaciones. Siempre deja
 * guía visible, nunca un string desnudo.
 */
export function hunterErrorProps(
  error: string | undefined,
  toolName?: string,
): { title: string; message: string; hint?: string } {
  const trimmed = (error ?? '').trim();
  // Strip a leading `[CODE]` prefix for the title; keep the literal message.
  const codeMatch = trimmed.match(/^\[([A-Z_]+)\]\s*(.*)$/s);
  const title = codeMatch ? codeMatch[1].replace(/_/g, ' ').toLowerCase() : 'Hunter error';
  const message = codeMatch ? codeMatch[2] : trimmed || 'Unknown error';

  const hint =
    /AUTH_INVALID|401|invalid api key/i.test(trimmed)
      ? 'Add or replace HUNTER_API_KEY in this app\'s user secrets — get a key at hunter.io/api-keys.'
      : /PENDING/i.test(trimmed)
        ? 'Hunter is still verifying this email. Re-run the check in a few seconds.'
        : /QUOTA_EXCEEDED|usage|credit|429/i.test(trimmed)
          ? 'Monthly Hunter usage limit reached. Upgrade your plan or wait for the reset.'
          : /RATE_LIMITED|rate.?limit|403/i.test(trimmed)
            ? 'Hunter is rate-limiting requests. Retry in a few seconds.'
            : /BAD_REQUEST|required|invalid/i.test(trimmed)
              ? 'Check the tool parameters — a value is missing or malformed.'
              : /NOT_FOUND|404/i.test(trimmed)
                ? 'Hunter has no data for that input. Try a different domain or person.'
                : /DEPENDENCY_UNAVAILABLE|timeout|fetch failed|unreachable/i.test(trimmed)
                  ? 'Network issue reaching api.hunter.io. Retry shortly.'
                  : toolName === 'domain-search'
                    ? 'Verify the domain is a real company domain (e.g. "stripe.com").'
                    : undefined;

  return { title, message, hint };
}

// ────────────────────────────────────────────────────────────────────────────
// HunterToolShell — wrapper compose-only sobre ToolCallCard
// ────────────────────────────────────────────────────────────────────────────

interface HunterToolShellProps {
  toolName: string;
  status: ToolStatus;
  appIcon?: string;
  /** Frase con verbo imperativo líder (el primitivo conjuga el tense). */
  verb: string;
  badge?: React.ReactNode;
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

export function HunterToolShell({
  toolName,
  status,
  appIcon,
  verb,
  badge,
  defaultExpanded,
  children,
}: HunterToolShellProps): React.ReactNode {
  const expanded = defaultExpanded ?? DEFAULT_EXPANDED_TOOLS.has(toolName);
  return (
    <ToolCallCard
      status={statusType(status)}
      verb={verb}
      iconUri={appIcon}
      badge={badge}
      defaultExpanded={expanded}
      animateExpand
    >
      {children}
    </ToolCallCard>
  );
}
