/**
 * Synthetic execution-context identities for the admin MCA test path (app.test-mca-tool).
 *
 * A dashboard test run has no real LLM agent or conversation, but context-scoped MCAs require
 * those identifiers (memory reads agentId, board-runner/board-manager read channelId). Rather than
 * omit them (→ opaque "X is required in context" throws) or reuse a real agent/channel (→ polluting
 * production data), the test path injects deterministic, user-scoped SYNTHETIC identifiers. They
 * form an isolated per-user diagnostic namespace: no real record backs them, and access to them is
 * granted only to the same user (see isOwnSyntheticTestChannel), so they can never target another
 * user's data.
 *
 * Both the injection site (test-mca-tool handler) and the access-check site (channel-manager) import
 * these helpers so the convention lives in exactly one place.
 */

const TEST_AGENT_PREFIX = "test-agent:"
const TEST_CHANNEL_PREFIX = "test-channel:"

/** Deterministic synthetic agentId for a user's MCA test runs. */
export function syntheticTestAgentId(userId: string): string {
  return `${TEST_AGENT_PREFIX}${userId}`
}

/** Deterministic synthetic channelId for a user's MCA test runs. */
export function syntheticTestChannelId(userId: string): string {
  return `${TEST_CHANNEL_PREFIX}${userId}`
}

/**
 * True iff channelId is the caller's OWN synthetic test channel. The suffix must equal the caller's
 * userId, so a user can only ever access their own test namespace — never a fabricated
 * `test-channel:<other-user>`. Real channels never use this format, so this widens access to nothing
 * that exists in production.
 */
export function isOwnSyntheticTestChannel(channelId: string, userId: string): boolean {
  return channelId === syntheticTestChannelId(userId)
}
