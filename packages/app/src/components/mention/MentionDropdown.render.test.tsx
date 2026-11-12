/**
 * Render tests for MentionDropdown — skill group rendering (TER-618 M2).
 *
 * Verifies that the dropdown correctly renders groups of resources,
 * including the Skills group with the correct icon, labels, and items.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

import { MentionDropdown } from './MentionDropdown';
import type { MentionGroup, MentionResource } from '../../hooks/useAtMention';

const makeSkillResource = (id: string, name: string, subtitle?: string): MentionResource => ({
  id,
  type: 'skill',
  name,
  subtitle,
});

const makeAgentResource = (id: string, name: string): MentionResource => ({
  id,
  type: 'agent',
  name,
});

const makeGroups = (...groups: MentionGroup[]): MentionGroup[] => groups;

describe('MentionDropdown', () => {
  it('renders loading state when isLoading and no items', () => {
    render(
      <MentionDropdown
        groups={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        isLoading
      />,
    );

    expect(screen.getByText(/Cargando recursos/)).toBeInTheDocument();
  });

  it('renders empty state when no items and not loading', () => {
    render(
      <MentionDropdown
        groups={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        isLoading={false}
      />,
    );

    expect(screen.getByText(/No se encontraron recursos/)).toBeInTheDocument();
  });

  it('renders a Skills group with correct header and items', () => {
    const groups = makeGroups({
      type: 'skill',
      label: 'Skills',
      items: [
        makeSkillResource('sk_001', 'Code Review', 'Review code quality'),
        makeSkillResource('sk_002', 'Security Audit', 'Check vulnerabilities'),
      ],
    });

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Group header with icon
    expect(screen.getByText('Skills')).toBeInTheDocument();

    // Skill items
    expect(screen.getByText('Code Review')).toBeInTheDocument();
    expect(screen.getByText('Review code quality')).toBeInTheDocument();
    expect(screen.getByText('Security Audit')).toBeInTheDocument();
    expect(screen.getByText('Check vulnerabilities')).toBeInTheDocument();
  });

  it('renders multiple groups (Agents + Skills) with correct headers', () => {
    const groups = makeGroups(
      {
        type: 'agent',
        label: 'Agentes',
        items: [makeAgentResource('ag_001', 'Alice')],
      },
      {
        type: 'skill',
        label: 'Skills',
        items: [makeSkillResource('sk_003', 'Debug Helper')],
      },
    );

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Agentes')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Debug Helper')).toBeInTheDocument();
  });

  it('selects item on mouse down and calls onSelect', () => {
    const handleSelect = vi.fn();
    const groups = makeGroups({
      type: 'skill',
      label: 'Skills',
      items: [makeSkillResource('sk_004', 'Refactor Pro')],
    });

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={handleSelect}
        onClose={vi.fn()}
      />,
    );

    const item = screen.getByText('Refactor Pro').closest('button');
    expect(item).toBeTruthy();

    fireEvent.mouseDown(item!);

    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sk_004',
        type: 'skill',
        name: 'Refactor Pro',
      }),
    );
  });

  it('closes on outside click', () => {
    const handleClose = vi.fn();
    const groups = makeGroups({
      type: 'skill',
      label: 'Skills',
      items: [makeSkillResource('sk_005', 'Test Writer')],
    });

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={handleClose}
      />,
    );

    // Click outside the dropdown
    fireEvent.mouseDown(document.body);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('renders keyboard hint footer when items exist', () => {
    const groups = makeGroups({
      type: 'skill',
      label: 'Skills',
      items: [makeSkillResource('sk_006', 'Doc Writer')],
    });

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Keyboard hints in the footer
    expect(screen.getByText('navegar')).toBeInTheDocument();
    expect(screen.getByText('seleccionar')).toBeInTheDocument();
    expect(screen.getByText('cerrar')).toBeInTheDocument();
  });

  it('shows ID badge truncated to 12 chars for each item', () => {
    const groups = makeGroups({
      type: 'skill',
      label: 'Skills',
      items: [makeSkillResource('sk_very_long_id_123', 'Long ID Skill')],
    });

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // The badge shows first 12 chars + ellipsis ("sk_very_long…")
    expect(screen.getByText(/sk_very_long…/)).toBeInTheDocument();
  });

  it('does not render group header when group has no items', () => {
    const groups = makeGroups(
      {
        type: 'agent',
        label: 'Agentes',
        items: [],
      },
      {
        type: 'skill',
        label: 'Skills',
        items: [makeSkillResource('sk_007', 'Only Skill')],
      },
    );

    render(
      <MentionDropdown
        groups={groups}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Empty agent group should not render its header
    expect(screen.queryByText('Agentes')).not.toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Only Skill')).toBeInTheDocument();
  });
});
