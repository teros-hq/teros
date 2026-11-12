/**
 * Enforced signature (spec §3.6, tn_PcquTN30AawbK8uE) — unit tests.
 *
 * The signature is appended by `send` to EVERY outgoing email and the agent
 * cannot opt out. These tests pin the wording shape, the fallbacks, and the
 * HTML escaping.
 */
import { describe, expect, it } from 'bun:test';
import { applySignature, buildSignature } from '../../src/tools/signature.js';

describe('enforced signature (spec §3.6)', () => {
  it('includes agent name, owner transparency and branding', () => {
    const sig = buildSignature('Nira', 'Pablo');
    expect(sig.text).toContain('Nira');
    expect(sig.text).toContain('agente de Pablo en Teros');
    expect(sig.text).toContain('Enviado vía Teros');
    expect(sig.html).toContain('agente de Pablo en Teros');
    expect(sig.html).toContain('Enviado vía Teros');
  });

  it('falls back to generic transparency line when owner unknown', () => {
    const sig = buildSignature('Nira', undefined);
    expect(sig.text).toContain('agente de Teros');
    expect(sig.text).not.toContain('agente de Pablo');
  });

  it('falls back to generic agent name when agent unknown', () => {
    const sig = buildSignature(undefined, 'Pablo');
    expect(sig.text).toContain('Un agente');
    expect(sig.text).toContain('agente de Pablo en Teros');
  });

  it('escapes HTML in interpolated names', () => {
    const sig = buildSignature('<b>Nira</b>', 'Pablo & Co');
    expect(sig.html).toContain('&lt;b&gt;Nira&lt;/b&gt;');
    expect(sig.html).toContain('Pablo &amp; Co');
    expect(sig.html).not.toContain('<b>');
  });

  it('applySignature appends to text and html, never replaces', () => {
    const body = { text: 'hola', html: '<p>hola</p>' };
    const signed = applySignature(body, 'Nira', 'Pablo');
    expect(signed.text.startsWith('hola')).toBe(true);
    expect(signed.text).toContain('Enviado vía Teros');
    expect(signed.html?.startsWith('<p>hola</p>')).toBe(true);
    expect(signed.html).toContain('Enviado vía Teros');
    // original body object untouched
    expect(body.text).toBe('hola');
  });

  it('applySignature leaves html undefined when body had none', () => {
    const signed = applySignature({ text: 'hola' }, 'Nira', 'Pablo');
    expect(signed.html).toBeUndefined();
    expect(signed.text).toContain('Enviado vía Teros');
  });
});
