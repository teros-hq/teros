/**
 * Render test for the Sancho renderer (mca.sancho).
 *
 *   1. The registry resolves the renderer by mcaId.
 *   2. Every one of the 13 shortToolNames dispatches to its sub-renderer
 *      (header label + body content assertions).
 *   3. An unknown tool name falls back to the per-MCA FallbackRenderer.
 *   4. update-task / create-task distinguish dry-run (PREVIEW) from a real
 *      write (WRITTEN).
 *
 * Cards render collapsed by default — the test clicks the header role
 * "button" to open the body before asserting body content (same approach as
 * TerosCoreRenderer.render.test.tsx).
 */

import '../../../../i18n';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithTamagui } from '../../../../test/renderWithTamagui';
import { McaRegistry } from '../../McaRegistry';
import type { ToolCallRendererProps } from '../../types';
import { SanchoToolCallRenderer } from '../SanchoRenderer';

function out(data: unknown): string {
  return JSON.stringify(data);
}

/** Legacy MCP `{ content, structuredContent }` envelope — must be tolerated. */
function wrapped(structuredContent: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

function renderTool(props: Partial<ToolCallRendererProps> & { toolName: string }) {
  const merged = {
    toolCallId: 'tc1',
    status: 'completed',
    ...props,
  } as ToolCallRendererProps;
  const r = renderWithTamagui(<SanchoToolCallRenderer {...merged} />);
  return {
    ...r,
    open() {
      // The card header is the first button in DOM order — chips inside the
      // body also expose role="button" so getByRole('button') is ambiguous.
      fireEvent.click(r.getAllByRole('button')[0]);
    },
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

describe('SanchoRenderer — registry', () => {
  afterEach(() => {
    McaRegistry.clear();
    McaRegistry.clearWarnings();
  });

  it('McaRegistry resolves the Sancho renderer by mcaId', () => {
    // Register only the Sancho renderer — importing registerMcas pulls the
    // whole renderer catalog (Flow-typed deps that break jsdom collection).
    McaRegistry.register({
      mcaId: 'mca.sancho',
      name: 'Sancho',
      toolNames: [],
      ToolCallRenderer: SanchoToolCallRenderer,
    });
    const Renderer = McaRegistry.getToolCallRendererByMcpId('mca.sancho');
    expect(Renderer).toBeTruthy();
    // The registered renderer is (or wraps) SanchoToolCallRenderer.
    const r = renderWithTamagui(
      <Renderer toolCallId="tc1" toolName="sancho_list-clients" status="completed" />,
    );
    expect(r.getByText('Clients')).toBeTruthy();
  });
});

// ─── Dispatch of the 13 tools ────────────────────────────────────────────────

describe('SanchoRenderer — dispatch by shortToolName', () => {
  it('-health-check renders the health card', () => {
    const { getByText } = renderTool({
      toolName: 'sancho_-health-check',
      output: out({ status: 'ready', version: '1.1.1', issues: [] }),
    });
    expect(getByText('Health check')).toBeTruthy();
  });

  it('-health-check degraded when issues are reported', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_-health-check',
      output: out({
        status: 'not_ready',
        issues: [{ code: 'AUTH_INVALID', message: 'bad token' }],
      }),
    });
    expect(getByText('Health check')).toBeTruthy();
    open();
    expect(getByText(/Sancho MCP server rejected the bearer token|bad token/)).toBeTruthy();
  });

  it('mcp-status renders the connection card with principal', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_mcp-status',
      output: out({
        ok: true,
        server: 'app.sanchocmo.ai',
        version: '2.4.0',
        principal: {
          id: 'usr_9f3a2b7c',
          role: 'operator',
          scopes: ['sancho:read', 'alarife:read'],
          clients: ['teros-ai'],
          brands: ['teros-ai'],
        },
        runtime: { name: 'node', version: '22.11.0' },
      }),
    });
    expect(getByText('MCP server status')).toBeTruthy();
    open();
    expect(getByText('Sancho MCP server')).toBeTruthy();
    expect(getByText('CONNECTED')).toBeTruthy();
    expect(getByText('operator')).toBeTruthy();
  });

  it('mcp-status tolerates the { structuredContent } envelope', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_mcp-status',
      output: wrapped({ ok: true, server: 'app.sanchocmo.ai', version: '2.4.0' }),
    });
    expect(getByText('MCP server status')).toBeTruthy();
    open();
    expect(getByText('Sancho MCP server')).toBeTruthy();
  });

  it('mcp-list-tools renders the tool list with counters', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_mcp-list-tools',
      input: { namespace: 'alarife' },
      output: out({
        tools: [
          { name: 'alarife_list_instances', description: 'List CMS instances' },
          { name: 'alarife_list_posts', description: 'List posts' },
        ],
        total: 344,
        matched: 2,
        namespace: 'alarife',
      }),
    });
    expect(getByText('MCP tools (alarife)')).toBeTruthy();
    open();
    expect(getByText('alarife_list_instances')).toBeTruthy();
  });

  it('mcp-call renders the fallback body with the called tool in the header', () => {
    const { getByText } = renderTool({
      toolName: 'sancho_mcp-call',
      input: { tool: 'sancho_list_skills', args: { clientSlug: 'teros-ai' } },
      output: out({ skills: [{ name: 'seo-audit' }] }),
    });
    expect(getByText('MCP call · sancho_list_skills')).toBeTruthy();
  });

  it('list-clients renders client rows with the Mission Control link', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_list-clients',
      output: out({
        clients: [
          {
            slug: 'teros-ai',
            name: 'Teros',
            missionControlUrl: 'https://app.sanchocmo.ai/mc/teros-ai',
          },
        ],
        count: 1,
      }),
    });
    expect(getByText('Clients')).toBeTruthy();
    open();
    expect(getByText('Teros')).toBeTruthy();
    expect(getByText('Mission Control')).toBeTruthy();
  });

  it('get-client-context renders the hierarchical dashboard, not a JSON dump', () => {
    const { getByText, queryByText, open } = renderTool({
      toolName: 'sancho_get-client-context',
      input: { clientSlug: 'teros-ai' },
      output: out({
        client: { slug: 'teros-ai', name: 'Teros' },
        status: 'active',
        summary: 'Growth loops running; pSEO in execution.',
        active_work: [
          { id: 'P00-FUL-T09', title: 'Ship pSEO entity pages', status: 'in-progress', owner: 'alarife' },
        ],
        projects: [{ id: 'P00', name: 'Foundation', task_counts: { open: 3, done: 12 } }],
        blockers: [{ id: 'B1', title: 'Waiting on brand assets', severity: 'high' }],
        next_steps: [{ id: 'N1', title: 'Publish loops catalog', status: 'todo' }],
        metrics: { weekly_active_users: 812 },
        freshness: { documents: '2026-10-20' },
      }),
    });
    expect(getByText('Client context · Teros')).toBeTruthy();
    open();
    expect(getByText('ACTIVE WORK (1)')).toBeTruthy();
    expect(getByText('Ship pSEO entity pages')).toBeTruthy();
    expect(getByText('PROJECTS (1)')).toBeTruthy();
    expect(getByText('Foundation')).toBeTruthy();
    expect(getByText('BLOCKERS (1)')).toBeTruthy();
    expect(getByText('Waiting on brand assets')).toBeTruthy();
    expect(getByText('NEXT STEPS (1)')).toBeTruthy();
    expect(getByText('Publish loops catalog')).toBeTruthy();
    // Hierarchical, not a JSON dump:
    expect(queryByText(/"active_work"/)).toBeNull();
  });

  it('list-tasks renders rows with the status badge and hasMore hint', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_list-tasks',
      input: { clientSlug: 'teros-ai', status: 'blocked' },
      output: out({
        tasks: [
          {
            id: 'P00-FUL-T09',
            name: 'Ship pSEO entity pages',
            status: 'blocked',
            type: 'execution',
            owner: 'alarife',
          },
        ],
        matched: 1,
        count: 1,
        hasMore: false,
      }),
    });
    expect(getByText('Tasks (blocked)')).toBeTruthy();
    open();
    expect(getByText('Ship pSEO entity pages')).toBeTruthy();
    expect(getByText('blocked')).toBeTruthy();
  });

  it('get-task renders the detail with ICE and revision', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_get-task',
      input: { clientSlug: 'teros-ai', taskId: 'P00-FUL-T09' },
      output: out({
        task: {
          id: 'P00-FUL-T09',
          name: 'Ship pSEO entity pages',
          status: 'in-progress',
          brief: 'Publish 40 entity pages',
          completion: 'Pages live and indexed',
          ice: { impact: 8, confidence: 7, ease: 6, score: 7, band: 'medium' },
          taskRevision: 'rev-abc123def456',
        },
      }),
    });
    expect(getByText(/Task · Ship pSEO entity pages/)).toBeTruthy();
    open();
    expect(getByText('Publish 40 entity pages')).toBeTruthy();
    expect(getByText(/rev/)).toBeTruthy();
  });

  it('list-documents renders rows with size and date', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_list-documents',
      input: { brandSlug: 'teros-ai' },
      output: out({
        documents: [
          {
            path: 'brand/teros-ai/current-state.md',
            title: 'Current State',
            extension: 'md',
            size: 4096,
            updatedAt: '2026-10-20T10:00:00Z',
          },
        ],
        matched: 1,
        count: 1,
        hasMore: true,
      }),
    });
    expect(getByText('Brand documents')).toBeTruthy();
    open();
    expect(getByText('Current State')).toBeTruthy();
    expect(getByText('4.0 KB')).toBeTruthy();
    expect(getByText('2026-10-20')).toBeTruthy();
  });

  it('get-document renders title, outline and content', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_get-document',
      input: { brandSlug: 'teros-ai', docPath: 'current-state.md' },
      output: out({
        path: 'brand/teros-ai/current-state.md',
        title: 'Current State',
        content: 'Teros is an agent platform. WAU is the primary metric.',
        outline: [
          { number: '1', text: 'Where we are' },
          { number: '2', text: 'What moves the number' },
        ],
        totalChars: 42,
      }),
    });
    expect(getByText('Document · Current State')).toBeTruthy();
    open();
    expect(getByText(/OUTLINE/)).toBeTruthy();
    expect(getByText(/Teros is an agent platform/)).toBeTruthy();
  });

  it('recall renders ranked passages with source and score', () => {
    const { getByText, open } = renderTool({
      toolName: 'sancho_recall',
      input: { brandSlug: 'teros-ai', query: 'who do we sell to' },
      output: out({
        passages: [
          {
            quote: 'We sell to technical founders running small agencies.',
            docPath: 'brand/teros-ai/current-state.md',
            score: 0.92,
          },
        ],
      }),
    });
    expect(getByText(/Recall · "who do we sell to"/)).toBeTruthy();
    open();
    expect(getByText(/technical founders/)).toBeTruthy();
    expect(getByText('brand/teros-ai/current-state.md')).toBeTruthy();
    expect(getByText('0.92')).toBeTruthy();
  });
});

