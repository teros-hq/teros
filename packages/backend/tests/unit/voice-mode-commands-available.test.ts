import { describe, expect, it } from 'bun:test';
import { parseVoiceModeCommand } from '../../src/services/voice-mode-commands';

// PoC 2026-10-31 (Pablo, decisions 1-2): "Disponible" is the resting mode of
// the presence — reachable by voice like the other two.
describe('voice mode commands — available (Disponible)', () => {
  it('"Alice, ponte disponible" → available', () => {
    const cmd = parseVoiceModeCommand('Alice, ponte disponible', 'Alice');
    expect(cmd?.mode).toBe('available');
    expect(cmd?.ack).toBe('Vale.');
  });
  it('"deja de escuchar" → available (stop keeping what you hear — not mic mute)', () => {
    expect(parseVoiceModeCommand('deja de escuchar', 'Alice')?.mode).toBe('available');
  });
  it('"escucha" still → passive; "hablemos" still → conversation', () => {
    expect(parseVoiceModeCommand('Alice, modo escucha', 'Alice')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('hablemos', 'Alice')?.mode).toBe('conversation');
  });
  it('narration about being available is not an order', () => {
    expect(parseVoiceModeCommand('mañana no estoy disponible para la reunión', 'Alice')).toBeNull();
  });
});

describe('voice mode commands — round 6: the order must BE the utterance, and be addressed from a quiet room', () => {
  it('fillers around the order are fine; the self-correction "perdón, Iria, …" is addressed', () => {
    expect(parseVoiceModeCommand('Bueno, ponte en modo escucha, ¿vale?', 'Iria', 'conversation')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('Alice, quédate en modo, perdón, Iria, quédate en modo escucha, ¿vale?', 'Iria', 'conversation')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('Iría, ponte en modo conversando.', 'Iria', 'available')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('Iría, ponte de nuevo conversando.', 'Iria', 'available')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('ponte en modo escucha, Iria', 'Iria', 'available')?.mode).toBe('passive');
  });
  it('a phrase INSIDE a sentence never switches (any mode)', () => {
    expect(parseVoiceModeCommand('luego hablamos de eso con calma', 'Iria', 'passive')).toBeNull();
    expect(parseVoiceModeCommand('si tú se lo dices se va a poner disponible', 'Iria', 'passive')).toBeNull();
    expect(parseVoiceModeCommand('yo creo que vuelve mañana', 'Iria', 'conversation')).toBeNull();
    expect(parseVoiceModeCommand('le dije que se pusiera en modo escucha', 'Iria', 'conversation')).toBeNull();
  });
  it('from passive/available, bare orders need the name; mode nouns do not', () => {
    expect(parseVoiceModeCommand('hablemos', 'Iria', 'passive')).toBeNull();
    expect(parseVoiceModeCommand('vuelve', 'Iria', 'available')).toBeNull();
    expect(parseVoiceModeCommand('escucha sin hablar', 'Iria', 'available')).toBeNull();
    expect(parseVoiceModeCommand('Iria, hablemos', 'Iria', 'passive')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('modo conversación', 'Iria', 'passive')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('ponte en modo disponible', 'Iria', 'passive')?.mode).toBe('available');
  });
  it('in conversation (everything is addressed) bare orders still work', () => {
    expect(parseVoiceModeCommand('hablemos', 'Iria', 'conversation')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('ponte en modo silencio', 'Iria', 'conversation')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('deja de escuchar', 'Iria', 'conversation')?.mode).toBe('available');
  });
});
