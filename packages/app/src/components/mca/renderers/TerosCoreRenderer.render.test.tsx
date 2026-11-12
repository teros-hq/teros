/**
 * mca.teros.core renderer — structure-asserting render tests.
 *
 *   1. set-agent-model completed → agent card, pinned model chip, provider
 *      subtitle, and the auto-added-provider note when applicable.
 *   2. reset-agent-model completed → agent card with the System Default chip.
 *   3. Both tools use their dedicated renderer (no FallbackRenderer warning).
 *   4. Every visible tool in tools.json has a renderer (no dev fallback).
 */

import '../../../i18n';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTamagui } from '../../../test/renderWithTamagui';
import type { ToolCallRendererProps } from '../types';
import toolsJson from '../../../../../../mcas/mca.teros.core/tools.json';
import { __TEST_RENDERERS, TerosCoreToolCallRenderer } from './TerosCoreRenderer';

const FALLBACK_WARNING = /No dedicated renderer for/;

function render(props: Partial<ToolCallRendererProps> & { toolName: string }) {
  const merged = { toolCallId: 'tc1', status: 'completed', ...props } as ToolCallRendererProps;
  const r = renderWithTamagui(<TerosCoreToolCallRenderer {...merged} />);
  // ToolShell renders collapsed (defaultExpanded=false) — open the card so the
  // body (ResourceCard with the model chip) mounts.
  fireEvent.click(r.getByRole('button'));
  return r;
}

describe('TerosCoreRenderer — agent model tools', () => {
  it('set-agent-model: agent card with the pinned model chip and provider subtitle', () => {
    const r = render({
      toolName: 'teros.core_set-agent-model',
      input: { agentId: 'agent_abc123', providerId: 'teros', modelId: 'teros-glm-5p3' },
      output: JSON.stringify({
        success: true,
        message: "Model for 'Nira Solana' set to teros-glm-5p3 (provider teros)",
        agentId: 'agent_abc123',
        agentName: 'Nira Solana',
        selectedProviderId: 'teros',
        selectedModelId: 'teros-glm-5p3',
        availableProviders: ['teros', 'anthropic'],
        addedProviderToAvailable: false,
        reason: null,
      }),
    });
    expect(r.getByText("Pinned Nira Solana's model")).toBeTruthy();
    expect(r.getByText('Nira Solana')).toBeTruthy();
    expect(r.getByText('teros-glm-5p3')).toBeTruthy();
    expect(r.getByText('via teros')).toBeTruthy();
    // No auto-add note when the provider was already available.
    expect(r.queryByText(/added to the agent's providers/)).toBeNull();
    // Dedicated renderer — never the fallback warning.
    expect(r.queryByText(FALLBACK_WARNING)).toBeNull();
  });

  it("set-agent-model: no auto-add note (availableProviders removed with the 2-level resolution)", () => {
    const r = render({
      toolName: 'teros.core_set-agent-model',
      input: { agentId: 'agent_abc123', providerId: 'helmcode', modelId: 'helmcode-fast-1' },
      output: JSON.stringify({
        success: true,
        message: "Model for 'Nira Solana' set to helmcode-fast-1 (provider helmcode)",
        agentId: 'agent_abc123',
        agentName: 'Nira Solana',
        selectedProviderId: 'helmcode',
        selectedModelId: 'helmcode-fast-1',
        reason: 'operator decision',
      }),
    });
    expect(r.getByText('helmcode-fast-1')).toBeTruthy();
    expect(r.getByText('via helmcode')).toBeTruthy();
    // availableProviders / auto-add note removed (e106a7545) — never painted.
    expect(r.queryByText(/added to the agent's providers/)).toBeNull();
    // reason is audit-only — never painted.
    expect(r.queryByText('operator decision')).toBeNull();
    expect(r.queryByText(FALLBACK_WARNING)).toBeNull();
  });

  it('set-default-provider: provider card with the default model chip and previous provider line', () => {
    // Output shape from the real no-op verification (task_3d175171e9de201d).
    const r = render({
      toolName: 'teros.core_set-default-provider',
      input: {
        providerId: 'prov_mof08901_ypuej1',
        modelId: 'teros-glm-5p3',
        reason: 'no-op verification',
      },
      output: JSON.stringify({
        success: true,
        message: "System Default set to 'Teros' / teros-glm-5p3 (already was the default)",
        providerId: 'prov_mof08901_ypuej1',
        providerName: 'Teros',
        modelId: 'teros-glm-5p3',
        previousDefaultProviderId: 'prov_mof08901_ypuej1',
        isDefault: true,
        reason: 'no-op verification',
      }),
    });
    expect(r.getByText('System Default provider set')).toBeTruthy();
    expect(r.getByText('Teros')).toBeTruthy();
    expect(r.getByText('teros-glm-5p3')).toBeTruthy();
    // No-op: previous == new provider → no "switched from" line.
    expect(r.queryByText(/switched from/)).toBeNull();
    // Composed backend message is never painted.
    expect(r.queryByText(/already was the default/)).toBeNull();
    // reason is audit-only — never painted.
    expect(r.queryByText('no-op verification')).toBeNull();
    // Dedicated renderer — never the fallback warning.
    expect(r.queryByText(FALLBACK_WARNING)).toBeNull();
  });

  it('set-default-provider: shows the previous provider when the default switched', () => {
    const r = render({
      toolName: 'teros.core_set-default-provider',
      input: { providerId: 'prov_mudleawv_33kor4', modelId: 'helmcode-glm-5.3' },
      output: JSON.stringify({
        success: true,
        message: "System Default set to 'Helmcode' / helmcode-glm-5.3",
        providerId: 'prov_mudleawv_33kor4',
        providerName: 'Helmcode',
        modelId: 'helmcode-glm-5.3',
        previousDefaultProviderId: 'prov_mof08901_ypuej1',
        isDefault: true,
      }),
    });
    expect(r.getByText('Helmcode')).toBeTruthy();
    expect(r.getByText('helmcode-glm-5.3')).toBeTruthy();
    // Switch: previous provider painted via the muted switchedFrom line
    // (shortId form: prov_mof08…uej1).
    expect(r.getByText(/switched from prov_mof08/)).toBeTruthy();
    expect(r.queryByText(FALLBACK_WARNING)).toBeNull();
  });

  it('reset-agent-model: agent card with the System Default chip', () => {
    const r = render({
      toolName: 'teros.core_reset-agent-model',
      input: { agentId: 'agent_abc123' },
      output: JSON.stringify({
        success: true,
        message: "Model for 'Nira Solana' reset to System Default",
        agentId: 'agent_abc123',
        agentName: 'Nira Solana',
        selectedProviderId: null,
        selectedModelId: null,
      }),
    });
    expect(r.getByText("Reset Nira Solana's model to System Default")).toBeTruthy();
    expect(r.getByText('Nira Solana')).toBeTruthy();
    expect(r.getByText('System Default')).toBeTruthy();
    expect(r.queryByText(FALLBACK_WARNING)).toBeNull();
  });

  it('covers every tool declared in tools.json', () => {
    // Tools prefixed with '-' (e.g. -health-check) are hidden/internal and
    // never reach the chat UI — no renderer needed.
    const declared = (toolsJson as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .filter((n) => !n.startsWith('-'))
      .sort();
    const covered = Object.keys(__TEST_RENDERERS).sort();
    expect(covered).toEqual(declared);
  });
});
