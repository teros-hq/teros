import { type GitResult, isLockContention, lockFileFromStderr } from '../lib/git-local';
import { workflowPendingAction } from '../lib/workflow-permission';

export type GitIssueCode =
  | 'GIT_NOT_A_REPO'
  | 'GIT_INVALID_PATH'
  | 'GIT_CONFLICT'
  | 'GIT_NO_CHANGES'
  | 'GIT_AUTH_FAILED'
  | 'GIT_BRANCH_EXISTS'
  | 'GIT_BRANCH_NOT_FOUND'
  | 'GIT_REF_NOT_FOUND'
  | 'GIT_DIRTY_TREE'
  | 'GIT_PUSH_REJECTED'
  | 'GIT_DETACHED_HEAD'
  | 'GIT_NETWORK_ERROR'
  | 'GIT_TIMEOUT'
  | 'GIT_LOCKED'
  | 'GIT_NOT_INSTALLED'
  | 'GIT_SPAWN_FAILED'
  | 'GIT_OUTPUT_TOO_LARGE'
  | 'GIT_KILLED'
  | 'GIT_WORKFLOW_PERMISSION'
  | 'GIT_PERMISSION_DENIED'
  | 'GIT_REPO_NOT_ACCESSIBLE'
  | 'GIT_DESTINATION_OCCUPIED'
  | 'GIT_IDENTITY_MISSING'
  | 'GIT_DIVERGED'
  | 'GIT_FILE_TOO_LARGE'
  | 'GIT_PUSH_TOO_LARGE'
  | 'GIT_UNKNOWN';

export interface GitIssueAction {
  type: 'user_action' | 'system_action';
  description: string;
  url?: string;
}

export interface ClassifiedGitError {
  code: GitIssueCode;
  message: string;
  action: GitIssueAction;
  exitCode: number;
  /** Raw stderr (sanitised) — useful for debugging surfaces. */
  stderr?: string;
}

export const FILE_TOO_LARGE_ACTION =
  'GitHub refuses any file over 100 MB. Take the big files out of the commits that are not pushed yet (git-reset with mode "soft" to the remote branch, git-rm --cached those files, add them to .gitignore, commit again), then push. Tell the user which files were left out; large media or data belong in Git LFS or outside the repository. Ask the user before rewriting commits that other people already have.';

type ConflictOperation = 'merge' | 'rebase' | 'cherry-pick';

const CONFLICT_ACTIONS: Record<ConflictOperation, string> = {
  rebase:
    'Edit each conflicted file to the content it should have, git-add it, then call git-rebase with `mode: "continue"`. Do not commit during a rebase. To give up, git-rebase with `mode: "abort"` restores the branch as it was.',
  merge:
    'Edit each conflicted file to the content it should have, git-add it, then git-commit to finish the merge. To give up instead, ask the user before resetting.',
  'cherry-pick':
    'Edit each conflicted file, git-add it, then call git-cherry-pick with `mode: "continue"` (or `mode: "abort"` to give up).',
};

function conflictOperation(command: string | undefined, lower: string): ConflictOperation {
  if (command === 'rebase' || /rebase --continue|could not apply/.test(lower)) return 'rebase';
  if (command === 'cherry-pick' || /cherry-pick --continue/.test(lower)) return 'cherry-pick';
  return 'merge';
}

function conflictedFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const content = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
    if (content) {
      files.add(content[1].trim());
      continue;
    }
    const other = line.match(/^CONFLICT \([^)]*\): (\S+)/);
    if (other) files.add(other[1].trim());
  }
  return [...files];
}

/** `git push` / `git status` — for messages; falls back to plain `git`. */
function describeCommand(result: GitResult): string {
  return result.command ? `git ${result.command}` : 'git';
}

const NETWORK_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

/**
 * Classify a run where git did not exit normally (`code === -1`), from the
 * spawn error / signal `runGit` records. Before bug-git-github these were all
 * dropped and reported as `GIT_TIMEOUT` — a missing binary, an `EAGAIN` fork
 * failure, a 16 MB output overflow and an OOM kill all read "timeout".
 * Matches on `error.code`, never on the message (Bun and Node word it
 * differently). Returns `undefined` when there is nothing to go on, so the
 * caller keeps the legacy fallback.
 */
