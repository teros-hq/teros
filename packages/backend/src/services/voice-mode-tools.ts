/**
 * Built-in voice mode tools — `set_mode` / `get_mode` / `pause_listening`
 * (Voice Mode v2, F2b — spec v1.1.0 REQ-8, AC-7).
 *
 * The agent's OWN door to the mode axis: "Alice, cállate media hora que
 * tengo una reunión" → the agent decides to call `set_mode('passive')` +
 * `pause_listening(30m)` itself — the tools are "ejecutables por decisión
 * propia del agente además de por comando del usuario". Same authoritative
 * state as the voice door and the UI door (REQ-6: one state, three doors) —
 * `setVoiceSessionMode` on the VoiceLoop broadcasts `mode_changed` to every
 * client, so the ceremony fires on all screens.
 *
 * Availability is session-scoped, not flag-scoped: the tools exist ONLY while
 * a native voice session is active for the executor's (channelId, agentId) —
 * injected per turn by the McaToolExecutor via the `voiceTools` seam (same
 * lifecycle as the form tool: definition-only here, interception before the
 * permission gate there). In a text chat there is no mode to change, so the
 * tools simply do not appear.
 *
 * Naming invariant: no underscore in `set_mode`/`get_mode` would collide with
 * namespaced app tools — but the spec's canonical names ARE `set_mode` /
 * `get_mode` / `pause_listening` (REQ-8), and namespaced app tools always come
 * as `${appName}_${tool}` with a dot in the app name (mca.*), so the bare
 * underscore names cannot collide with any app tool.
 */

import type { ToolDefinition } from './mca-manager.types';

// ============================================================================
// NAMES
// ============================================================================

export const VOICE_SET_MODE_TOOL = 'set_mode';
export const VOICE_GET_MODE_TOOL = 'get_mode';
export const VOICE_PAUSE_LISTENING_TOOL = 'pause_listening';

export function isVoiceModeTool(toolName: string): boolean {
  return (
    toolName === VOICE_SET_MODE_TOOL ||
    toolName === VOICE_GET_MODE_TOOL ||
    toolName === VOICE_PAUSE_LISTENING_TOOL
  );
}

// ============================================================================
// DEFINITIONS (REQ-8 — the three mode tools)
// ============================================================================

export function buildVoiceModeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: VOICE_SET_MODE_TOOL,
      description:
        'Change YOUR OWN voice-session mode (how you respond to what you hear). ' +
        "Use it ONLY when the user explicitly asks for a mode ('ponte en modo escucha', 'hablemos', " +
        "'ponte disponible') or when the voice-session note tells you to call it after a closure. " +
        'Never change the mode on your own initiative. ' +
        'Modes: "available" (respond ONLY when called by name; nothing overheard is kept), ' +
        '"passive" (listen and transcribe everything to context; respond ONLY when called by name), ' +
        '"conversation" (respond to everything). Broadcasts the change to every client.',
      input_schema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['available', 'passive', 'conversation'],
            description: 'The mode to switch to.',
          },
        },
        required: ['mode'],
      },
    },
    {
      name: VOICE_GET_MODE_TOOL,
      description:
        'Get the current voice-session mode (available / passive / conversation). ' +
        'Use it when unsure which mode you are in before deciding how to respond.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: VOICE_PAUSE_LISTENING_TOOL,
      description:
        'Pause listening for a duration (minutes). While paused the voice session does not ' +
        "transcribe or respond — total privacy for the user's meeting/call. " +
        'Optional duration in minutes (default 30). The session resumes automatically when it ' +
        'elapses, or immediately if the user calls you by name.',
      input_schema: {
        type: 'object',
        properties: {
          duration_minutes: {
            type: 'number',
            description: 'How long to stay paused, in minutes (default 30).',
            minimum: 1,
            maximum: 480,
          },
        },
      },
    },
  ];
}

// ============================================================================
// EXECUTION RESULT (serializable for the LLM)
// ============================================================================

/** Result shape the executor returns to the LLM for the three tools. */
export interface VoiceModeToolResult {
  ok: boolean;
  mode?: string;
  pausedMinutes?: number;
  error?: string;
}
