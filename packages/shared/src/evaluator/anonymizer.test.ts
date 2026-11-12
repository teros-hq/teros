/**
 * Unit tests — anonymizer (PURE module).
 *
 * Task: task_a5725f2e20828c3a (fase 4a)
 *
 * Covers:
 *   - PII detection: emails, internal IDs, paths, tokens, names
 *   - Hash stability: same input → same pseudonym, always
 *   - Content preservation: non-PII text is never touched
 *   - WindowMessage / EvalMessage integration
 *   - Edge cases: empty strings, already-anonymized text, mixed content
 */

import { describe, expect, it } from 'bun:test';
import {
  anonymizeAgentId,
  anonymizeChannelId,
  anonymizeEmails,
  anonymizeEvalMessages,
  anonymizeIds,
  anonymizeNames,
  anonymizePaths,
  anonymizeText,
  anonymizeTokens,
  anonymizeUserId,
  anonymizeWindowMessages,
} from './anonymizer';

// ---------------------------------------------------------------------------
// Email detection
// ---------------------------------------------------------------------------

describe('anonymizeEmails', () => {
  it('replaces a simple email', () => {
    const out = anonymizeEmails('Contact me at pablo@example.com please');
    expect(out).not.toContain('pablo@example.com');
    expect(out).toMatch(/user_[0-9a-f]{12}@anon\.local/);
  });

  it('is stable: same email → same pseudonym', () => {
    const a = anonymizeEmails('pablo@example.com');
    const b = anonymizeEmails('pablo@example.com');
    expect(a).toBe(b);
  });

  it('is case-insensitive stable', () => {
    const a = anonymizeEmails('Pablo@Example.COM');
    const b = anonymizeEmails('pablo@example.com');
    expect(a).toBe(b);
  });

  it('handles multiple emails in one text', () => {
    const out = anonymizeEmails('From alice@test.com to bob@test.com');
    expect(out).not.toContain('alice@test.com');
    expect(out).not.toContain('bob@test.com');
    // Both replaced with stable pseudonyms
    expect(out).toMatch(/user_[0-9a-f]{12}@anon\.local/);
  });

  it('does not touch non-email text', () => {
    const text = 'This is not an email: hello world';
    expect(anonymizeEmails(text)).toBe(text);
  });

  it('does not touch URLs without @', () => {
    const text = 'Visit https://example.com/path for more';
    expect(anonymizeEmails(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Internal ID detection
// ---------------------------------------------------------------------------

describe('anonymizeIds', () => {
  it('replaces channelIds', () => {
    const out = anonymizeIds('See ch_a44a3dd33f26459c for details');
    expect(out).not.toContain('ch_a44a3dd33f26459c');
    expect(out).toMatch(/ch_[0-9a-f]{12}/);
  });

  it('replaces userIds', () => {
    const out = anonymizeIds('User user_42a57945c4ec94d5 wrote this');
    expect(out).not.toContain('user_42a57945c4ec94d5');
    expect(out).toMatch(/user_[0-9a-f]{12}/);
  });

  it('replaces agentIds', () => {
    const out = anonymizeIds('Agent agent_42a57945c4ec94d5 did it');
    expect(out).not.toContain('agent_42a57945c4ec94d5');
    expect(out).toMatch(/agent_[0-9a-f]{12}/);
  });

  it('replaces Mongo ObjectIds', () => {
    const out = anonymizeIds('Doc _id: 507f1f77bcf86cd799439011');
    expect(out).not.toContain('507f1f77bcf86cd799439011');
    expect(out).toMatch(/oid_[0-9a-f]{12}/);
  });

  it('is stable across calls', () => {
    const a = anonymizeIds('ch_a44a3dd33f26459c');
    const b = anonymizeIds('ch_a44a3dd33f26459c');
    expect(a).toBe(b);
  });

  it('does not touch short hex strings', () => {
    const text = 'Color #ff00ff is nice';
    expect(anonymizeIds(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

describe('anonymizePaths', () => {
  it('replaces /home/username/ paths', () => {
    const out = anonymizePaths('File at /home/alex/projects/file.ts');
    expect(out).not.toContain('/home/alex/');
    expect(out).toMatch(/\/home\/[0-9a-f]{12}\//);
  });

  it('replaces /Users/username/ paths', () => {
    const out = anonymizePaths('File at /Users/maria/Documents/file.ts');
    expect(out).not.toContain('/Users/maria/');
    expect(out).toMatch(/\/Users\/[0-9a-f]{12}\//);
  });

  it('skips system users', () => {
    expect(anonymizePaths('/home/root/.bashrc')).toBe('/home/root/.bashrc');
    expect(anonymizePaths('/home/node/app.js')).toBe('/home/node/app.js');
  });

  it('is stable', () => {
    const a = anonymizePaths('/home/alex/x');
    const b = anonymizePaths('/home/alex/x');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Token detection
// ---------------------------------------------------------------------------

describe('anonymizeTokens', () => {
  it('replaces Bearer tokens', () => {
    const out = anonymizeTokens('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC9k');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC9k');
    expect(out).toMatch(/token_[0-9a-f]{12}/);
  });

  it('replaces sk- API keys', () => {
    const out = anonymizeTokens('key: sk-abcdefghijklmnop1234567890');
    expect(out).not.toContain('sk-abcdefghijklmnop1234567890');
    expect(out).toMatch(/token_[0-9a-f]{12}/);
  });

  it('replaces JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = anonymizeTokens(`token: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toMatch(/token_[0-9a-f]{12}/);
  });

  it('replaces AWS keys', () => {
    const out = anonymizeTokens('aws_key: AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toMatch(/token_[0-9a-f]{12}/);
  });

  it('replaces 32-char hex strings', () => {
    const out = anonymizeTokens('hash: a1b2c3d4e5f6789012345678abcdef00');
    expect(out).not.toContain('a1b2c3d4e5f6789012345678abcdef00');
    expect(out).toMatch(/token_[0-9a-f]{12}/);
  });

  it('does not touch normal text', () => {
    const text = 'This is a normal sentence with no tokens.';
    expect(anonymizeTokens(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Name detection
// ---------------------------------------------------------------------------

describe('anonymizeNames', () => {
  it('replaces known Spanish names', () => {
    const out = anonymizeNames('Pablo dijo que sí');
    expect(out).not.toContain('Pablo');
    expect(out).toMatch(/Persona_[0-9a-f]{12}/);
  });

  it('replaces known English names', () => {
    const out = anonymizeNames('John said yes');
    expect(out).not.toContain('John');
    expect(out).toMatch(/Persona_[0-9a-f]{12}/);
  });

  it('is stable: same name → same pseudonym', () => {
    const a = anonymizeNames('María vino');
    const b = anonymizeNames('María vino');
    expect(a).toBe(b);
  });

  it('is case-insensitive stable for capitalized forms', () => {
    const a = anonymizeNames('MARÍA vino');
    const b = anonymizeNames('María vino');
    expect(a).toBe(b);
  });

  it('handles First Last pattern', () => {
    const out = anonymizeNames('Pablo López escribió');
    expect(out).not.toContain('Pablo');
    expect(out).not.toContain('López');
  });

  it('does not touch lowercase words', () => {
    const text = 'el pablo es un nombre común';
    expect(anonymizeNames(text)).toBe(text);
  });

  it('does not touch common capitalized words', () => {
    const text = 'The quick brown fox';
    expect(anonymizeNames(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Full text anonymization
// ---------------------------------------------------------------------------

describe('anonymizeText', () => {
  it('applies all detectors', () => {
    const input = 'Alex (alex@example.com) en /home/alex/ dijo: ch_a44a3dd33f26459c';
    const out = anonymizeText(input);
    expect(out).not.toContain('pablo@example.com');
    expect(out).not.toContain('/home/alex/');
    expect(out).not.toContain('ch_a44a3dd33f26459c');
    expect(out).not.toContain('Pablo');
  });

  it('preserves non-PII content', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(anonymizeText(text)).toBe(text);
  });

  it('handles empty string', () => {
    expect(anonymizeText('')).toBe('');
  });

  it('is idempotent on already-anonymized text', () => {
    const once = anonymizeText('pablo@example.com');
    const twice = anonymizeText(once);
    expect(twice).toBe(once);
  });

  it('respects options to disable detectors', () => {
    const text = 'Contact: someuser@example.com';
    expect(anonymizeText(text, { emails: false })).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// WindowMessage integration
// ---------------------------------------------------------------------------

describe('anonymizeWindowMessages', () => {
  it('anonymizes text parts', () => {
    const msgs = [{
      index: 0,
      role: 'user' as const,
      createdAt: 1000,
      parts: [{ kind: 'text' as const, text: 'Hola Pablo, escríbeme a pablo@example.com' }],
    }];
    const out = anonymizeWindowMessages(msgs);
    expect(out[0].parts[0].text).not.toContain('Pablo');
    expect(out[0].parts[0].text).not.toContain('pablo@example.com');
  });

  it('anonymizes tool inputs and outputs', () => {
    const msgs = [{
      index: 0,
      role: 'assistant' as const,
      createdAt: 1000,
      parts: [{
        kind: 'tool' as const,
        callId: 'call_1',
        tool: 'bash/bash',
        input: { command: 'cat /home/alex/file.txt' },
        status: 'completed' as const,
        output: 'email: pablo@example.com',
        truncatedBytes: 0,
        startedAt: 1000,
      }],
    }];
    const out = anonymizeWindowMessages(msgs);
    const part = out[0].parts[0] as any;
    expect(part.input.command).not.toContain('/home/alex/');
    expect(part.output).not.toContain('pablo@example.com');
    expect(part.callId).toBe('call_1'); // callIds NOT anonymized
    expect(part.tool).toBe('bash/bash'); // tool names NOT anonymized
  });

  it('preserves message structure', () => {
    const msgs = [{
      index: 5,
      role: 'user' as const,
      createdAt: 5000,
      isVoice: true,
      parts: [{ kind: 'text' as const, text: 'hello' }],
    }];
    const out = anonymizeWindowMessages(msgs);
    expect(out[0].index).toBe(5);
    expect(out[0].role).toBe('user');
    expect(out[0].createdAt).toBe(5000);
    expect(out[0].isVoice).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EvalMessage integration
// ---------------------------------------------------------------------------

describe('anonymizeEvalMessages', () => {
  it('anonymizes text and tool inputs', () => {
    const msgs = [{
      role: 'user' as const,
      createdAt: 1000,
      text: 'Hola Pablo',
      isVoice: false,
      toolCalls: [{
        callId: 'call_1',
        tool: 'bash',
        input: { path: '/home/alex/file' },
        inputKey: '{"path":"/home/alex/file"}',
        status: 'completed' as const,
        startedAt: 1000,
      }],
    }];
    const out = anonymizeEvalMessages(msgs);
    expect(out[0].text).not.toContain('Pablo');
    expect((out[0].toolCalls[0].input as any).path).not.toContain('/home/alex/');
    expect(out[0].toolCalls[0].callId).toBe('call_1');
    expect(out[0].toolCalls[0].tool).toBe('bash');
  });

  it('recomputes inputKey after anonymization', () => {
    const msgs = [{
      role: 'assistant' as const,
      createdAt: 1000,
      text: '',
      toolCalls: [{
        callId: 'call_1',
        tool: 'bash',
        input: { path: '/home/alex/file' },
        inputKey: '{"path":"/home/alex/file"}',
        status: 'completed' as const,
        startedAt: 1000,
      }],
    }];
    const out = anonymizeEvalMessages(msgs);
    expect(out[0].toolCalls[0].inputKey).not.toContain('/home/alex/');
  });
});

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

describe('anonymizeChannelId / UserId / AgentId', () => {
  it('produces stable pseudonyms', () => {
    expect(anonymizeChannelId('ch_a44a3dd33f26459c')).toBe(anonymizeChannelId('ch_a44a3dd33f26459c'));
    expect(anonymizeUserId('user_42a57945c4ec94d5')).toBe(anonymizeUserId('user_42a57945c4ec94d5'));
    expect(anonymizeAgentId('agent_42a57945c4ec94d5')).toBe(anonymizeAgentId('agent_42a57945c4ec94d5'));
  });

  it('produces different pseudonyms for different inputs', () => {
    expect(anonymizeChannelId('ch_a44a3dd33f26459c')).not.toBe(anonymizeChannelId('ch_efcaed639158084a'));
  });

  it('returns prefixed hashes', () => {
    expect(anonymizeChannelId('ch_a44a3dd33f26459c')).toMatch(/^ch_[0-9a-f]{12}$/);
    expect(anonymizeUserId('user_42a57945c4ec94d5')).toMatch(/^user_[0-9a-f]{12}$/);
    expect(anonymizeAgentId('agent_42a57945c4ec94d5')).toMatch(/^agent_[0-9a-f]{12}$/);
  });
});