function classifySpawnFailure(result: GitResult, stderr: string): ClassifiedGitError | undefined {
  const exitCode = result.code;
  const command = describeCommand(result);
  const errCode = result.error?.code;
  // Last lines of stderr: git's own progress/diagnostics up to the kill.
  const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  const detail = tail ? ` Last git output: ${tail}` : '';

  if (errCode === 'ETIMEDOUT' || (!errCode && !result.signal)) {
    // No error and no signal: legacy shape (a bare `{code: -1}`), kept as timeout.
    const seconds = result.timeoutMs ? Math.round(result.timeoutMs / 1000) : undefined;
    const network = NETWORK_COMMANDS.has(result.command ?? '');
    if (result.budgetCapped && !result.timeoutMs) {
      return {
        code: 'GIT_TIMEOUT',
        message: `${command} was not started: this tool call's time budget had run out (spent waiting for another agent's git work on this repository, or on earlier steps).`,
        action: {
          type: 'user_action',
          description:
            'Check the repository state with git-status, then retry the call. If other agents are working in this clone, wait a minute first.',
        },
        exitCode,
        stderr,
      };
    }
    return {
      code: 'GIT_TIMEOUT',
      message: `${command} did not finish${seconds ? ` within ${seconds} s` : ''}${result.budgetCapped ? " (what was left of this tool call's time budget)" : ''} and was stopped.${detail}`,
      action: {
        type: 'user_action',
        description: network
          ? 'The remote transfer is too slow for the time budget. For a large repo clone with `depth` (shallow) or fetch a single branch/refspec, then retry. Retrying the same full transfer will likely time out again.'
          : 'The local repository is slow to read (a very large working tree, many untracked files such as node_modules/build output, or a slow network-mounted workspace volume). Retry once; if it keeps happening, add bulky directories to .gitignore or work on a narrower path. Ops can raise MCA_GIT_TIMEOUT_MS.',
      },
      exitCode,
      stderr,
    };
  }

  if (errCode === 'ENOENT') {
    return {
      code: 'GIT_NOT_INSTALLED',
      message: 'git binary not found or not executable in the MCA runtime.',
      action: {
        type: 'system_action',
        description:
          'Verify the `teros/mca-runtime` image ships with git installed and on PATH.',
      },
      exitCode,
      stderr,
    };
  }

  if (errCode === 'ENOBUFS') {
    return {
      code: 'GIT_OUTPUT_TOO_LARGE',
      message: `${command} produced more output than the MCA can return (${result.error?.message ?? 'buffer limit'}); it was stopped.`,
      action: {
        type: 'user_action',
        description:
          'Narrow the request: limit `git-log` with `maxCount`, diff a single path or use stat output, read one file instead of the whole tree.',
      },
      exitCode,
      stderr,
    };
  }

  if (errCode) {
    return {
      code: 'GIT_SPAWN_FAILED',
      message: `Could not start ${command}: ${errCode}${result.error?.message ? ` (${result.error.message})` : ''}.`,
      action: {
        type: 'system_action',
        description:
          errCode === 'EAGAIN' || errCode === 'EMFILE' || errCode === 'ENFILE' || errCode === 'ENOMEM'
            ? 'The MCA container is out of processes, file descriptors or memory. Retry in a moment; if it persists the container needs more resources or a restart.'
            : 'The MCA runtime could not execute git. Retry; if it persists check the container.',
      },
      exitCode,
      stderr,
    };
  }

  return {
    code: 'GIT_KILLED',
    message: `${command} was killed by ${result.signal}.${detail}`,
    action: {
      type: 'system_action',
      description:
        result.signal === 'SIGKILL'
          ? 'git was killed from outside, most often by the out-of-memory killer or a container restart. Retry; for very large repos use a shallow clone (`depth`). If it repeats the container needs more memory.'
          : 'git was terminated from outside (container stop/restart). Retry the operation.',
    },
    exitCode,
    stderr,
  };
}

/**
 * Classify a non-zero `GitResult` into a structured error. Pattern-matches
 * against well-known git stderr strings — order matters (most specific first).
 *
 * Stderr is already token-sanitised by `runGit` so it is safe to surface.
 */
