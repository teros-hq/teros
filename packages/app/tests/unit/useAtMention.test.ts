/**
 * Unit tests for useAtMention pure utilities
 *
 * Tests the resource filtering logic and chip-to-markdown resolution
 * without importing React-dependent code.
 */
import { describe, expect, it } from 'vitest';

// Inline type mirrors MentionChip from useAtMention.ts
interface TestMentionResource {
  id: string;
  type: 'agent' | 'project' | 'app' | 'skill' | 'conversation' | 'file' | 'workspace';
  name: string;
  subtitle?: string;
  loadMode?: 'always' | 'on-demand';
}

interface TestMentionChip {
  id: string;
  resource: TestMentionResource;
}

// Inline copy of resolveMentionChipsToMarkdown logic
function resolveMentionChipsToMarkdown(chips: TestMentionChip[]): string {
  if (chips.length === 0) return '';
  const links = chips.map(
    ({ resource }) => `[${resource.name}](teros://${resource.type}/${resource.id})`,
  );
  return ' ' + links.join(' ');
}

// Inline copy of resolveMentionChipsToContext logic
const TYPE_LABELS: Record<TestMentionResource['type'], string> = {
  agent: 'Agent',
  project: 'Project',
  app: 'App',
  skill: 'Skill',
  conversation: 'Conversation',
  file: 'File',
  workspace: 'Workspace',
};

function resolveMentionChipsToContext(chips: TestMentionChip[]): string {
  if (chips.length === 0) return '';
  const lines = chips.map(
    ({ resource }) => `${TYPE_LABELS[resource.type]}: "${resource.name}" [${resource.id}]`,
  );
  return `\n\n[Referenced resources]\n${lines.join('\n')}`;
}

describe('resolveMentionChipsToMarkdown', () => {
  it('returns empty string for empty chips', () => {
    expect(resolveMentionChipsToMarkdown([])).toBe('');
  });

  it('produces a single teros://skill link', () => {
    const chips: TestMentionChip[] = [
      {
        id: 'chip_1',
        resource: { id: 'sk_abc', type: 'skill', name: 'Code Review', loadMode: 'on-demand' },
      },
    ];
    expect(resolveMentionChipsToMarkdown(chips)).toBe(' [Code Review](teros://skill/sk_abc)');
  });

  it('produces multiple teros links separated by spaces', () => {
    const chips: TestMentionChip[] = [
      {
        id: 'chip_1',
        resource: { id: 'sk_abc', type: 'skill', name: 'Code Review', loadMode: 'on-demand' },
      },
      {
        id: 'chip_2',
        resource: { id: 'ag_xyz', type: 'agent', name: 'Alice' },
      },
    ];
    expect(resolveMentionChipsToMarkdown(chips)).toBe(
      ' [Code Review](teros://skill/sk_abc) [Alice](teros://agent/ag_xyz)',
    );
  });
});

describe('resolveMentionChipsToContext', () => {
  it('returns empty string for empty chips', () => {
    expect(resolveMentionChipsToContext([])).toBe('');
  });

  it('produces a plain-text context block with skill type', () => {
    const chips: TestMentionChip[] = [
      {
        id: 'chip_1',
        resource: { id: 'sk_abc', type: 'skill', name: 'Code Review', loadMode: 'on-demand' },
      },
    ];
    expect(resolveMentionChipsToContext(chips)).toBe(
      '\n\n[Referenced resources]\nSkill: "Code Review" [sk_abc]',
    );
  });
});

describe('on-demand skill filtering logic', () => {
  // This mirrors the resourceFilter passed to useAtMention in InputComposer.web.tsx
  const skillOnlyOnDemandFilter = (r: { type: string; loadMode?: string }) => {
    if (r.type !== 'skill') return false;
    return r.loadMode === 'on-demand';
  };

  it('includes on-demand skills', () => {
    expect(skillOnlyOnDemandFilter({ type: 'skill', loadMode: 'on-demand' })).toBe(true);
  });

  it('excludes always-loaded skills', () => {
    expect(skillOnlyOnDemandFilter({ type: 'skill', loadMode: 'always' })).toBe(false);
  });

  it('excludes non-skill resources', () => {
    expect(skillOnlyOnDemandFilter({ type: 'agent' })).toBe(false);
    expect(skillOnlyOnDemandFilter({ type: 'project' })).toBe(false);
    expect(skillOnlyOnDemandFilter({ type: 'app' })).toBe(false);
  });

  it('excludes skills with undefined loadMode (treat as not on-demand)', () => {
    expect(skillOnlyOnDemandFilter({ type: 'skill' })).toBe(false);
  });
});
