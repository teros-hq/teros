/**
 * Render test for the Gmail/Outlook renderers — missing `from` field
 * (bug 2026-10-27).
 *
 * Crash report (Pablo, 27 oct):
 *   TypeError: Cannot read properties of undefined (reading 'match')
 *   at ChatWindowContent chunk, inside Array.map
 *
 * Root cause: the Gmail MCA builds messages with
 * `from: headers.find((h) => h.name === 'From')?.value` — an email without a
 * From header yields `from: undefined`, and `extractSenderName` called
 * `from.match(...)` inside `data.messages.map(...)` with no guard, crashing
 * the whole bubble render.
 *
 * This test asserts the fix: a message with `from: undefined` renders with a
 * graceful '(unknown)' sender instead of throwing. Same fix mirrored in
 * OutlookRenderer.
 *
 * Cards render collapsed by default — the header (role=button) toggles the
 * body. Body-content assertions must expand first. jsdom: click (not press).
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTamagui } from '../../../test/renderWithTamagui';
import type { ToolCallRendererProps } from '../types';
import { GmailToolCallRenderer } from './GmailRenderer';
import { OutlookToolCallRenderer } from './OutlookRenderer';

function out(data: unknown): string {
  return JSON.stringify(data);
}

function renderGmail(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <GmailToolCallRenderer
      toolCallId="tc1"
      toolName={props.toolName ?? 'gmail-work_list-messages'}
      status={props.status ?? 'completed'}
      {...props}
    />,
  );
}

function renderOutlook(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <OutlookToolCallRenderer
      toolCallId="tc1"
      toolName={props.toolName ?? 'outlook-work_list-messages'}
      status={props.status ?? 'completed'}
      {...props}
    />,
  );
}

function expandCard() {
  fireEvent.click(screen.getByRole('button'));
}

describe('GmailRenderer — messages without a From header', () => {
  it('does not crash when a message has from: undefined — renders (unknown)', () => {
    // Exact crash shape: the MCA emits `from: headers.find(...)?.value` which
    // is undefined when the email lacks a From header. The map callback runs
    // during render regardless of collapse state — before the fix this threw
    // `TypeError: reading 'match' of undefined`.
    const output = out({
      messages: [
        {
          id: 'msg-1',
          from: undefined,
          subject: 'No sender here',
          date: '2026-10-27T10:00:00Z',
          snippet: 'body',
        },
      ],
      total: 1,
    });

    expect(() => renderGmail({ output })).not.toThrow();
    expandCard();
    expect(screen.getByText('(unknown)')).toBeTruthy();
    expect(screen.getByText('No sender here')).toBeTruthy();
  });

  it('still renders normal senders (regression)', () => {
    const output = out({
      messages: [
        {
          id: 'msg-2',
          from: 'John Doe <john@example.com>',
          subject: 'With sender',
          date: '2026-10-27T10:00:00Z',
        },
      ],
      total: 1,
    });

    renderGmail({ output });
    expandCard();
    expect(screen.getByText('John Doe')).toBeTruthy();
  });

  it('search-messages also survives a missing from (same map path)', () => {
    const output = out({
      messages: [
        { id: 'msg-3', from: undefined, subject: 'Search hit', date: '2026-10-27T10:00:00Z' },
      ],
      total: 1,
      query: 'test',
    });

    expect(() => renderGmail({ toolName: 'gmail-work_search-messages', output })).not.toThrow();
  });
});

describe('OutlookRenderer — messages without a From header (mirrored fix)', () => {
  it('does not crash when a message has from: undefined — renders (unknown)', () => {
    const output = out({
      count: 1,
      messages: [
        {
          id: 'ol-1',
          from: undefined,
          subject: 'No sender here',
          date: '2026-10-27T10:00:00Z',
        },
      ],
    });

    expect(() => renderOutlook({ output })).not.toThrow();
    expandCard();
    expect(screen.getByText('(unknown)')).toBeTruthy();
    expect(screen.getByText('No sender here')).toBeTruthy();
  });

  it('search-messages also survives a missing from (same map path)', () => {
    const output = out({
      count: 1,
      messages: [
        { id: 'ol-2', from: undefined, subject: 'Search hit', date: '2026-10-27T10:00:00Z' },
      ],
      query: 'test',
    });

    expect(() => renderOutlook({ toolName: 'outlook-work_search-messages', output })).not.toThrow();
  });
});
