/**
 * LLM Recording System
 *
 * Records and plays back LLM API calls for testing.
 * This allows running E2E tests without making actual API calls.
 *
 * Usage:
 * 1. Recording Mode: Use RecordingLLMAdapter to wrap a real adapter
 * 2. Playback Mode: Use MockLLMAdapter to replay recorded responses
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from '../llm/ILLMClient';

/**
 * Recorded LLM call
 */
export interface RecordedCall {
  /** Hash of input for matching */
  inputHash: string;
  /** Original input (for debugging) */
  input: {
    messages: any[];
    tools?: any[];
    systemPrompt?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Recorded streaming events */
  events: RecordedEvent[];
  /** Final response */
  response: LLMResponse;
  /** Timestamp when recorded */
  recordedAt: string;
}

export type RecordedEvent =
  | { type: 'text'; chunk: string; delay?: number }
  | { type: 'text_end'; delay?: number }
  | { type: 'tool_call'; toolCall: ToolCall; delay?: number };

/**
 * Recording file format
 */
export interface Recording {
  version: '1.0';
  calls: RecordedCall[];
  metadata: {
    createdAt: string;
    description?: string;
  };
}

/**
 * Create a hash from LLM input for matching recordings
 */
export function hashInput(options: StreamMessageOptions): string {
  // Normalize messages to remove timestamps and IDs that would vary
  const normalized = {
    messages: options.messages.map((m) => ({
      role: m.info.role,
      parts: m.parts.map((p) => {
        if (p.type === 'text') return { type: 'text', text: (p as any).text };
        if (p.type === 'tool')
          return {
            type: 'tool',
            name: (p as any).tool,
            input: (p as any).state?.input,
          };
        return { type: p.type };
      }),
    })),
    tools: options.tools?.map((t) => t.name).sort(),
    // Ignore systemPrompt variations - they often contain dynamic content
  };

  const json = JSON.stringify(normalized, null, 0);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Recording LLM Adapter - Wraps a real adapter and records calls
 */
export class RecordingLLMAdapter implements ILLMClient {
  private calls: RecordedCall[] = [];

  constructor(
    private realAdapter: ILLMClient,
    private recordingPath?: string,
  ) {}

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const inputHash = hashInput(options);
    const events: RecordedEvent[] = [];

    // Wrap callbacks to record events. Capturamos el delay (ms desde el evento anterior) para que
    // el replay reproduzca el RITMO del streaming — necesario para tests de timing como cortar un
    // turno en curso (Stop): sin pausas el turno terminaría al instante y no habría qué cortar.
    const originalCallbacks = options.callbacks;
    let lastEventAt = Date.now();
    const sinceLast = () => {
      const now = Date.now();
      const d = now - lastEventAt;
      lastEventAt = now;
      return d;
    };
    const wrappedCallbacks = {
      onText: async (chunk: string) => {
        events.push({ type: 'text', chunk, delay: sinceLast() });
        await originalCallbacks?.onText?.(chunk);
      },
      onTextEnd: async () => {
        events.push({ type: 'text_end', delay: sinceLast() });
        await originalCallbacks?.onTextEnd?.();
      },
      onToolCall: async (toolCall: ToolCall) => {
        events.push({ type: 'tool_call', toolCall, delay: sinceLast() });
        await originalCallbacks?.onToolCall?.(toolCall);
      },
      onThinking: originalCallbacks?.onThinking,
    };

    // Call real adapter
    const response = await this.realAdapter.streamMessage({
      ...options,
      callbacks: wrappedCallbacks,
    });

    // Record the call
    const recordedCall: RecordedCall = {
      inputHash,
      input: {
        messages: options.messages.map((m) => ({
          role: m.info.role,
          parts: m.parts,
        })),
        tools: options.tools,
        systemPrompt: options.systemPrompt,
        model: options.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      },
      events,
      response,
      recordedAt: new Date().toISOString(),
    };

    this.calls.push(recordedCall);

    // Write-through: persistir tras cada call. El factory crea un adapter por sesión/agente, así
    // que no hay un hook de cierre único donde volcar; grabar incremental evita perder cassettes.
    if (this.recordingPath) {
      try {
        this.saveRecording();
      } catch (e) {
        console.error(`[LLMRecorder] no se pudo persistir el recording: ${(e as Error).message}`);
      }
    }

    return response;
  }

  getProviderInfo() {
    return {
      ...this.realAdapter.getProviderInfo(),
      recording: true,
    };
  }

  /**
   * Get all recorded calls
   */
  getRecordedCalls(): RecordedCall[] {
    return this.calls;
  }

  /**
   * Save recordings to file
   */
  saveRecording(path?: string): void {
    const filePath = path || this.recordingPath;
    if (!filePath) {
      throw new Error('No recording path specified');
    }

    // Merge con el recording existente en disco: varias instancias del adapter (una por sesión/
    // agente) graban al MISMO archivo. Dedup por inputHash → la última grabación de un input gana.
    const byHash = new Map<string, RecordedCall>();
    if (existsSync(filePath)) {
      try {
        const prev: Recording = JSON.parse(readFileSync(filePath, 'utf-8'));
        for (const c of prev.calls) byHash.set(c.inputHash, c);
      } catch {
        // archivo parcial/corrupto → se reescribe desde cero
      }
    }
    for (const c of this.calls) byHash.set(c.inputHash, c);

    const recording: Recording = {
      version: '1.0',
      calls: [...byHash.values()],
      metadata: {
        createdAt: new Date().toISOString(),
      },
    };

    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(filePath, JSON.stringify(recording, null, 2));
  }
}

/**
 * Tope del delay reproducido entre eventos en replay. Un cap muy bajo deja el turno casi
 * instantáneo y expone un race en specs que esperan eventos de ciclo de vida tras enviar (p.ej.
 * "responde con Kimi real" espera `queue_state:done` → el evento llega antes de que el test lo
 * escuche). 120ms da margen sin ralentizar de forma apreciable: el grueso de la suite son los
 * ~47 specs NO-@llm, no estos delays (los @llm suman ~1.5 min). La optimización de coste real es
 * el trigger del job E2E (solo al integrar a dev/main), no este cap. TER-553.
 */
const REPLAY_MAX_DELAY_MS = 120;

/**
 * Mock LLM Adapter - Replays recorded responses
 */
export class MockLLMAdapter implements ILLMClient {
  private recording: Recording;
  private callIndex = 0;
  private mode: 'sequential' | 'hash-match' = 'hash-match';

