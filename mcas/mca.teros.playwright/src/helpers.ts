/**
 * Snapshot y element helpers de mca.teros.playwright — extraídos move 1:1
 * del index.ts (TER-506; importar index.ts ejecuta server.start()).
 * Funciones SIN estado module-level: reciben la Page como argumento.
 */

import type { ElementHandle, Page } from 'playwright';

// =============================================================================
// SNAPSHOT HELPERS
// =============================================================================

export async function getAccessibilitySnapshot(p: Page): Promise<string> {
  // Use Playwright's internal _snapshotForAI method (available since ~1.49)
  // This generates ARIA snapshots with refs that can be used with aria-ref= locators
  try {
    const snapshot = await (p as any)._snapshotForAI();

    if (!snapshot || !snapshot.full) {
      return 'Page has no accessibility tree';
    }

    return `# Page Accessibility Snapshot

URL: ${p.url()}
Title: ${await p.title()}

## Accessibility Tree

${snapshot.full}

---
Use the ref values (e.g., [ref=s1e3]) with browser-click, browser-type, etc. to interact with elements.`;
  } catch (error) {
    // Fallback to CDP if _snapshotForAI is not available
    return await getAccessibilitySnapshotViaCDP(p);
  }
}

export async function getAccessibilitySnapshotViaCDP(p: Page): Promise<string> {
  // Fallback: Use CDP to get accessibility tree
  const client = await p.context().newCDPSession(p);

  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree');

    if (!nodes || nodes.length === 0) {
      return 'Page has no accessibility tree';
    }

    const nodeMap = new Map<string, any>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    const rootNode = nodes.find((n: any) => !n.parentId);

    function formatNode(node: any, indent: number = 0): string {
      if (!node) return '';

      const prefix = '  '.repeat(indent);
      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';
      const value = node.value?.value;
      const checked = node.checked?.value;
      const selected = node.selected?.value;
      const expanded = node.expanded?.value;

      if (node.ignored || (role === 'generic' && !name)) {
        let result = '';
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeMap.get(childId);
            if (child) result += formatNode(child, indent);
          }
        }
        return result;
      }

      let result = `${prefix}- ${role}`;
      if (name) result += `: "${name}"`;
      if (value !== undefined) result += ` [value: "${value}"]`;
      if (checked !== undefined) result += ` [checked: ${checked}]`;
      if (selected !== undefined) result += ` [selected: ${selected}]`;
      if (expanded !== undefined) result += ` [expanded: ${expanded}]`;
      result += '\n';

      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) result += formatNode(child, indent + 1);
        }
      }

      return result;
    }

    const tree = formatNode(rootNode);
    return `# Page Accessibility Snapshot

URL: ${p.url()}
Title: ${await p.title()}

## Accessibility Tree

${tree}`;
  } finally {
    await client.detach();
  }
}

// =============================================================================
// ELEMENT HELPERS
// =============================================================================

export async function findElementByRef(p: Page, ref: string, retries = 2): Promise<ElementHandle | null> {
  // ref format from _snapshotForAI is like "e3", "e78", "s1e3", etc.
  // These work with the internal aria-ref locator

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Try as aria-ref first (most common case from snapshots)
    // Refs can be "e3", "e78", "s1e3", etc.
    if (/^(s\d+)?e\d+$/.test(ref)) {
      try {
        const locator = p.locator(`aria-ref=${ref}`);
        // Wait briefly for element to be available
        await locator.waitFor({ state: 'attached', timeout: 3000 });
        const element = await locator.first().elementHandle();
        if (element) return element;
      } catch (e) {
        // If this is not the last attempt, wait a bit and retry
        if (attempt < retries) {
          await p.waitForTimeout(500);
          continue;
        }
      }
    }

    // Try as a CSS selector
    try {
      const element = await p.$(ref);
      if (element) return element;
    } catch {}

    // Try as text content
    // timeout explícito: elementHandle() sin timeout espera 30s con texto
    // inexistente → la estrategia role+name era inalcanzable y un ref malo
    // tardaba ~90s (3 intentos × 30s) en devolver null (TER-506).
    try {
      const element = await p
        .getByText(ref, { exact: false })
        .first()
        .elementHandle({ timeout: 2000 });
      if (element) return element;
    } catch {}

    // Try as role + name (e.g., 'button "Submit"')
    try {
      const match = ref.match(/(\w+)\s*"([^"]+)"/);
      if (match) {
        const [, role, name] = match;
        const element = await p
          .getByRole(role as any, { name })
          .first()
          .elementHandle({ timeout: 2000 });
        if (element) return element;
      }
    } catch {}

    // Wait before retry
    if (attempt < retries) {
      await p.waitForTimeout(500);
    }
  }

  return null;
}

