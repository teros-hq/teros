/**
 * `inferTenseForms` covers the small set of English conjugation rules that
 * the Tool Call Card description tense pipeline relies on. Failures here
 * surface as ungrammatical strings in the header ("Stoping task",
 * "Replyed to comment"), so the rules below pin the behaviour the renderer
 * sweep depends on.
 *
 * The rules under test:
 *   1. Irregular verbs win over any heuristic (`get` → `getting`/`got`).
 *   2. Short CVC verbs double the final consonant before `-ing`/`-ed`
 *      (`stop` → `stopping`/`stopped`, `cancel` → `cancelling`/`cancelled`).
 *   3. `-y` preceded by a consonant becomes `-ied` before `-ed` but stays
 *      `-y` before `-ing` (`reply` → `replying`/`replied`).
 *   4. `-y` preceded by a vowel does NOT transform (`play` → `playing`/`played`).
 *   5. Trailing `e` (not `-ee`) drops before `-ing` (`take`-like is in the
 *      irregular table; the generic `e`-drop path covers verbs like
 *      `respond`-less variants — included as smoke).
 */

import { describe, expect, it } from 'bun:test';
import { inferTenseForms } from '../../../../packages/app/src/components/mca/primitives/tense';

describe('inferTenseForms', () => {
  describe('irregular verbs win over heuristics', () => {
    it('get → getting / got', () => {
      const f = inferTenseForms('Get file');
      expect(f.present).toBe('Getting file');
      expect(f.past).toBe('Got file');
    });

    it('run → running / ran (irregular past, regular present)', () => {
      const f = inferTenseForms('Run script');
      expect(f.present).toBe('Running script');
      expect(f.past).toBe('Ran script');
    });
  });

  describe('CVC doubling rule', () => {
    it('stop → stopping / stopped', () => {
      const f = inferTenseForms('Stop task');
      expect(f.present).toBe('Stopping task');
      expect(f.past).toBe('Stopped task');
    });

    it('cancel → cancelling / cancelled', () => {
      const f = inferTenseForms('Cancel workflow run');
      expect(f.present).toBe('Cancelling workflow run');
      expect(f.past).toBe('Cancelled workflow run');
    });

    it('submit → submitting / submitted', () => {
      const f = inferTenseForms('Submit form');
      expect(f.present).toBe('Submitting form');
      expect(f.past).toBe('Submitted form');
    });

    it('plan → planning / planned', () => {
      const f = inferTenseForms('Plan deployment');
      expect(f.present).toBe('Planning deployment');
      expect(f.past).toBe('Planned deployment');
    });
  });

  describe('does NOT double when rule does not apply', () => {
    it('list does NOT double (ends in CC, not CVC)', () => {
      const f = inferTenseForms('List files');
      expect(f.present).toBe('Listing files');
      expect(f.past).toBe('Listed files');
    });

    it('cover does NOT double (final triplet is -ver, vowel-before-before fails CVC)', () => {
      const f = inferTenseForms('Cover topic');
      expect(f.present).toBe('Covering topic');
      expect(f.past).toBe('Covered topic');
    });

    it('export does NOT double (too long, length > 6)', () => {
      const f = inferTenseForms('Export design');
      expect(f.present).toBe('Exporting design');
      expect(f.past).toBe('Exported design');
    });
  });

  describe('consonant-y rule', () => {
    it('reply → replying / replied', () => {
      const f = inferTenseForms('Reply to comment');
      expect(f.present).toBe('Replying to comment');
      expect(f.past).toBe('Replied to comment');
    });

    it('try → trying / tried', () => {
      const f = inferTenseForms('Try connection');
      expect(f.present).toBe('Trying connection');
      expect(f.past).toBe('Tried connection');
    });
  });

  describe('vowel-y does NOT transform', () => {
    it('play → playing / played', () => {
      const f = inferTenseForms('Play sound');
      expect(f.present).toBe('Playing sound');
      expect(f.past).toBe('Played sound');
    });
  });

  describe('trailing e drops before -ing, adds -d for past', () => {
    it('create → creating / created', () => {
      const f = inferTenseForms('Create user');
      expect(f.present).toBe('Creating user');
      expect(f.past).toBe('Created user');
    });

    it('delete → deleting / deleted', () => {
      const f = inferTenseForms('Delete record');
      expect(f.present).toBe('Deleting record');
      expect(f.past).toBe('Deleted record');
    });
  });

  describe('edge cases', () => {
    it('empty label returns the empty string for all forms', () => {
      const f = inferTenseForms('');
      expect(f.future).toBe('');
      expect(f.present).toBe('');
      expect(f.past).toBe('');
    });

    it('single-word verb works without tail', () => {
      const f = inferTenseForms('Stop');
      expect(f.future).toBe('stop');
      expect(f.present).toBe('Stopping');
      expect(f.past).toBe('Stopped');
    });

    it('preserves the rest of the label verbatim (no transformation of nouns)', () => {
      const f = inferTenseForms('Update Notion database schema');
      expect(f.future).toBe('update Notion database schema');
      expect(f.present).toBe('Updating Notion database schema');
      expect(f.past).toBe('Updated Notion database schema');
    });
  });
});
