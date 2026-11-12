/**
 * Enforced signature (spec §3.6, tn_PcquTN30AawbK8uE) — appended by the MCA
 * `send` tool to EVERY outgoing email. The agent cannot remove or edit it:
 * there is no parameter to skip it and the concatenation happens after the
 * agent's body, server-side (the agent only writes the body).
 *
 * Two functions (Pablo, 1-nov): transparency (recipient knows it's an agent
 * and whose) + branding ("Sent via …" pattern — every agent email is a
 * Teros ad).
 *
 * Wording is provisional — Pablo validates it rendered on a real email.
 * Keep the strings in ONE place so retuning is a one-line change.
 */
import type { ToolContext } from '@teros/mca-sdk';

/** Separator between the agent's body and the signature (plain text). */
const TEXT_SEPARATOR = '—';

/**
 * Build the enforced signature.
 *
 * @param agentName   agent's display name (fullName, from agentGet)
 * @param ownerName   owner's display name (execution.userDisplayName); when
 *                   absent the transparency line is omitted entirely
 */
export function buildSignature(agentName: string | undefined, ownerName: string | undefined): {
  text: string;
  html: string;
} {
  const transparency = ownerName ? ` · agente de ${ownerName} en Teros` : ' · agente de Teros';
  const line1 = `${agentName ?? 'Un agente'}${transparency}`;
  const line2 = 'Enviado vía Teros — tu equipo de agentes con email propio';

  const text = `\n\n${TEXT_SEPARATOR}\n${line1}\n${line2}`;

  // HTML: subtle <hr>, body typography, no external images (client compat).
  const html = `
<div style="margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;font-size:13px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;line-height:1.5">
  ${agentName ? `<span style="color:#374151">${escapeHtml(agentName)}</span>` : ''}${escapeHtml(transparency)}<br>
  ${escapeHtml(line2)}
</div>`;

  return { text, html };
}

/**
 * Append the enforced signature to the agent's body. Always called by `send`
 * right before submission — no code path sends without it.
 */
export function applySignature(
  body: { text: string; html?: string },
  agentName: string | undefined,
  ownerName: string | undefined,
): { text: string; html?: string } {
  const sig = buildSignature(agentName, ownerName);
  return {
    text: body.text + sig.text,
    html: body.html ? body.html + sig.html : undefined,
  };
}

/** Minimal HTML escaping for the signature's interpolated names. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve the agent's display name via the backend callback. Best-effort:
 * returns undefined on any failure — the signature still goes out with the
 * generic first line (transparency/branding never depend on the callback).
 */
export async function resolveAgentName(context: ToolContext): Promise<string | undefined> {
  const agentId = context.execution.agentId;
  if (!agentId || !context.backend?.agentGet) {
    return undefined;
  }
  try {
    const agent = (await context.backend.agentGet(agentId)) as
      | { fullName?: string; name?: string }
      | undefined;
    return agent?.fullName ?? agent?.name ?? undefined;
  } catch {
    return undefined;
  }
}
