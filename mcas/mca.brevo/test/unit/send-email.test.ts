import { describe, expect, it } from 'bun:test';
import { buildCreateContactBody, buildSendEmailBody } from '../../src/tools/_helpers';

describe('buildSendEmailBody', () => {
  it('builds a minimal body with no undefined keys', () => {
    const body = buildSendEmailBody({
      sender: { email: 'ana@empresa.com' },
      to: [{ email: 'cliente@dominio.com' }],
      subject: 'Hola',
      textContent: 'Cuerpo',
    });
    // Exact payload — htmlContent / cc / bcc / replyTo / params / tags absent.
    expect(body).toEqual({
      sender: { email: 'ana@empresa.com' },
      to: [{ email: 'cliente@dominio.com' }],
      subject: 'Hola',
      textContent: 'Cuerpo',
    });
    expect('htmlContent' in body).toBe(false);
    expect('cc' in body).toBe(false);
  });

  it('builds the full body verbatim and keeps recipient names', () => {
    const body = buildSendEmailBody({
      sender: { email: 'ana@empresa.com', name: 'Ana' },
      to: [
        { email: 'a@x.com', name: 'A' },
        { email: 'b@x.com' },
      ],
      subject: 'Promo',
      htmlContent: '<h1>Hi</h1>',
      textContent: 'Hi',
      cc: [{ email: 'cc@x.com', name: 'CC' }],
      bcc: [{ email: 'bcc@x.com' }],
      replyTo: { email: 'reply@x.com', name: 'Soporte' },
      params: { FNAME: 'Ana', CODE: 10 },
      tags: ['promo', 'q2'],
    });
    expect(body).toEqual({
      sender: { email: 'ana@empresa.com', name: 'Ana' },
      to: [
        { email: 'a@x.com', name: 'A' },
        { email: 'b@x.com' },
      ],
      subject: 'Promo',
      htmlContent: '<h1>Hi</h1>',
      textContent: 'Hi',
      cc: [{ email: 'cc@x.com', name: 'CC' }],
      bcc: [{ email: 'bcc@x.com' }],
      replyTo: { email: 'reply@x.com', name: 'Soporte' },
      params: { FNAME: 'Ana', CODE: 10 },
      tags: ['promo', 'q2'],
    });
  });

  it('drops empty names and empty-string tags', () => {
    const body = buildSendEmailBody({
      sender: { email: 'ana@empresa.com', name: '   ' },
      to: [{ email: 'a@x.com', name: '' }],
      subject: 'S',
      textContent: 'T',
      tags: ['keep', '', '  '],
    });
    expect(body.sender).toEqual({ email: 'ana@empresa.com' });
    expect(body.to).toEqual([{ email: 'a@x.com' }]);
    expect(body.tags).toEqual(['keep']);
  });

  it('omits empty cc / bcc / tags arrays', () => {
    const body = buildSendEmailBody({
      sender: { email: 'ana@empresa.com' },
      to: [{ email: 'a@x.com' }],
      subject: 'S',
      htmlContent: '<p>x</p>',
      cc: [],
      bcc: [],
      tags: [],
    });
    expect('cc' in body).toBe(false);
    expect('bcc' in body).toBe(false);
    expect('tags' in body).toBe(false);
  });

  it('omits the tags key when every tag is blank (filter → [] must NOT leave an empty array)', () => {
    const body = buildSendEmailBody({
      sender: { email: 'ana@empresa.com' },
      to: [{ email: 'a@x.com' }],
      subject: 'S',
      textContent: 'T',
      tags: ['', '  '],
    });
    expect('tags' in body).toBe(false);
  });
});

describe('buildCreateContactBody', () => {
  it('builds a minimal body from email only', () => {
    expect(buildCreateContactBody({ email: 'x@y.com' })).toEqual({ email: 'x@y.com' });
  });

  it('builds the full body and keeps updateEnabled:false', () => {
    const body = buildCreateContactBody({
      email: 'x@y.com',
      attributes: { FIRSTNAME: 'X', LASTNAME: 'Y' },
      listIds: [3, 7],
      updateEnabled: false,
    });
    expect(body).toEqual({
      email: 'x@y.com',
      attributes: { FIRSTNAME: 'X', LASTNAME: 'Y' },
      listIds: [3, 7],
      updateEnabled: false,
    });
  });

  it('omits empty listIds and absent optionals', () => {
    const body = buildCreateContactBody({ email: 'x@y.com', listIds: [] });
    expect(body).toEqual({ email: 'x@y.com' });
    expect('listIds' in body).toBe(false);
    expect('updateEnabled' in body).toBe(false);
  });
});