// ─── Dry-run vs confirm ──────────────────────────────────────────────────────

describe('SanchoRenderer — dry-run vs written', () => {
  it('update-task dry-run (default) shows the PREVIEW badge and no-write note', () => {
    const { getByText, open, queryByText } = renderTool({
      toolName: 'sancho_update-task',
      input: {
        clientSlug: 'teros-ai',
        taskId: 'P00-FUL-T09',
        status: 'in-progress',
        dryRun: true,
      },
      output: out({ preview: { status: 'in-progress' }, dryRun: true }),
    });
    expect(getByText('PREVIEW — NOT WRITTEN')).toBeTruthy();
    open();
    expect(getByText(/Dry-run preview — nothing was written/)).toBeTruthy();
    expect(queryByText('Task updated in Sancho.')).toBeNull();
  });

  it('update-task confirm+dryRun:false shows the WRITTEN badge and success', () => {
    const { getByText, open, queryByText } = renderTool({
      toolName: 'sancho_update-task',
      input: {
        clientSlug: 'teros-ai',
        taskId: 'P00-FUL-T09',
        status: 'completed',
        confirm: true,
        dryRun: false,
      },
      output: out({ task: { id: 'P00-FUL-T09', status: 'completed' }, dryRun: false }),
    });
    expect(getByText('WRITTEN')).toBeTruthy();
    open();
    expect(getByText('Task updated in Sancho.')).toBeTruthy();
    expect(queryByText(/Dry-run preview/)).toBeNull();
  });

  it('create-task dry-run shows the PREVIEW badge', () => {
    const dry = renderTool({
      toolName: 'sancho_create-task',
      input: { clientSlug: 'teros-ai', name: 'Publish loops catalog', dryRun: true },
      output: out({ preview: { name: 'Publish loops catalog', status: 'todo' }, dryRun: true }),
    });
    expect(dry.getByText('PREVIEW — NOT WRITTEN')).toBeTruthy();
  });

  it('create-task confirm shows the WRITTEN badge and success', () => {
    const written = renderTool({
      toolName: 'sancho_create-task',
      input: {
        clientSlug: 'teros-ai',
        name: 'Publish loops catalog',
        confirm: true,
        dryRun: false,
      },
      output: out({ task: { id: 'P00-FUL-T11', name: 'Publish loops catalog' }, dryRun: false }),
    });
    expect(written.getByText('WRITTEN')).toBeTruthy();
    written.open();
    expect(written.getByText('Task created in Sancho.')).toBeTruthy();
  });
});

// ─── Fallback ────────────────────────────────────────────────────────────────

describe('SanchoRenderer — fallback for unknown tools', () => {
  it('an unmapped tool renders the per-MCA fallback, not a crash', () => {
    const { getByText } = renderTool({
      toolName: 'sancho_some-future-tool',
      input: { x: 1 },
      output: out({ ok: true }),
    });
    expect(getByText(/no renderer/)).toBeTruthy();
  });
});
