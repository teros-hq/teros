/**
 * Accessibility snapshot helper
 *
 * Reuses the same logic as the Playwright MCA:
 * tries _snapshotForAI() first, falls back to CDP AX tree.
 */

import type { Page } from 'playwright-core';

export async function getAccessibilitySnapshot(page: Page): Promise<string> {
  try {
    const snapshot = await (page as any)._snapshotForAI();
    if (!snapshot?.full) return 'Page has no accessibility tree';

    return `# Page Accessibility Snapshot

URL: ${page.url()}
Title: ${await page.title()}

## Accessibility Tree

${snapshot.full}

---
Use the ref values (e.g., [ref=s1e3]) with click, type, etc. to interact with elements.`;
  } catch {
    return getAccessibilitySnapshotViaCDP(page);
  }
}

async function getAccessibilitySnapshotViaCDP(page: Page): Promise<string> {
  const client = await page.context().newCDPSession(page);

  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    if (!nodes?.length) return 'Page has no accessibility tree';

    const nodeMap = new Map<string, any>();
    for (const node of nodes) nodeMap.set(node.nodeId, node);

    const root = nodes.find((n: any) => !n.parentId);

    function fmt(node: any, indent = 0): string {
      if (!node) return '';
      const prefix = '  '.repeat(indent);
      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';

      if (node.ignored || (role === 'generic' && !name)) {
        return (node.childIds ?? [])
          .map((id: string) => fmt(nodeMap.get(id), indent))
          .join('');
      }

      let line = `${prefix}- ${role}`;
      if (name) line += `: "${name}"`;
      if (node.value?.value !== undefined) line += ` [value: "${node.value.value}"]`;
      line += '\n';

      return line + (node.childIds ?? [])
        .map((id: string) => fmt(nodeMap.get(id), indent + 1))
        .join('');
    }

    return `# Page Accessibility Snapshot

URL: ${page.url()}
Title: ${await page.title()}

## Accessibility Tree

${fmt(root)}`;
  } finally {
    await client.detach();
  }
}

/**
 * Find an element by aria-ref or CSS selector
 */
export async function findElement(page: Page, ref: string, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    // aria-ref from _snapshotForAI (e.g. "e3", "s1e3")
    if (/^(s\d+)?e\d+$/.test(ref)) {
      try {
        const loc = page.locator(`aria-ref=${ref}`);
        await loc.waitFor({ state: 'attached', timeout: 3000 });
        const el = await loc.first().elementHandle();
        if (el) return el;
      } catch {
        if (i < retries) { await page.waitForTimeout(500); continue; }
      }
    }

    // CSS selector
    try {
      const el = await page.$(ref);
      if (el) return el;
    } catch {}

    // Text content
    try {
      const el = await page.getByText(ref, { exact: false }).first().elementHandle();
      if (el) return el;
    } catch {}

    if (i < retries) await page.waitForTimeout(500);
  }

  return null;
}
