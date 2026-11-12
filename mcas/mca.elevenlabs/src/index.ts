#!/usr/bin/env npx tsx

/**
 * ElevenLabs MCA - Text-to-Speech Integration
 *
 * Features:
 * - Text-to-speech generation with multiple voices and models
 * - Voice listing and management
 * - Multi-speaker conversation generation from YAML scripts
 * - Standardized health check protocol
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { exec } from 'child_process';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import yaml from 'yaml';
import { buildCallStartedPayload } from './events';
import { subscribeInitiatorChannelToPostCall, type NotifyChannelOutcome as NotifyOutcome } from './notify';
import { resolveAgentId, resolveApiKey, resolveApiKeyWithSource } from './secrets';

const execAsync = promisify(exec);

// =============================================================================
// CONFIGURATION
// =============================================================================

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// Default voice: Marianne Muller (Spanish, cloned)
const DEFAULT_VOICE_ID = 'd5Kfcl1Leyo0YYvIdKVG';

// =============================================================================
// TYPES
// =============================================================================

interface PodcastConfig {
  voices: Record<string, string>; // speaker name -> voice ID
  config?: {
    pause_between_speakers?: number;
    output?: string;
    model_id?: string;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speaker_boost?: boolean;
    output_format?: string;
  };
  dialogue: Array<{
    speaker: string;
    text: string;
  }>;
}

// =============================================================================
// API HELPERS
// =============================================================================

async function elevenLabsRequest(
  apiKey: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${ELEVENLABS_API_BASE}${endpoint}`;
  // HeadersInit can also be string[][] — this MCA only ever passes plain
  // object headers, so the cast is safe and keeps the Record<string,string> type.
  const headers: Record<string, string> = {
    'xi-api-key': apiKey,
    ...(options.headers as Record<string, string> | undefined),
  };
  // JSON body needs an explicit Content-Type, otherwise FastAPI rejects
  // the request with 'Input should be a valid dictionary' (422).
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(url, { ...options, headers });
}

async function generateSpeechBuffer(
  apiKey: string,
  text: string,
  voiceId: string,
  config: {
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
    speakerBoost?: boolean;
    outputFormat?: string;
  } = {},
): Promise<Buffer> {
  const modelId = config.modelId || 'eleven_flash_v2_5';
  const stability = config.stability ?? 0.5;
  const similarityBoost = config.similarityBoost ?? 0.75;
  const style = config.style ?? 0;
  const speakerBoost = config.speakerBoost ?? true;
  const outputFormat = config.outputFormat || 'mp3_44100_128';

  const response = await elevenLabsRequest(
    apiKey,
    `/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
          style,
          use_speaker_boost: speakerBoost,
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.statusText} - ${error}`);
  }

  const audioBuffer = await response.arrayBuffer();
  return Buffer.from(audioBuffer);
}

async function generatePodcast(apiKey: string, scriptPath: string): Promise<{ buffer: Buffer; extension: string }> {
  // Read and parse YAML script
  const scriptContent = await readFile(scriptPath, 'utf-8');
  const script: PodcastConfig = yaml.parse(scriptContent);

  // Validate script
  if (!script.voices || Object.keys(script.voices).length === 0) {
    throw new Error("Script must define at least one voice in 'voices' section");
  }

  if (!script.dialogue || script.dialogue.length === 0) {
    throw new Error('Script must have at least one dialogue entry');
  }

  // Validate all speakers have voices defined
  for (const line of script.dialogue) {
    if (!script.voices[line.speaker]) {
      throw new Error(`Speaker '${line.speaker}' not found in voices configuration`);
    }
  }

  // Create temp directory for audio segments
  const tempDir = join(tmpdir(), `podcast-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  console.error(`[Podcast] Temp directory: ${tempDir}`);
  console.error(`[Podcast] Generating ${script.dialogue.length} audio segments...`);

  const audioFiles: string[] = [];
  const pauseBetweenSpeakers = script.config?.pause_between_speakers ?? 1.0;

  try {
    // Generate audio for each dialogue line
    for (let i = 0; i < script.dialogue.length; i++) {
      const line = script.dialogue[i];
      const voiceId = script.voices[line.speaker];

      console.error(
        `[Podcast] ${i + 1}/${script.dialogue.length}: ${line.speaker} - "${line.text.substring(0, 50)}..."`,
      );

      // Generate speech
      const audioBuffer = await generateSpeechBuffer(apiKey, line.text, voiceId, {
        modelId: script.config?.model_id,
        stability: script.config?.stability,
        similarityBoost: script.config?.similarity_boost,
        style: script.config?.style,
        speakerBoost: script.config?.speaker_boost,
        outputFormat: script.config?.output_format,
      });

      // Save to temp file
      const audioFile = join(tempDir, `segment-${i.toString().padStart(4, '0')}.mp3`);
      await writeFile(audioFile, audioBuffer);
      audioFiles.push(audioFile);

      // Add pause after speaker (except for last line)
      if (i < script.dialogue.length - 1 && pauseBetweenSpeakers > 0) {
        const pauseFile = join(tempDir, `pause-${i.toString().padStart(4, '0')}.mp3`);
        // Generate silence using ffmpeg
        await execAsync(
          `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${pauseBetweenSpeakers} -q:a 9 -acodec libmp3lame "${pauseFile}"`,
        );
        audioFiles.push(pauseFile);
      }
    }

    console.error(`[Podcast] Combining ${audioFiles.length} audio files...`);

    // Create concat file list for ffmpeg
    const concatListPath = join(tempDir, 'concat-list.txt');
    const concatContent = audioFiles.map((f) => `file '${f}'`).join('\n');
    await writeFile(concatListPath, concatContent);

    // Combine all audio files using ffmpeg concat into a temp file
    const outputFormat = script.config?.output_format?.startsWith('mp3') ? 'mp3' : 'wav';
    const tempOutput = join(tempDir, `podcast-final.${outputFormat}`);
    await execAsync(`ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${tempOutput}"`);

    console.error(`[Podcast] Podcast generated, reading buffer...`);
    const buffer = await readFile(tempOutput);
    await unlink(tempOutput).catch(() => {});

    return { buffer, extension: outputFormat };
  } finally {
    // Clean up temp files
    console.error(`[Podcast] Cleaning up temp directory...`);
    try {
      for (const file of audioFiles) {
        await unlink(file).catch(() => {});
      }
      await unlink(join(tempDir, 'concat-list.txt')).catch(() => {});
    } catch (error) {
      console.error(`[Podcast] Warning: Failed to clean up temp files: ${error}`);
    }
  }
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.elevenlabs',
  name: 'ElevenLabs',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies API key and connectivity to ElevenLabs.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    // User-only key resolution (product decision 2026-10-26): the user's own
    // key is the only source. No key → the app is unusable for this user
    // until they configure it.
    const { apiKey, source } = await resolveApiKeyWithSource(context);

    try {
      if (!apiKey) {
        // Neither user nor system key configured — genuinely unusable.
        builder.addIssue('USER_CONFIG_MISSING', 'Your ElevenLabs API key is not configured', {
          type: 'user_action',
          description: 'Configure your own ElevenLabs API key in the app settings',
        });
      } else {
        // Validate the WINNING key against the API.
        try {
          const response = await elevenLabsRequest(apiKey, '/user/subscription');

          if (!response.ok) {
            if (response.status === 401) {
              builder.addIssue('AUTH_INVALID', 'Your ElevenLabs API key is invalid', {
                type: 'user_action',
                description: 'The API key you configured is invalid. Please update it.',
              });
            } else {
              builder.addIssue(
                'DEPENDENCY_UNAVAILABLE',
                `ElevenLabs API error: ${response.statusText}`,
                {
                  type: 'auto_retry',
                  description: 'ElevenLabs API temporarily unavailable',
                },
              );
            }
          }
        } catch (error: any) {
          builder.addIssue(
            'DEPENDENCY_UNAVAILABLE',
            `Failed to connect to ElevenLabs: ${error.message}`,
            {
              type: 'auto_retry',
              description: 'Network error connecting to ElevenLabs API',
            },
          );
        }
      }
    } catch (error: any) {
      builder.addIssue('SYSTEM_CONFIG_MISSING', `Failed to get secrets: ${error.message}`, {
        type: 'admin_action',
        description: 'Ensure backend is reachable',
      });
    }

    return builder.build();
  },
});

// =============================================================================
// TEXT TO SPEECH
// =============================================================================

server.tool('text-to-speech', {
  annotations: { readOnlyHint: false },
  description:
    'Generate speech from text using ElevenLabs. Returns the audio file path. Use the default voice (do not specify voiceId) unless the user explicitly requests a different voice.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to convert to speech',
      },
      voiceId: {
        type: 'string',
        description:
          'Voice ID to use. Use list_voices to see available voices. Default: Marianne Muller (Spanish)',
      },
      modelId: {
        type: 'string',
        description:
          'Model to use: eleven_monolingual_v1, eleven_multilingual_v1, eleven_multilingual_v2, eleven_turbo_v2, eleven_turbo_v2_5, eleven_flash_v2_5 (default)',
        default: 'eleven_flash_v2_5',
      },
      stability: {
        type: 'number',
        description: 'Voice stability (0.0 to 1.0, default: 0.5). Higher = more stable/consistent',
        default: 0.5,
      },
      similarityBoost: {
        type: 'number',
        description:
          'Similarity boost (0.0 to 1.0, default: 0.75). Higher = closer to original voice',
        default: 0.75,
      },
      style: {
        type: 'number',
        description: 'Style exaggeration (0.0 to 1.0, default: 0). Higher = more expressive',
        default: 0,
      },
      speakerBoost: {
        type: 'boolean',
        description: 'Enable speaker boost for better quality (default: true)',
        default: true,
      },
      outputFormat: {
        type: 'string',
        description:
          'Output format: mp3_44100_128, mp3_44100_192, pcm_16000, pcm_22050, pcm_24000, pcm_44100',
        default: 'mp3_44100_128',
      },
      outputPath: {
        type: 'string',
        description:
          'Custom output path for the audio file (optional). Defaults to /workspace/tts-{timestamp}.mp3',
      },
    },
    required: ['text'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const text = args.text as string;
    const voiceId = (args.voiceId as string) || DEFAULT_VOICE_ID;
    const modelId = (args.modelId as string) || 'eleven_flash_v2_5';
    const stability = (args.stability as number) ?? 0.5;
    const similarityBoost = (args.similarityBoost as number) ?? 0.75;
    const style = (args.style as number) ?? 0;
    const speakerBoost = (args.speakerBoost as boolean) ?? true;
    const outputFormat = (args.outputFormat as string) || 'mp3_44100_128';
    const outputPath = args.outputPath as string | undefined;

    // Generate audio
    const audioBuffer = await generateSpeechBuffer(apiKey, text, voiceId, {
      modelId,
      stability,
      similarityBoost,
      style,
      speakerBoost,
      outputFormat,
    });

    const timestamp = Date.now();
    const extension = outputFormat.startsWith('mp3') ? 'mp3' : 'wav';
    const mimeType = extension === 'mp3' ? 'audio/mpeg' : 'audio/wav';

    // Persist audio as object (WS1c — objects-first standard).
    // Primary output is { objectId, url } — a permanent public URL.
    const objectResult = await context.objects.put(audioBuffer, mimeType, {
      source: 'elevenlabs',
      voiceId,
      modelId,
      outputFormat,
      textLength: String(text.length),
    });

    if (!objectResult.success) {
      throw new Error(`Failed to persist audio object: ${objectResult.error || 'unknown'}`);
    }

    // Backwards-compat: also write to filePath if the caller asked for one.
    // The default /workspace/tts-* path is no longer written unless requested.
    let filePath: string | undefined;
    if (outputPath) {
      filePath = outputPath;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, audioBuffer);
    }

    return {
      success: true,
      objectId: objectResult.objectId,
      url: objectResult.url,
      ...(filePath ? { filePath } : {}),
      voiceId,
      modelId,
      outputFormat,
      textLength: text.length,
      audioSize: audioBuffer.byteLength,
    };
  },
});

// =============================================================================
// LIST VOICES
// =============================================================================

server.tool('list-voices', {
  annotations: { readOnlyHint: true },
  description:
    'List available voices from ElevenLabs account. Supports filtering by name, category, and limiting results.',
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Search term to filter voices by name (case-insensitive, optional)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of voices to return (optional, default: all)',
      },
      category: {
        type: 'string',
        description:
          'Filter by voice category: premade, cloned, generated, professional (optional)',
      },
    },
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const search = (args.search as string)?.toLowerCase();
    const limit = args.limit as number | undefined;
    const category = args.category as string | undefined;

    const response = await elevenLabsRequest(apiKey, '/voices');

    if (!response.ok) {
      throw new Error(`Failed to list voices: ${response.statusText}`);
    }

    const data = await response.json();
    let voices = data.voices || [];

    // Apply search filter
    if (search) {
      voices = voices.filter((voice: any) => voice.name.toLowerCase().includes(search));
    }

    // Apply category filter
    if (category) {
      voices = voices.filter((voice: any) => voice.category === category);
    }

    // Apply limit
    if (limit && limit > 0) {
      voices = voices.slice(0, limit);
    }

    // Simplify voice data for response
    const simplifiedVoices = voices.map((voice: any) => ({
      voice_id: voice.voice_id,
      name: voice.name,
      category: voice.category,
      description: voice.description,
      labels: voice.labels,
      preview_url: voice.preview_url,
    }));

    return {
      voices: simplifiedVoices,
      total: simplifiedVoices.length,
      filtered: !!(search || category || limit),
    };
  },
});

// =============================================================================
// GET VOICE
// =============================================================================

server.tool('get-voice', {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific voice including settings and samples.',
  parameters: {
    type: 'object',
    properties: {
      voiceId: {
        type: 'string',
        description: 'The ID of the voice to get information about',
      },
    },
    required: ['voiceId'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const voiceId = args.voiceId as string;
    const response = await elevenLabsRequest(apiKey, `/voices/${voiceId}`);

    if (!response.ok) {
      throw new Error(`Failed to get voice: ${response.statusText}`);
    }

    return await response.json();
  },
});

// =============================================================================
// GENERATE CONVERSATION
// =============================================================================

server.tool('generate-conversation', {
  annotations: { readOnlyHint: false },
  description:
    'Generate a multi-speaker conversation from a YAML script. Reads a YAML file with speaker voices and dialogue, generates audio for each line, and combines them into a single audio file. Requires ffmpeg installed.',
  parameters: {
    type: 'object',
    properties: {
      scriptPath: {
        type: 'string',
        description: 'Path to the YAML script file (absolute or relative to current directory)',
      },
    },
    required: ['scriptPath'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const scriptPath = args.scriptPath as string;

    if (!scriptPath) {
      throw new Error('scriptPath is required');
    }

    const { buffer, extension } = await generatePodcast(apiKey, scriptPath);
    const mimeType = extension === 'mp3' ? 'audio/mpeg' : 'audio/wav';

    // Persist as object (WS1c — objects-first standard)
    const objectResult = await context.objects.put(buffer, mimeType, {
      source: 'elevenlabs',
      tool: 'generate-conversation',
      scriptPath,
    });

    if (!objectResult.success) {
      throw new Error(`Failed to persist podcast object: ${objectResult.error || 'unknown'}`);
    }

    return {
      success: true,
      objectId: objectResult.objectId,
      url: objectResult.url,
      audioSize: buffer.byteLength,
      message: 'Conversation generated successfully',
    };
  },
});

// =============================================================================
// GET SUBSCRIPTION
// =============================================================================

server.tool('get-subscription', {
  annotations: { readOnlyHint: true },
  description:
    'Get information about the current ElevenLabs subscription including character usage and limits.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const response = await elevenLabsRequest(apiKey, '/user/subscription');

    if (!response.ok) {
      throw new Error(`Failed to get subscription: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      tier: data.tier,
      character_count: data.character_count,
      character_limit: data.character_limit,
      characters_remaining: data.character_limit - data.character_count,
      next_character_count_reset_unix: data.next_character_count_reset_unix,
      voice_limit: data.voice_limit,
      professional_voice_limit: data.professional_voice_limit,
      can_extend_character_limit: data.can_extend_character_limit,
      allowed_to_extend_character_limit: data.allowed_to_extend_character_limit,
      status: data.status,
    };
  },
});


// =============================================================================
// TELEPHONY TOOLS (SIP / Twilio integration)
// =============================================================================

// Default agent: the user's own AGENT_ID (user-only model, ./secrets resolveAgentId).

server.tool('list-phone-numbers', {
  annotations: { readOnlyHint: true },
  description: 'List phone numbers connected to ElevenLabs with their assigned agent and capabilities.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const response = await elevenLabsRequest(apiKey, '/convai/phone-numbers');

    if (!response.ok) {
      throw new Error(`Failed to list phone numbers: ${response.statusText}`);
    }

    const data = await response.json();
    const numbers = (data as any).phone_numbers || data;

    if (!Array.isArray(numbers)) {
      return { phone_numbers: [] };
    }

    return {
      total: numbers.length,
      phone_numbers: numbers.map((n: any) => ({
        phone_number_id: n.phone_number_id,
        phone_number: n.phone_number,
        label: n.label,
        provider: n.provider,
        agent_id: n.agent_id,
      })),
    };
  },
});

server.tool('import-twilio-number', {
  annotations: { readOnlyHint: false },
  description: 'Import a Twilio phone number into ElevenLabs for inbound and outbound agent calls.',
  parameters: {
    type: 'object',
    properties: {
      phoneNumber: { type: 'string', description: 'E.164 phone number, e.g. +15551234567' },
      label: { type: 'string', description: 'Descriptive label' },
      twilioSid: { type: 'string', description: 'Twilio Account SID (AC...) or API Key SID (SK...)' },
      twilioToken: { type: 'string', description: 'Twilio Auth Token or API Key Secret' },
      agentId: { type: 'string', description: 'Optional agent ID to assign' },
    },
    required: ['phoneNumber', 'label', 'twilioSid', 'twilioToken'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const body: Record<string, unknown> = {
      provider: 'twilio',
      phone_number: args.phoneNumber,
      label: args.label,
      sid: args.twilioSid,
      token: args.twilioToken,
    };

    if (args.agentId) {
      body.agent_id = args.agentId;
    }

    const response = await elevenLabsRequest(apiKey, '/convai/phone-numbers', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to import Twilio number (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return { success: true, phone_number_id: (data as any).phone_number_id };
  },
});

server.tool('outbound-call', {
  annotations: { readOnlyHint: false },
  description: 'Make an outbound phone call from a connected ElevenLabs number using an agent. The agent starts the conversation when the recipient answers.',
  parameters: {
    type: 'object',
    properties: {
      toNumber: { type: 'string', description: 'Destination phone number in E.164 format (e.g. +34600123456)' },
      agentId: { type: 'string', description: 'Optional agent ID. Defaults to Teros Voice Agent' },
      phoneNumberId: { type: 'string', description: 'Optional phone_number_id of the caller number. Defaults to the first connected number' },
      firstMessage: { type: 'string', description: 'Optional first message override for this call' },
      dynamicVariables: { type: 'object', description: 'Optional dynamic variables passed to the agent' },
      notifyChannel: { type: 'boolean', description: 'Notify the initiating channel when the call ends (one-time post-call subscription). Default: true. Set false for fire-and-forget calls.' },
    },
    required: ['toNumber'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    // User-only agent resolution: explicit arg → user AGENT_ID. A user
    // with their own ElevenLabs account calls THEIR agent (agent ids are
    // account-scoped; there is no shared default in the user-only model).
    const agentId = await resolveAgentId(context, args.agentId);
    if (!agentId) {
      throw new Error('No ElevenLabs agent configured: set your AGENT_ID user secret (your account\'s ConvAI agent), or pass agentId explicitly.');
    }

    // Resolve caller number: explicit or first connected number.
    // Also detect the provider (twilio vs sip_trunk) to pick the right
    // outbound-call endpoint for this number.
    let phoneNumberId = args.phoneNumberId as string | undefined;
    let provider = 'twilio';
    {
      const listResponse = await elevenLabsRequest(apiKey, '/convai/phone-numbers');
      if (!listResponse.ok) {
        throw new Error(`Failed to list phone numbers: ${listResponse.statusText}`);
      }
      const listData = await listResponse.json();
      const numbers = (listData as any).phone_numbers || listData;
      if (!Array.isArray(numbers) || numbers.length === 0) {
        throw new Error('No phone numbers connected to ElevenLabs. Import one first (import-twilio-number).');
      }
      const selected = phoneNumberId
        ? numbers.find((n: any) => n.phone_number_id === phoneNumberId)
        : numbers[0];
      if (!selected) {
        throw new Error(`Phone number id not found: ${phoneNumberId}`);
      }
      phoneNumberId = String(selected.phone_number_id);
      provider = selected.provider || 'twilio';
    }

    const body: Record<string, unknown> = {
      agent_id: agentId,
      agent_phone_number_id: phoneNumberId,
      to_number: args.toNumber,
    };

    const cicd: Record<string, unknown> = {};
    if (args.firstMessage) {
      cicd.conversation_config_override = {
        agent: { first_message: args.firstMessage },
      };
    }
    if (args.dynamicVariables) {
      cicd.dynamic_variables = args.dynamicVariables;
    }
    if (Object.keys(cicd).length > 0) {
      body.conversation_initiation_client_data = cicd;
    }

    const outboundPath = provider === 'sip_trunk'
      ? '/convai/sip-trunk/outbound-call'
      : '/convai/twilio/outbound-call';
    const response = await elevenLabsRequest(apiKey, outboundPath, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Outbound call failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Emit elevenlabs.call.started so channel/agent subscribers and Automate
    // starters can react before the post-call webhook arrives. Best-effort:
    // emission failure must never break the tool call.
    try {
      const backend = (context as any).backend;
      if (backend && typeof backend.emitEvent === 'function') {
        await backend.emitEvent({
          event: 'elevenlabs.call.started',
          payload: buildCallStartedPayload({
            conversationId: (data as any).conversation_id ?? null,
            callSid: (data as any).sip_call_id ?? null,
            toNumber: args.toNumber,
            agentId,
            phoneNumberId,
            initiatorChannelId: (context as any).execution?.channelId ?? null,
            initiatorAgentId: (context as any).execution?.agentId ?? null,
          }),
        });
      }
    } catch (err) {
      console.error('[mca.elevenlabs] Failed to emit elevenlabs.call.started:', (err as Error).message);
    }

    // Auto-subscribe the initiating channel to THIS call's post-call event
    // (spec §3.3: notifyChannel defaults to true). Best-effort: never fails
    // the call — the outcome is surfaced in the tool result instead.
    let notifyChannel: NotifyOutcome = { subscribed: false };
    try {
      notifyChannel = await subscribeInitiatorChannelToPostCall({
        backend: (context as any).backend,
        notifyChannel: args.notifyChannel,
        conversationId: (data as any).conversation_id ?? null,
        initiatorChannelId: (context as any).execution?.channelId ?? null,
      });
    } catch (err) {
      console.error('[mca.elevenlabs] Post-call auto-subscribe failed:', (err as Error).message);
    }

    return {
      success: (data as any).success,
      message: (data as any).message,
      conversation_id: (data as any).conversation_id,
      sip_call_id: (data as any).sip_call_id,
      notifyChannel,
    };
  },
});

// resolveAgentId lives in ./secrets (explicit → user AGENT_ID, user-only
// model since 2026-10-26): a user with their own ElevenLabs account has
// their own ConvAI agents.

server.tool('get-conversation', {
  annotations: { readOnlyHint: true },
  description: 'Get details of an ElevenLabs conversation (transcript, analysis, status) by its ID.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'The conversation ID' },
    },
    required: ['conversationId'],
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const response = await elevenLabsRequest(apiKey, `/convai/conversations/${args.conversationId}`);

    if (!response.ok) {
      throw new Error(`Failed to get conversation: ${response.statusText}`);
    }

    const data = await response.json();
    const d = data as any;
    return {
      conversation_id: d.conversation_id,
      agent_id: d.agent_id,
      status: d.status,
      start_time_unix: d.start_time_unix,
      call_duration_secs: d.call_duration_secs,
      transcript: (d.transcript || []).map((t: any) => ({ role: t.role, message: t.message, time_in_call_secs: t.time_in_call_secs })),
      analysis: d.analysis,
    };
  },
});

// =============================================================================
// CONVAI AGENT MANAGEMENT
// =============================================================================
// Tools to inspect and edit the ElevenLabs ConvAI agent configuration
// (system prompt, first message, ASR keywords). Added after the 2026-10-19
// incident where a stale demo prompt contaminated real calls and the only
// way to fix it was raw curl against the ElevenLabs API.
// =============================================================================
// LIST AGENTS
// =============================================================================

server.tool('list-agents', {
  annotations: { readOnlyHint: true },
  description:
    'List the ConvAI agents in the ElevenLabs account (id, name, phone numbers assigned). Use this to discover agent IDs for get-agent / update-agent instead of reading secrets manually.',
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Search term to filter agents by name (case-insensitive, optional)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of agents to return (optional, default: all)',
      },
    },
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const search = (args.search as string)?.toLowerCase();
    const limit = args.limit as number | undefined;

    const response = await elevenLabsRequest(apiKey, '/convai/agents');

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list agents (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    let agents = (data as any).agents || [];

    // Apply search filter
    if (search) {
      agents = agents.filter((agent: any) => agent.name?.toLowerCase().includes(search));
    }

    // Apply limit
    if (limit && limit > 0) {
      agents = agents.slice(0, limit);
    }

    // Phone numbers are not included in the list response — fetch assignments
    // from /convai/phone-numbers and map agent_id -> number(s).
    let phoneMap = new Map<string, string[]>();
    const pnResponse = await elevenLabsRequest(apiKey, '/convai/phone-numbers');
    if (pnResponse.ok) {
      const pnData = await pnResponse.json();
      const numbers = (pnData as any).phone_numbers || pnData;
      if (Array.isArray(numbers)) {
        phoneMap = numbers.reduce((map: Map<string, string[]>, n: any) => {
          if (n.agent_id) {
            const list = map.get(n.agent_id) || [];
            list.push(n.phone_number);
            map.set(n.agent_id, list);
          }
          return map;
        }, new Map());
      }
    }

    const simplifiedAgents = agents.map((agent: any) => ({
      agent_id: agent.agent_id,
      name: agent.name,
      phone_numbers: phoneMap.get(agent.agent_id) || [],
    }));

    return {
      agents: simplifiedAgents,
      total: simplifiedAgents.length,
      filtered: !!(search || limit),
    };
  },
});


server.tool('get-agent', {
  annotations: { readOnlyHint: true },
  description:
    'Get the full configuration of an ElevenLabs ConvAI agent (name, first message, system prompt, ASR keywords, tools, phone numbers, metadata). If agentId is omitted, resolves user-first: the AGENT_ID user secret, then the AGENT_ID system secret, then the default Teros Voice Agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description:
          'Optional ElevenLabs agent ID (e.g. agent_8101kb0xa4jje0s963kw6nhfmdh7). Defaults to the AGENT_ID secret resolved user-first (user secret, then system secret, then the default Teros Voice Agent).',
      },
    },
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const agentId = await resolveAgentId(context, args.agentId);
    if (!agentId) {
      throw new Error('No ElevenLabs agent configured: set your AGENT_ID user secret (your account\'s ConvAI agent), or pass agentId explicitly.');
    }
    const response = await elevenLabsRequest(apiKey, `/convai/agents/${agentId}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get agent ${agentId} (${response.status}): ${errorText}`);
    }

    const d = (await response.json()) as any;
    const conv = d.conversation_config ?? {};
    const agentCfg = conv.agent ?? {};
    const promptCfg = agentCfg.prompt ?? {};
    const asrCfg = conv.asr ?? {};

    return {
      agent_id: d.agent_id,
      name: d.name,
      first_message: agentCfg.first_message,
      system_prompt: promptCfg.prompt,
      prompt_config: {
        llm: promptCfg.llm,
        temperature: promptCfg.temperature,
        max_tokens: promptCfg.max_tokens,
        tool_ids: promptCfg.tool_ids,
        tools: promptCfg.tools,
        knowledge_base: promptCfg.knowledge_base,
        custom_llm: promptCfg.custom_llm,
      },
      language: agentCfg.language,
      dynamic_variables: agentCfg.dynamic_variables,
      asr: {
        quality: asrCfg.quality,
        provider: asrCfg.provider,
        user_input_audio_format: asrCfg.user_input_audio_format,
        keywords: asrCfg.keywords,
      },
      tts: conv.tts,
      turn: conv.turn,
      conversation: conv.conversation,
      phone_numbers: d.phone_numbers,
      access_info: d.access_info,
      metadata: d.metadata,
      created_at_unix_secs: d.created_at_unix_secs,
      last_updated_unix_secs: d.last_updated_unix_secs,
    };
  },
});

server.tool('update-agent', {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    'Update an ElevenLabs ConvAI agent configuration. Partial merge: only the fields you pass are modified — tools, TTS, phone numbers, and the rest of the conversation_config stay intact. Use get-agent first to inspect the current state. If agentId is omitted, resolves the AGENT_ID secret user-first (user secret, then system secret).',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description:
          'Optional ElevenLabs agent ID. Defaults to the AGENT_ID secret resolved user-first (user secret, then system secret, then the default Teros Voice Agent).',
      },
      name: {
        type: 'string',
        description: 'New display name for the agent.',
      },
      firstMessage: {
        type: 'string',
        description:
          'New first message (the opening line the agent speaks when the call connects). Maps to conversation_config.agent.first_message.',
      },
      systemPrompt: {
        type: 'string',
        description:
          'New system prompt. Maps to conversation_config.agent.prompt.prompt. Keep the {{call_context}} placeholder if you want per-call context to keep working.',
      },
      asrKeywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'New ASR keyword list (replaces the existing one). Maps to conversation_config.asr.keywords. Pass an empty array to clear.',
      },
    },
  },
  handler: async (args: any, context) => {
    const apiKey = await resolveApiKey(context);

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const agentId = await resolveAgentId(context, args.agentId);
    if (!agentId) {
      throw new Error('No ElevenLabs agent configured: set your AGENT_ID user secret (your account\'s ConvAI agent), or pass agentId explicitly.');
    }

    // Build a partial-merge body: only include the keys the caller passed.
    // The ElevenLabs PATCH endpoint merges conversation_config deep enough
    // that untouched sibling keys (tts, turn, tools, phone_numbers...) stay
    // as they are.
    const body: Record<string, unknown> = {};
    if (typeof args.name === 'string') {
      body.name = args.name;
    }

    const agentPatch: Record<string, unknown> = {};
    if (typeof args.firstMessage === 'string') {
      agentPatch.first_message = args.firstMessage;
    }
    if (typeof args.systemPrompt === 'string') {
      agentPatch.prompt = { prompt: args.systemPrompt };
    }

    const convPatch: Record<string, unknown> = {};
    if (Object.keys(agentPatch).length > 0) {
      convPatch.agent = agentPatch;
    }
    if (Array.isArray(args.asrKeywords)) {
      convPatch.asr = { keywords: args.asrKeywords };
    }
    if (Object.keys(convPatch).length > 0) {
      body.conversation_config = convPatch;
    }

    if (Object.keys(body).length === 0) {
      throw new Error(
        'Nothing to update: pass at least one of name, firstMessage, systemPrompt, asrKeywords.',
      );
    }

    const response = await elevenLabsRequest(apiKey, `/convai/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update agent ${agentId} (${response.status}): ${errorText}`);
    }

    const d = (await response.json()) as any;
    const conv = d.conversation_config ?? {};
    const agentCfg = conv.agent ?? {};
    const promptCfg = agentCfg.prompt ?? {};
    const asrCfg = conv.asr ?? {};

    return {
      success: true,
      agent_id: d.agent_id,
      name: d.name,
      first_message: agentCfg.first_message,
      system_prompt: promptCfg.prompt,
      asr_keywords: asrCfg.keywords,
      last_updated_unix_secs: d.last_updated_unix_secs,
      // Echo what was sent so the caller can confirm the partial merge.
      updated_fields: Object.keys(body),
    };
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[ElevenLabs MCA] Fatal error:', error);
  process.exit(1);
});
