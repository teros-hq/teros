/**
 * Permission helpers for `mca.teros.bash` and `mca.teros.admin.bash`
 * (and any other shell-shaped tool reusing them via wrapper).
 *
 * Three things are derived from the user-supplied shell command:
 *
 *   1. **Permission description** — the natural-language warning the
 *      user reads on the header during `pending_permission`. Wins over
 *      the LLM's generic "Execute command".
 *   2. **Irreversibility** — does the action leave a permanent change
 *      that cannot be undone? (rm -rf, npm publish, terraform destroy…)
 *   3. **Risk** — does the action carry elevated security/blast impact
 *      regardless of reversibility? (chmod 777, curl|sh, sudo, dd…)
 *
 * The three are different VIEWS of the same underlying classification.
 * To avoid drift between regex sets, we declare a SINGLE TABLE,
 * `BASH_PATTERNS`, and each function reads the relevant projection.
 * Adding a new idiom = one entry that decides description text + the
 * two boolean axes. Tests pin each projection independently.
 *
 * Recovered from `getActionDescription` (deleted with PermissionRequestWidget
 * in commit 89838e29). Kept as a dedicated helper so each MCA owns its
 * own copy (TER-281 spirit), but consolidated into a table so updates
 * touch one place.
 */

export interface BashPermissionInput {
  command?: string;
  description?: string;
  cwd?: string;
}

interface BashPattern {
  /** Short label for tests and debugging — not user-facing. */
  id: string;
  /** Regex matched against the trimmed command. */
  regex: RegExp;
  /**
   * Builds the user-facing description. The command and cwd are
   * provided pre-truncated/normalised. Returns `null` to defer to the
   * next matching pattern or the generic fallback.
   */
  describe: (ctx: { command: string; cwd?: string }) => string;
  /** Action cannot be undone (Irreversibility Indicator, §8). */
  irreversible: boolean;
  /** Elevated security/blast risk regardless of reversibility (§8.5). */
  risk: boolean;
}

/**
 * Single source of truth. Order matters — first-match-wins, so put
 * specific cloud/orchestration patterns BEFORE generic `rm` (which
 * matches substrings inside `aws s3 rm`, `docker volume rm`, etc.).
 */