  constructor(
    recordingOrPath: Recording | string,
    options?: { mode?: 'sequential' | 'hash-match' },
  ) {
    if (typeof recordingOrPath === 'string') {
      const content = readFileSync(recordingOrPath, 'utf-8');
      this.recording = JSON.parse(content);
    } else {
      this.recording = recordingOrPath;
    }

    if (options?.mode) {
      this.mode = options.mode;
    }
  }

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    let call: RecordedCall | undefined;

    if (this.mode === 'sequential') {
      call = this.recording.calls[this.callIndex++];
    } else {
      // Hash match mode — match EXACTO por hash del input. SIN fallback por
      // "mismo número de mensajes": ese fallback devolvía la cassette equivocada
      // EN SILENCIO cuando el input variaba (channelId/timestamp/texto) → verde
      // engañoso (un turno reproducía otra cassette). Un miss en replay debe ser
      // RUIDOSO → regrabar o arreglar el determinismo. TER-563.
      const inputHash = hashInput(options);
      call = this.recording.calls.find((c) => c.inputHash === inputHash);

      if (!call) {
        const available = this.recording.calls.map((c) => c.inputHash).join(', ');
        throw new Error(
          `No recorded LLM response for input hash ${inputHash}. ` +
            `Available hashes: [${available}]. El input cambió respecto a la ` +
            `grabación (¿determinismo roto o hace falta regrabar?). ` +
            `Ver scripts/playwright-smoke/recordings/README.md.`,
        );
      }
    }

    if (!call) {
      // Modo 'sequential': el índice se salió del rango de cassettes grabadas.
      throw new Error(
        `No recorded response found for input. ` +
          `Mode: ${this.mode}, ` +
          `Available calls: ${this.recording.calls.length}, ` +
          `Call index: ${this.callIndex}`,
      );
    }

    // Replay events honrando el ritmo grabado y la cancelación:
    // - delay capeado a REPLAY_MAX_DELAY_MS: un turno largo no se reproduce en tiempo real, pero
    //   sí mantiene pausas suficientes para que un test vea el turno "en curso" (Stop).
    // - options.signal: si el caller aborta (el usuario corta el turno), paramos el stream → así
    //   el replay reproduce la cancelación de un turno en curso, no solo la respuesta completa.
    for (const event of call.events) {
      if (options.signal?.aborted) break;
      if (event.delay) {
        await new Promise((r) => setTimeout(r, Math.min(event.delay, REPLAY_MAX_DELAY_MS)));
      }
      if (options.signal?.aborted) break;

      switch (event.type) {
        case 'text':
          await options.callbacks?.onText?.(event.chunk);
          break;
        case 'text_end':
          await options.callbacks?.onTextEnd?.();
          break;
        case 'tool_call':
          await options.callbacks?.onToolCall?.(event.toolCall);
          break;
      }
    }

    return call.response;
  }

  getProviderInfo() {
    return {
      name: 'MockLLM',
      model: 'mock',
      capabilities: {
        streaming: true,
        tools: true,
        thinking: false,
        vision: false,
      },
    };
  }

  /**
   * Reset call index (for sequential mode)
   */
  reset(): void {
    this.callIndex = 0;
  }
}

/**
 * Create a simple mock response inline (for simple tests)
 */
export function createSimpleMockAdapter(
  responses: {
    text?: string;
    toolCalls?: ToolCall[];
    stopReason?: LLMResponse['stopReason'];
  }[],
): MockLLMAdapter {
  const calls: RecordedCall[] = responses.map((r, i) => {
    const events: RecordedEvent[] = [];

    if (r.text) {
      // Split text into chunks for realistic streaming
      const chunks = r.text.match(/.{1,50}/g) || [r.text];
      for (const chunk of chunks) {
        events.push({ type: 'text', chunk });
      }
      events.push({ type: 'text_end' });
    }

    if (r.toolCalls) {
      for (const toolCall of r.toolCalls) {
        events.push({ type: 'tool_call', toolCall });
      }
    }

    return {
      inputHash: `mock-${i}`,
      input: { messages: [] },
      events,
      response: {
        stopReason: r.stopReason || (r.toolCalls ? 'tool_calls' : 'end_turn'),
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      recordedAt: new Date().toISOString(),
    };
  });

  return new MockLLMAdapter(
    {
      version: '1.0',
      calls,
      metadata: { createdAt: new Date().toISOString() },
    },
    { mode: 'sequential' },
  );
}

/**
 * Helper to load or create a recording
 */
export function loadOrCreateRecording(path: string, realAdapter?: ILLMClient): ILLMClient {
  if (existsSync(path)) {
    console.log(`Loading recording from ${path}`);
    return new MockLLMAdapter(path);
  }

  if (!realAdapter) {
    throw new Error(`Recording not found at ${path} and no real adapter provided`);
  }

  console.log(`Recording mode: will save to ${path}`);
  return new RecordingLLMAdapter(realAdapter, path);
}
