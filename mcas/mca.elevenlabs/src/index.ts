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
  const headers = {
    'xi-api-key': apiKey,
    ...options.headers,
  };

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

async function generatePodcast(apiKey: string, scriptPath: string): Promise<string> {
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

    // Determine output path
    const outputFormat = script.config?.output_format?.startsWith('mp3') ? 'mp3' : 'wav';
    const defaultOutput = join('/workspace', `podcast-${Date.now()}.${outputFormat}`);
    const outputPath = script.config?.output || defaultOutput;

    // Ensure output directory exists
    await mkdir(dirname(outputPath), { recursive: true });

    // Combine all audio files using ffmpeg concat
    await execAsync(`ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`);

    console.error(`[Podcast] Podcast generated successfully: ${outputPath}`);

    return outputPath;
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
  description: 'Internal health check tool. Verifies API key and connectivity to ElevenLabs.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const secrets = await context.getSystemSecrets();
      const apiKey = secrets.API_KEY;

      if (!apiKey) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'ElevenLabs API key not configured', {
          type: 'admin_action',
          description: 'Configure the API_KEY in system secrets',
        });
      } else {
        // Validate API key by making a simple request
        try {
          const response = await elevenLabsRequest(apiKey, '/user/subscription');

          if (!response.ok) {
            if (response.status === 401) {
              builder.addIssue('AUTH_INVALID', 'ElevenLabs API key is invalid', {
                type: 'admin_action',
                description: 'The configured API key is invalid. Please update it.',
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
    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.API_KEY;

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

    // Save audio file
    const timestamp = Date.now();
    const extension = outputFormat.startsWith('mp3') ? 'mp3' : 'wav';
    const defaultPath = join('/workspace', `tts-${timestamp}.${extension}`);
    const filePath = outputPath || defaultPath;

    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, audioBuffer);

    return {
      success: true,
      filePath,
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
    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.API_KEY;

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
    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.API_KEY;

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
    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.API_KEY;

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const scriptPath = args.scriptPath as string;

    if (!scriptPath) {
      throw new Error('scriptPath is required');
    }

    const outputPath = await generatePodcast(apiKey, scriptPath);

    return {
      success: true,
      outputPath,
      message: 'Conversation generated successfully',
    };
  },
});

// =============================================================================
// GET SUBSCRIPTION
// =============================================================================

server.tool('get-subscription', {
  description:
    'Get information about the current ElevenLabs subscription including character usage and limits.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.API_KEY;

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
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[ElevenLabs MCA] Fatal error:', error);
  process.exit(1);
});
