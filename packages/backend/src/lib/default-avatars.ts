/**
 * Default agent avatars — the portraits a new agent gets when its creator did
 * not pick one (Pablo, 2026-10-31).
 *
 * Before, an agent born without an avatar showed its core's (`agent.avatarUrl
 * || core.avatarUrl`), so every new agent looked like Iria. Now it gets one of
 * the twenty default portraits in `static/avatars/`, chosen so the agents a
 * person sees look different from each other: the least-used portrait among
 * the avatars already in front of them (their own agents and, in a workspace,
 * the workspace's), ties broken at random.
 *
 * The resolution fallback to the core's avatar stays for agents created
 * before this (they carry no `avatarUrl`).
 */

/** Relative to the static base, like every stored avatar (`buildAvatarUrl`). */
export const DEFAULT_AVATARS: readonly string[] = Array.from(
  { length: 20 },
  (_, i) => `avatars/default-${String(i + 1).padStart(2, "0")}.jpg`,
)

/**
 * The default avatar to give a new agent: the least used among `inUse` (the
 * avatars of the agents the creator already sees; non-default values and
 * empties are ignored), ties broken by `random` (0 ≤ r < 1).
 */
export function pickDefaultAvatar(
  inUse: Iterable<string | undefined | null>,
  random: () => number = Math.random,
): string {
  const counts = new Map<string, number>(DEFAULT_AVATARS.map((a) => [a, 0]))
  for (const used of inUse) {
    if (!used) continue
    // Stored values may be absolute (`<static base>/avatars/default-03.jpg`)
    // when they went through buildAvatarUrl: match on the trailing path.
    const key = DEFAULT_AVATARS.find((a) => used === a || used.endsWith(`/${a}`))
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const min = Math.min(...counts.values())
  const candidates = DEFAULT_AVATARS.filter((a) => counts.get(a) === min)
  const index = Math.min(
    candidates.length - 1,
    Math.max(0, Math.floor(random() * candidates.length)),
  )
  return candidates[index]
}
