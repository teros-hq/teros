/**
 * AgentError tests (TER-469).
 *
 * Red de la jerarquía de errores + regression del bug retry-after:
 * `LLMError.fromAnthropicError` leía `headers["retry-after"]` con bracket
 * access, pero el SDK de Anthropic (≥0.30, aquí 0.71) pasa un `Headers`
 * nativo donde eso es SIEMPRE undefined → el branch del mensaje con tiempo
 * de recuperación y todo el context de rate-limit estaban muertos en
 * producción. Los tests del 429 usan `APIError.generate` REAL del SDK con
 * `new Headers()` (mock fiel al boundary — lección TER-369).
 */

import { APIError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'bun:test';
import {
  AgentError,
  LLMError,
  NetworkError,
  SessionError,
  ToolError,
  ValidationError,
} from './AgentError';

/**
 * Construye el error EXACTAMENTE como lo emite el SDK de Anthropic:
 * `client.js` pasa el body JSON COMPLETO (envelope `{type:'error', error:…}`)
 * como `errorResponse` y `message=undefined` cuando el body parsea, de modo
 * que `apiError.error` es el envelope y `apiError.message` acaba siendo
 * `"<status> <JSON del envelope>"` (vía `makeMessage`).
 */
function sdkError(
  status: number,
  body: { type: string; message: string },
  headers?: Record<string, string>,
): APIError {
  return APIError.generate(
    status,
    { type: 'error', error: body },
    undefined,
    new Headers(headers ?? {}),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentError base
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentError (base)', () => {
  it('exposes type/userMessage/message/context/originalError exactly as given', () => {
    const original = new Error('low-level boom');
    const err = new AgentError('llm', 'Friendly', 'Technical detail', { a: 1 }, original);

    expect(err.type).toBe('llm');
    expect(err.userMessage).toBe('Friendly');
    expect(err.message).toBe('Technical detail');
    expect(err.context).toEqual({ a: 1 });
    expect(err.originalError).toBe(original);
    expect(err.name).toBe('AgentError');
    expect(err.timestamp).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(Error);
  });

  it('getUserMessage prefixes the ❌ emoji', () => {
    const err = new AgentError('unknown', 'Algo falló', 'tech');
    expect(err.getUserMessage()).toBe('❌ Algo falló');
  });

  it('getLogContext returns the exact structured payload', () => {
    const original = new Error('boom');
    const err = new AgentError('tool', 'U', 'T', { k: 'v' }, original);
    expect(err.getLogContext()).toEqual({
      type: 'tool',
      message: 'T',
      userMessage: 'U',
      context: { k: 'v' },
      timestamp: err.timestamp,
      error: 'boom',
      stack: original.stack,
    });
  });

  it('adopts the originalError stack when present', () => {
    const original = new Error('with-stack');
    const err = new AgentError('llm', 'U', 'T', {}, original);
    expect(err.stack).toBe(original.stack!);
  });

  it('keeps its own stack when there is no originalError', () => {
    const err = new AgentError('llm', 'U', 'T');
    expect(err.stack).toBeDefined();
    expect(err.context).toEqual({});
    expect(err.originalError).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LLMError.fromAnthropicError — 429 rate limit (regression del bug Headers)
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMError.fromAnthropicError — 429 with native Headers (regression)', () => {
  it('extracts retry-after from a REAL Headers instance (the production shape)', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(429, { type: 'rate_limit_error', message: 'rate limited' }, { 'retry-after': '120' }),
    );

    expect(err.userMessage).toBe('⏳ Rate limit reached. The service will recover in ~2m.');
    expect(err.message).toBe('Anthropic API rate limit exceeded (retry-after: 120s)');
    expect(err.context.isRateLimit).toBe(true);
    expect(err.context.retryAfterSecs).toBe(120);
    expect(err.context.retryAfterMs).toBe(120_000);
    expect(err.context.source).toBe('Claude');
    expect(err.context.statusCode).toBe(429);
    expect(err.context.errorType).toBe('rate_limit_error');
    // resetAt ≈ now + 120s (tolerancia 5s por el reloj del test)
    expect(Math.abs(err.context.resetAt - (Date.now() + 120_000))).toBeLessThan(5_000);
  });

  it('formats hours+minutes: 3720s → "~1h 2m"', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(429, { type: 'rate_limit_error', message: 'rl' }, { 'retry-after': '3720' }),
    );
    expect(err.userMessage).toBe('⏳ Rate limit reached. The service will recover in ~1h 2m.');
  });

  it('formats whole hours: 7200s → "~2h"', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(429, { type: 'rate_limit_error', message: 'rl' }, { 'retry-after': '7200' }),
    );
    expect(err.userMessage).toBe('⏳ Rate limit reached. The service will recover in ~2h.');
  });

  it('rounds sub-minute up: 30s → "~1m"', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(429, { type: 'rate_limit_error', message: 'rl' }, { 'retry-after': '30' }),
    );
    expect(err.userMessage).toBe('⏳ Rate limit reached. The service will recover in ~1m.');
  });

  it('429 without retry-after → generic message, unknown in technical', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(429, { type: 'rate_limit_error', message: 'rl' }),
    );
    expect(err.userMessage).toBe('⏳ Rate limit reached. Try again in a few minutes.');
    expect(err.message).toBe('Anthropic API rate limit exceeded (retry-after: unknowns)');
    expect(err.context.retryAfterSecs).toBeUndefined();
    expect(err.context.isRateLimit).toBe(true);
  });

  it('non-numeric retry-after (HTTP-date form) is treated as absent, not NaN', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(
        429,
        { type: 'rate_limit_error', message: 'rl' },
        { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      ),
    );
    expect(err.userMessage).toBe('⏳ Rate limit reached. Try again in a few minutes.');
    expect(err.context.retryAfterSecs).toBeUndefined();
    expect(err.context.resetAt).toBeUndefined();
  });

  it('legacy plain-object headers still work (backwards compat)', () => {
    const legacyError = {
      status: 429,
      message: 'rate limited',
      headers: { 'retry-after': '60' },
    };
    const err = LLMError.fromAnthropicError(legacyError);
    expect(err.userMessage).toBe('⏳ Rate limit reached. The service will recover in ~1m.');
    expect(err.context.retryAfterSecs).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LLMError.fromAnthropicError — resto de status codes
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMError.fromAnthropicError — other statuses', () => {
  it('401 → configuration error', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(401, { type: 'authentication_error', message: 'invalid x-api-key' }),
    );
    expect(err.userMessage).toBe('Configuration error. Contact support.');
    expect(err.message).toBe('Anthropic API authentication failed (invalid API key)');
    expect(err.type).toBe('llm');
    expect(err.name).toBe('LLMError');
  });

  it('400 prompt-too-long → extracts token counts into the user message', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(400, {
        type: 'invalid_request_error',
        message: 'prompt is too long: 215000 tokens > 200000 maximum',
      }),
    );
    expect(err.userMessage).toBe(
      'The conversation has grown too long (215000 tokens, max 200000). Auto-compaction will be triggered automatically.',
    );
    // Exacto: verifica que errorMessage es el literal del provider (extraído
    // del envelope anidado), no el JSON serializado del body completo.
    expect(err.message).toBe(
      'Anthropic API prompt too long: prompt is too long: 215000 tokens > 200000 maximum',
    );
    // CTX-007: flag estructural para que TurnDriver.isPromptTooLongError lo
    // detecte sin depender del wording.
    expect(err.context.isContextLengthError).toBe(true);
  });

  it('400 with only the "tokens >" marker (alternate upstream wording) → too-long branch', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(400, {
        type: 'invalid_request_error',
        message: 'input length exceeds limit: 250000 tokens > 200000 maximum',
      }),
    );
    expect(err.userMessage).toBe(
      'The conversation has grown too long (250000 tokens, max 200000). Auto-compaction will be triggered automatically.',
    );
  });

  it('400 prompt-too-long without parseable counts → message without token info', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(400, { type: 'invalid_request_error', message: 'prompt is too long' }),
    );
    expect(err.userMessage).toBe(
      'The conversation has grown too long . Auto-compaction will be triggered automatically.',
    );
  });

  it('400 generic → rephrase message, raw preserved, NOT flagged as overflow', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(400, { type: 'invalid_request_error', message: 'bad field' }),
    );
    expect(err.userMessage).toBe('There was a problem with your message. Try rephrasing it.');
    // CTX-007: se preserva el mensaje raw del provider en vez de colapsarlo al
    // string fijo "Anthropic API bad request".
    expect(err.message).toBe('Anthropic API bad request: bad field');
    // Un 400 no-overflow NO debe disparar compactación.
    expect(err.context.isContextLengthError).toBeFalsy();
  });

  it('500 → temporarily unavailable', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(500, { type: 'api_error', message: 'internal server error' }),
    );
    expect(err.userMessage).toBe('The AI service is temporarily unavailable. Try again later.');
    expect(err.message).toBe('Anthropic API server error');
  });

  it('529 (overloaded) also maps to the >=500 branch', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(529, { type: 'overloaded_error', message: 'overloaded' }),
    );
    expect(err.userMessage).toBe('The AI service is temporarily unavailable. Try again later.');
  });

  it('no status + timeout in message → timeout branch', () => {
    const err = LLMError.fromAnthropicError(new Error('Request timeout after 60000ms'));
    expect(err.userMessage).toBe('The response is taking too long. Try again.');
    expect(err.message).toBe('Anthropic API timeout');
  });

  it('unrecognized error → default cannot-connect message with original detail', () => {
    const err = LLMError.fromAnthropicError(new Error('weird failure'));
    expect(err.userMessage).toBe('Cannot connect to the AI model. Try again in a few seconds.');
    expect(err.message).toBe('Anthropic API error: weird failure');
    expect(err.context.originalMessage).toBe('weird failure');
  });

  it('reads statusCode fallback field and merges caller context', () => {
    const err = LLMError.fromAnthropicError(
      { statusCode: 401, message: 'denied' },
      { agentId: 'agent_1' },
    );
    expect(err.userMessage).toBe('Configuration error. Contact support.');
    expect(err.context.agentId).toBe('agent_1');
    expect(err.context.statusCode).toBe(401);
  });

  it('preserves the original error as originalError', () => {
    const original = sdkError(500, { type: 'api_error', message: 'ise' });
    const err = LLMError.fromAnthropicError(original);
    expect(err.originalError).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LLMError.fromAnthropicError — CTX-007 overflow detection for Zhipu/MiniMax
//
// Zhipu y MiniMax pasan por este mismo chokepoint (ambos usan @anthropic-ai/sdk
// contra su endpoint Anthropic-compatible). Su wording de overflow NO es el de
// Anthropic ("prompt is too long"/"tokens >"), así que antes caían al else →
// "Anthropic API bad request" sin flag → TurnDriver nunca recuperaba → fallo
// duro. El detector estructural compartido debe reconocerlos igual.
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMError.fromAnthropicError — CTX-007 overflow (non-Anthropic wording)', () => {
  it('Zhipu-style 400 overflow → flagged + raw preserved (was collapsed before)', () => {
    const zhipuMsg =
      "1214: The tokens of your input have exceeded the model's maximum context length";
    const err = LLMError.fromAnthropicError(
      sdkError(400, { type: 'invalid_request_error', message: zhipuMsg }),
    );
    expect(err.context.isContextLengthError).toBe(true);
    expect(err.userMessage).toContain('too long');
    // Regresión: el mensaje raw del provider se preserva, NO se colapsa.
    expect(err.message).toBe(`Anthropic API prompt too long: ${zhipuMsg}`);
    expect(err.message).not.toBe('Anthropic API bad request');
  });

  it('MiniMax-style 400 overflow → flagged as context-length', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(400, {
        type: 'invalid_request_error',
        message: "invalid params: total tokens exceed the model's maximum context length limit",
      }),
    );
    expect(err.context.isContextLengthError).toBe(true);
  });

  it('413 Payload Too Large → flagged as context-length regardless of wording', () => {
    const err = LLMError.fromAnthropicError(
      sdkError(413, { type: 'invalid_request_error', message: 'request entity too large' }),
    );
    expect(err.context.isContextLengthError).toBe(true);
    expect(err.userMessage).toContain('too long');
  });

  it('empty upstream message on generic 400 → keeps legacy fixed string, no flag', () => {
    const err = LLMError.fromAnthropicError({ status: 400, message: '' });
    expect(err.message).toBe('Anthropic API bad request');
    expect(err.context.isContextLengthError).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subclases restantes
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolError.fromToolExecution', () => {
  it('builds exact user/technical messages and context', () => {
    const original = new Error('ENOENT');
    const err = ToolError.fromToolExecution('read-file', original, { mcaId: 'mca.fs' });

    expect(err.userMessage).toBe('Error executing tool "read-file". Try again.');
    expect(err.message).toBe('Tool execution failed: read-file - ENOENT');
    expect(err.context).toEqual({ mcaId: 'mca.fs', toolName: 'read-file', originalMessage: 'ENOENT' });
    expect(err.type).toBe('tool');
    expect(err.name).toBe('ToolError');
    expect(err.originalError).toBe(original);
    expect(err).toBeInstanceOf(AgentError);
  });
});