export const BASH_PATTERNS: readonly BashPattern[] = [
  // ─── Privilege escalation (risk, recoverable from the cmd alone) ─────
  {
    id: 'sudo',
    regex: /(^|\s)(sudo|doas|sudoedit)\s/,
    describe: ({ command, cwd }) =>
      `Wants to run as root${cwd ? ` in ${cwd}` : ''}: ${truncate(command, 80)}`,
    irreversible: false,
    risk: true,
  },

  // ─── Pipe-to-shell from network (supply-chain risk) ──────────────────
  {
    id: 'curl|sh',
    regex: /\b(curl|wget|fetch)\s+[^|]+\|\s*(sh|bash|zsh|fish|ksh)\b/,
    describe: ({ command }) =>
      `Wants to execute remote script piped from network. Supply-chain risk: ${truncate(command, 80)}`,
    irreversible: false,
    risk: true,
  },

  // ─── Permission disasters (risk, reversible) ─────────────────────────
  {
    id: 'chmod-777-recursive',
    regex: /\bchmod\s+-[rR]+\s+0?7{3}\b/,
    describe: ({ command }) =>
      `Wants to make files world-writable recursively (chmod 777). Massive security risk: ${truncate(command, 80)}`,
    irreversible: false,
    risk: true,
  },
  {
    id: 'chmod-777-single',
    regex: /\bchmod\s+0?7{3}\b/,
    describe: ({ command }) =>
      `Wants to make a file world-writable (chmod 777). Massive security risk: ${truncate(command, 80)}`,
    irreversible: false,
    risk: true,
  },

  // ─── Cloud / orchestration / container destructive ops ───────────────
  // BEFORE the generic `rm` branch — these commands often contain "rm"
  // (e.g. `aws s3 rm`, `docker volume rm`, `kubectl delete` follows
  // similar precedence).
  {
    id: 'npm-publish',
    regex: /\bnpm\s+publish\b/,
    describe: ({ command }) =>
      `Wants to publish package to npm registry. Irreversible — published versions cannot be unpublished after 72h: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'kubectl-delete-all',
    regex: /\bkubectl\s+delete\b[^\n]*?(?:--all(?:-namespaces)?|\s-A(?:\s|$))/,
    describe: ({ command }) =>
      `Wants to delete Kubernetes resources cluster-wide: ${truncate(command, 80)}`,
    irreversible: true,
    risk: true,
  },
  {
    id: 'terraform-destroy',
    regex: /\bterraform\s+destroy\b/,
    describe: ({ command }) =>
      `Wants to destroy Terraform-managed infrastructure. Irreversible: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'aws-s3-rm-recursive',
    regex: /\baws\s+s3\s+rm\s+.*--recursive\b/,
    describe: ({ command }) =>
      `Wants to recursively delete S3 objects. Irreversible: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'docker-prune-rm',
    regex: /\bdocker\s+(system|volume|image|network)\s+(prune|rm)\b/,
    describe: ({ command }) =>
      `Wants to delete Docker resources (containers/volumes/images/networks): ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'truncate-zero',
    regex: /\btruncate\s+-s\s+0\b/,
    describe: ({ command }) =>
      `Wants to truncate file to zero bytes (empties content): ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },

  // ─── Destructive `rm` patterns ───────────────────────────────────────
  {
    id: 'rm-rf',
    regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
    describe: ({ command }) =>
      `Wants to delete files recursively. This action is irreversible: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'rm',
    regex: /\brm\s+/,
    describe: ({ command }) => `Wants to delete files: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'rmdir',
    regex: /\brmdir\b/,
    describe: ({ command }) => `Wants to remove a directory: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },

  // ─── Low-level disk operations (both axes) ───────────────────────────
  {
    id: 'low-level-disk',
    regex: /\b(dd|mkfs(\.\w+)?|mke2fs|fdisk|parted|wipefs)\b/,
    describe: ({ command }) =>
      `Wants to run a low-level disk operation. Data loss is possible: ${truncate(command, 80)}`,
    irreversible: true,
    risk: true,
  },

  // ─── Git history rewrites ────────────────────────────────────────────
  {
    id: 'git-reset-hard',
    regex: /\bgit\s+reset\s+--hard\b/,
    describe: ({ command }) =>
      `Wants to discard local changes (git reset --hard): ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'git-push-force',
    regex: /\bgit\s+push\s+(--force|-f)\b/,
    describe: ({ command }) =>
      `Wants to force-push to a remote (rewrites history): ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
  {
    id: 'git-clean-force',
    regex: /\bgit\s+clean\s+(-f|--force)/,
    describe: ({ command }) =>
      `Wants to delete untracked files (git clean): ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },

  // ─── Output redirection that may clobber files ───────────────────────
  // `>` overwrite is irreversible (the target is replaced). `>>`
  // (append) and `2>&1` (stderr redirect) are explicitly excluded —
  // matched via the regex.
  {
    id: 'redirect-overwrite',
    regex: /^(?!.*>>).*[^>2]>\s*\S/,
    describe: ({ command }) =>
      `Wants to overwrite a file via redirect: ${truncate(command, 80)}`,
    irreversible: true,
    risk: false,
  },
];

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Find the first BASH_PATTERNS entry that matches the command. Returns
 * `undefined` if no idiom is recognised — caller decides the fallback.
 */
function matchPattern(command: string | undefined): BashPattern | undefined {
  const c = command?.trim();
  if (!c) return undefined;
  return BASH_PATTERNS.find((p) => p.regex.test(c));
}

/**
 * Build the description shown in `<ToolCallCard description={...}>`
 * during pending_permission. Returns `null` when the input is empty
 * enough that the renderer's default ("Execute command" /
 * input.description) is fine.
 */
export function getBashPermissionDescription(
  input: BashPermissionInput | undefined,
): string | null {
  const command = input?.command?.trim();
  if (!command) return null;

  const match = matchPattern(command);
  if (match) return match.describe({ command, cwd: input?.cwd });

  // Generic fallback — the LLM's natural-language description if any.
  if (input?.description) return `Wants to run: ${input.description}`;

  const cwdPart = input?.cwd ? ` in ${input.cwd}` : '';
  return `Wants to execute${cwdPart}: ${truncate(command, 80)}`;
}

/**
 * Does the command match an idiom that the system classifies as
 * irreversible? See `BASH_PATTERNS` for the canonical list and the
 * §8 binary rule.
 */
export function isBashCommandIrreversible(command: string | undefined): boolean {
  return matchPattern(command)?.irreversible ?? false;
}

/**
 * Does the command match an idiom that the system classifies as
 * elevated risk (Renderer UX Guide v2.1 §8.5)? Binary, no gradations
 * — the badge text is the literal "risk".
 *
 * Risk activates for: world-writable permissions (chmod 777),
 * supply-chain code (curl|sh), privilege escalation (sudo),
 * cluster-wide blast radius (kubectl delete --all), or low-level disk
 * writes (dd, mkfs).
 *
 * Risk does NOT activate for irreversible-but-not-security idioms:
 * rm -rf (local blast, no security expansion), npm publish (economic
 * risk), git push --force (repo-local), terraform destroy (cost),
 * aws s3 rm --recursive (data risk, but reversible state for the
 * caller of THIS function — the bucket may have versioning).
 */
export function isBashElevatedRisk(command: string | undefined): boolean {
  return matchPattern(command)?.risk ?? false;
}