export function classifyGitError(result: GitResult): ClassifiedGitError {
  const stderr = result.stderr || '';
  // Some git commands print diagnostic info to stdout instead of stderr — most
  // notably `git commit` with "nothing to commit, working tree clean" goes to
  // stdout but still returns exit 1. Match against the combined output so the
  // classifier covers both cases.
  const stdout = result.stdout || '';
  const lower = `${stderr}\n${stdout}`.toLowerCase();
  const exitCode = result.code;

  if (result.code === -1) {
    const spawnFailure = classifySpawnFailure(result, stderr);
    if (spawnFailure) return spawnFailure;
  }

  if (isLockContention(lower) || /unable to lock/.test(lower)) {
    const lockFile = lockFileFromStderr(stderr);
    const minutes = result.lockAgeMs !== undefined ? Math.floor(result.lockAgeMs / 60_000) : undefined;
    const leftover = minutes !== undefined && minutes >= 10;
    return {
      code: 'GIT_LOCKED',
      message: `Another git process is holding ${lockFile ? `\`${lockFile}\`` : 'the repository lock'}${minutes !== undefined ? ` (${minutes} min old)` : ''}; retried for a few seconds.`,
      action: {
        type: 'user_action',
        description: leftover
          ? `The lock is old, so it is most likely left over from a git that crashed or was killed. If no git is running in this repository (terminal, bash or other agents), delete ${lockFile ?? '.git/index.lock'} and retry.`
          : 'Some other git (a terminal, bash or another agent) is working in this repository. Retry in a moment.',
      },
      exitCode,
      stderr,
    };
  }

  if (/author identity unknown|committer identity unknown|unable to auto-detect email address|no email was given/.test(lower)) {
    return {
      code: 'GIT_IDENTITY_MISSING',
      message: `${describeCommand(result)} needs an author, and the connected GitHub account could not be read to provide one.`,
      action: {
        type: 'user_action',
        description:
          'Do not set user.name or user.email with git-config: commits are signed as the connected GitHub user. Check the GitHub connection (Apps → GitHub in Teros) and retry.',
      },
      exitCode,
      stderr,
    };
  }

  if (/not a git repository/.test(lower)) {
    return {
      code: 'GIT_NOT_A_REPO',
      message: 'The path is not a git repository.',
      action: {
        type: 'user_action',
        description:
          'Run `clone-repo` first or check the `repoPath` argument points at a cloned repository.',
      },
      exitCode,
      stderr,
    };
  }

  const tooLargeFiles = [...`${stderr}\n${stdout}`.matchAll(/File (.+?) is ([\d.]+ MB); this exceeds GitHub's file size limit/g)];
  if (tooLargeFiles.length > 0 || /gh001: large files detected/.test(lower)) {
    return {
      code: 'GIT_FILE_TOO_LARGE',
      message: `GitHub refused the push: ${tooLargeFiles.length ? tooLargeFiles.map((m) => `\`${m[1]}\` is ${m[2]}`).join(', ') : 'a file is larger than its limit'}; GitHub accepts files up to 100 MB.`,
      action: {
        type: 'user_action',
        description: FILE_TOO_LARGE_ACTION,
      },
      exitCode,
      stderr,
    };
  }

  if (/pack exceeds maximum allowed size|http 413|returned error: 413|request entity too large/.test(lower)) {
    return {
      code: 'GIT_PUSH_TOO_LARGE',
      message: 'GitHub refused the push because it is too large as a whole (one push can carry at most 2 GB).',
      action: {
        type: 'user_action',
        description:
          'Push in smaller steps (split the work over several branches, or push after every few commits) and keep generated or binary files out of the repository; large media belongs in Git LFS. Tell the user why.',
      },
      exitCode,
      stderr,
    };
  }

  if (/divergent branches|diverging branches can't be fast-forwarded|not possible to fast-forward|how to reconcile/.test(lower)) {
    return {
      code: 'GIT_DIVERGED',
      message: 'Your branch and its remote branch have diverged (both have commits the other lacks); a fast-forward is not possible.',
      action: {
        type: 'user_action',
        description:
          'Call git-pull with `rebase: true` to replay your local commits on top of the remote ones (linear history; the usual choice for a feature branch), or with `ff: "no"` to record a merge commit. Then push.',
      },
      exitCode,
      stderr,
    };
  }

  if (/(merge|rebase|cherry-pick) conflict|conflict \(|conflict.*in [^:]+:|fix conflicts/.test(lower)) {
    const files = conflictedFiles(`${stdout}\n${stderr}`);
    const operation = conflictOperation(result.command, lower);
    return {
      code: 'GIT_CONFLICT',
      message: `${operation === 'merge' ? 'The merge' : operation === 'rebase' ? 'The rebase' : 'The cherry-pick'} stopped on conflicts${files.length ? ` in ${files.map((f) => `\`${f}\``).join(', ')}` : ''}.`,
      action: { type: 'user_action', description: CONFLICT_ACTIONS[operation] },
      exitCode,
      stderr,
    };
  }

  if (
    /nothing to commit|no changes added|nothing added to commit/.test(lower) ||
    (exitCode === 1 && /working tree clean/.test(lower))
  ) {
    return {
      code: 'GIT_NO_CHANGES',
      message: 'No changes to commit.',
      action: {
        type: 'user_action',
        description: 'Stage changes with `git-add` first, or skip the commit.',
      },
      exitCode,
      stderr,
    };
  }

  // GitHub rejects any push that adds or edits `.github/workflows/*` unless
  // the token has the Workflows permission (App) / `workflow` scope (OAuth,
  // PAT). The Teros App does not request it (dropped in manifest 5.2.0), so these pushes
  // always fail — and used to surface as GIT_UNKNOWN. Must precede
  // GIT_PUSH_REJECTED ("failed to push some refs").
  const workflowRefusal = `${stderr}\n${stdout}`.match(
    /refusing to allow an? ([a-z ]+?) to create or update workflow `?([^`\s)]+)`?/i,
  );
  if (workflowRefusal) {
    const file = workflowRefusal[2];
    return {
      code: 'GIT_WORKFLOW_PERMISSION',
      message: `GitHub refused the push because it creates or changes \`${file}\`, a GitHub Actions workflow file, and the Teros GitHub App installation on this account or organization has not accepted the "Workflows" permission yet.`,
      action: {
        type: 'user_action',
        description: workflowPendingAction(),
      },
      exitCode,
      stderr,
    };
  }

  // 403 from GitHub: authenticated, but this identity (user ∩ App
  // installation) may not write here. Used to fall to GIT_NETWORK_ERROR
  // via "unable to access", which sent agents retrying a permission problem.
  if (/permission to \S+ denied to|requested url returned error: 403/.test(lower)) {
    const reading = NETWORK_COMMANDS.has(result.command ?? '') && result.command !== 'push';
    return {
      code: 'GIT_PERMISSION_DENIED',
      message: `GitHub denied ${reading ? 'read' : 'write'} access to this repository for the connected account (HTTP 403).`,
      action: {
        type: 'user_action',
        description: reading
          ? 'The Teros GitHub App must be installed on that repo/org with access to this repository, and the user must have access to it (the token is limited to both). Ask the user to check the App installation\'s repository access on GitHub. Retrying will not help.'
          : 'The user needs push rights on the repo AND the Teros GitHub App must be installed on that repo/org with access to it (the token is limited to both). Ask the user to check the App installation\'s repository access on GitHub, or to push from a fork/branch they can write to. Retrying will not help.',
      },
      exitCode,
      stderr,
    };
  }

  if (/requested url returned error: 401|invalid username or password/.test(lower)) {
    return {
      code: 'GIT_AUTH_FAILED',
      message: 'Authentication with the remote failed (HTTP 401).',
      action: {
        type: 'user_action',
        description:
          'Reconnect GitHub from the auth panel — the user access token may have expired or been revoked.',
      },
      exitCode,
      stderr,
    };
  }

  // GitHub answers "not found" for private repos the token cannot see.
  if (/remote: repository not found|repository '[^']*' not found/.test(lower)) {
    return {
      code: 'GIT_REPO_NOT_ACCESSIBLE',
      message: 'GitHub says the repository does not exist or is not visible to the connected account.',
      action: {
        type: 'user_action',
        description:
          'Check owner/repo spelling. For a private repo, the Teros GitHub App must be installed on its owner with access to this repository, and the user must have access to it.',
      },
      exitCode,
      stderr,
    };
  }

  if (/authentication failed|invalid credentials|permission denied \(publickey/.test(lower)) {
    return {
      code: 'GIT_AUTH_FAILED',
      message: 'Authentication with the remote failed.',
      action: {
        type: 'user_action',
        description:
          'Reconnect GitHub from the auth panel — the user access token may have expired or been revoked.',
      },
      exitCode,
      stderr,
    };
  }

  if (/a branch named.*already exists|branch.*already exists/.test(lower)) {
    return {
      code: 'GIT_BRANCH_EXISTS',
      message: 'A branch with that name already exists.',
      action: {
        type: 'user_action',
        description: 'Use `git-checkout` to switch to the existing branch, or pick a different name.',
      },
      exitCode,
      stderr,
    };
  }

  if (/pathspec.*did not match|invalid reference|did not match any file/.test(lower)) {
    return {
      code: 'GIT_REF_NOT_FOUND',
      message: 'Branch, tag, or commit not found.',
      action: {
        type: 'user_action',
        description: 'List branches with `git-checkout --list` or commits with `git-log`.',
      },
      exitCode,
      stderr,
    };
  }

  if (/branch.*not found|did not match any.*ref/.test(lower)) {
    return {
      code: 'GIT_BRANCH_NOT_FOUND',
      message: 'Branch not found.',
      action: {
        type: 'user_action',
        description: 'List local branches first.',
      },
      exitCode,
      stderr,
    };
  }

  if (
    /your local changes.*would be overwritten|cannot.*with unstaged|please commit your changes or stash/.test(
      lower,
    )
  ) {
    return {
      code: 'GIT_DIRTY_TREE',
      message: 'Working tree has uncommitted changes that would be lost.',
      action: {
        type: 'user_action',
        description: 'Commit or stash changes (`git-stash`) before this operation.',
      },
      exitCode,
      stderr,
    };
  }

  if (/rejected.*non-fast-forward|updates were rejected|hint: updates were rejected/.test(lower)) {
    return {
      code: 'GIT_PUSH_REJECTED',
      message: 'Push rejected: remote has commits not present locally (non-fast-forward).',
      action: {
        type: 'user_action',
        description:
          'Someone pushed to this branch first. Call git-pull with `rebase: true`, then git-push again. Use `force: true` only if the user wants the remote commits overwritten.',
      },
      exitCode,
      stderr,
    };
  }

  if (/head is detached|detached head/.test(lower)) {
    return {
      code: 'GIT_DETACHED_HEAD',
      message: 'HEAD is detached — operations are not on any branch.',
      action: {
        type: 'user_action',
        description: 'Create or check out a branch before committing.',
      },
      exitCode,
      stderr,
    };
  }

  if (/could not resolve host|unable to access|network is unreachable|connection (timed out|refused)/.test(lower)) {
    return {
      code: 'GIT_NETWORK_ERROR',
      message: 'Could not reach the remote.',
      action: {
        type: 'user_action',
        description: 'Check network and retry.',
      },
      exitCode,
      stderr,
    };
  }

  return {
    code: 'GIT_UNKNOWN',
    message: stderr.split('\n')[0]?.slice(0, 200) || `git exited with code ${exitCode}`,
    action: {
      type: 'user_action',
      description: 'Unexpected git error. Retry; if it persists, inspect the stderr.',
    },
    exitCode,
    stderr,
  };
}