describe('SessionError.fromStorageError', () => {
  it('embeds the operation in the technical message and context', () => {
    const original = new Error('mongo down');
    const err = SessionError.fromStorageError('writePart', original);

    expect(err.userMessage).toBe(
      'Error saving history. Your response will be sent, but it may not be saved in the history.',
    );
    expect(err.message).toBe('Session storage error (writePart): mongo down');
    expect(err.context).toEqual({ operation: 'writePart', originalMessage: 'mongo down' });
    expect(err.name).toBe('SessionError');
    expect(err.type).toBe('session');
  });
});

describe('ValidationError.fromInvalidInput', () => {
  it('builds field/reason payload without originalError', () => {
    const err = ValidationError.fromInvalidInput('email', 'formato inválido');

    expect(err.userMessage).toBe('Your message has a problem: formato inválido. Try again.');
    expect(err.message).toBe('Validation error: email - formato inválido');
    expect(err.context).toEqual({ field: 'email', reason: 'formato inválido' });
    expect(err.originalError).toBeUndefined();
    expect(err.name).toBe('ValidationError');
    expect(err.type).toBe('validation');
  });
});

describe('NetworkError.fromNetworkError', () => {
  it('wraps connection failures with the standard message', () => {
    const original = new Error('ECONNREFUSED');
    const err = NetworkError.fromNetworkError(original, { host: 'api.anthropic.com' });

    expect(err.userMessage).toBe('Connection problems. Check your internet and try again.');
    expect(err.message).toBe('Network error: ECONNREFUSED');
    expect(err.context).toEqual({ host: 'api.anthropic.com', originalMessage: 'ECONNREFUSED' });
    expect(err.name).toBe('NetworkError');
    expect(err.type).toBe('network');
  });
});

describe('hierarchy', () => {
  it('every subclass is an AgentError and an Error', () => {
    const errors = [
      new LLMError('u', 't'),
      new ToolError('u', 't'),
      new SessionError('u', 't'),
      new ValidationError('u', 't'),
      new NetworkError('u', 't'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(AgentError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