/** Longest stderr excerpt carried in the thrown message. */
const STDERR_EXCERPT_CHARS = 800;

/**
 * The text the agent actually sees. The MCA SDK serialises a thrown tool
 * error as `error.message` only (`http-server.ts` handleToolCall), so the
 * `action` and `stderr` attached to the Error object never reached the
 * agent — it got "[GIT_TIMEOUT] git command exceeded the timeout" and
 * nothing to act on (bug-git-github). The first line stays `[CODE] message`
 * so existing matchers keep working; the action and git's own stderr follow.
 */
export function formatClassifiedGitError(classified: ClassifiedGitError): string {
  const lines = [`[${classified.code}] ${classified.message}`];
  lines.push(`What to do: ${classified.action.description}`);
  if (classified.action.url) lines.push(`Link: ${classified.action.url}`);
  const stderr = classified.stderr?.trim();
  if (stderr && !classified.message.includes(stderr)) {
    const excerpt =
      stderr.length > STDERR_EXCERPT_CHARS ? `…${stderr.slice(-STDERR_EXCERPT_CHARS)}` : stderr;
    lines.push(`git stderr: ${excerpt}`);
  }
  return lines.join('\n');
}

/**
 * Throw a classified error matching the same prefix format as other MCA error
 * classes (`[CODE] message`) so the MCA SDK serialises it consistently for the
 * LLM.
 */
export function throwClassifiedGitError(result: GitResult): never {
  throw classifiedGitErrorToError(classifyGitError(result));
}

export function classifiedGitErrorToError(classified: ClassifiedGitError): Error {
  const err = new Error(formatClassifiedGitError(classified));
  // Attach extras for surfaces that inspect the error object beyond `.message`.
  Object.assign(err, {
    code: classified.code,
    action: classified.action,
    exitCode: classified.exitCode,
    stderr: classified.stderr,
  });
  return err;
}
