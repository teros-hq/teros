/**
 * Renderer — converts UiResourceData into text/markdown/html output.
 *
 * When a tool bound to a UI resource returns, the dispatch logic calls
 * the resource handler with the tool result, then passes the resulting
 * `UiResourceData` through this module to produce a rendered string the
 * host can embed in the chat alongside the structured tool result.
 *
 * Three output formats are supported:
 * - `markdown`: the default — works in any chat that renders markdown.
 * - `text`: plain text, no markup — for hosts without markdown support.
 * - `html`: self-contained HTML — for hosts that render inline HTML.
 *
 * The renderer is intentionally framework-agnostic: it does not depend
 * on React Native, DOM APIs, or any host-specific rendering engine.
 * It produces strings.
 *
 * @see docs/RFC-001-mca-protocol.md — "UI Resources" section
 */

import type {
  DetailField,
  DetailSection,
  TreeNode,
  UiResourceData,
} from './server';

// ============================================================================
// TYPES
// ============================================================================

/**
 * The format the renderer should produce.
 */
export type RenderFormat = 'markdown' | 'text' | 'html';

/**
 * The rendered output attached to a tool result response.
 */
export interface RenderedOutput {
  /** Which format the `content` field is in. */
  format: RenderFormat;
  /** The rendered string (markdown, text, or html). */
  content: string;
  /** The name of the UI resource that produced this output. */
  resource: string;
  /** The resource type ('tree', 'detail', or 'form'). */
  resourceType: string;
}

// ============================================================================
// MARKDOWN RENDERERS
// ============================================================================

/**
 * Render a tree node and its children as markdown bullet points.
 *
 *   - 📁 src/
 *     - index.ts
 *     - utils.ts
 *   - README.md
 */
function renderTreeMarkdown(nodes: TreeNode[], indent = 0): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const prefix = '  '.repeat(indent) + '- ';
    const icon = node.icon ? `${node.icon} ` : '';
    const badge = node.badge ? ` \`${node.badge}\`` : '';
    lines.push(`${prefix}${icon}${node.label}${badge}`);

    if (node.children && node.children.length > 0) {
      lines.push(renderTreeMarkdown(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

/**
 * Render a detail field as a markdown table row or list item.
 */
function renderFieldMarkdown(field: DetailField): string {
  const value = String(field.value);

  switch (field.type) {
    case 'code':
      return `**${field.label}:** \`${value}\``;
    case 'url':
      return `**${field.label}:** [${field.linkText || value}](${value})`;
    case 'image':
      return `**${field.label}:** ![${field.alt || field.label}](${value})`;
    case 'markdown':
      return `**${field.label}:** ${value}`;
    case 'date':
      return `**${field.label}:** ${value}`;
    default:
      return `**${field.label}:** ${value}`;
  }
}

/**
 * Render a detail panel as markdown.
 */
function renderDetailMarkdown(data: Extract<UiResourceData, { type: 'detail' }>): string {
  const lines: string[] = [];

  if (data.title) {
    lines.push(`### ${data.title}`);
    if (data.subtitle) lines.push(`*${data.subtitle}*`);
    lines.push('');
  }

  if (data.imageUrl) {
    lines.push(`![${data.title || 'image'}](${data.imageUrl})`);
    lines.push('');
  }

  if (data.badge) {
    lines.push(`> \`${data.badge}\``);
    lines.push('');
  }

  for (const section of data.sections) {
    if (section.title) {
      lines.push(`**${section.title}**`);
      lines.push('');
    }
    for (const field of section.fields) {
      lines.push(`- ${renderFieldMarkdown(field)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Render a form as markdown.
 */
function renderFormMarkdown(data: Extract<UiResourceData, { type: 'form' }>): string {
  const lines: string[] = [];

  if (data.title) {
    lines.push(`### ${data.title}`);
    lines.push('');
  }

  if (data.description) {
    lines.push(data.description);
    lines.push('');
  }

  for (const field of data.fields) {
    const required = field.required ? ' *(required)*' : '';
    const help = field.helpText ? ` — ${field.helpText}` : '';
    const defaultVal = field.defaultValue !== undefined ? ` (default: \`${field.defaultValue}\`)` : '';

    if (field.fieldType === 'textarea') {
      lines.push(`- **${field.label}**${required}${help}`);
      if (field.placeholder) lines.push(`  > _${field.placeholder}_`);
    } else if (field.fieldType === 'select' && field.options) {
      const opts = field.options.map((o) => `\`${o.value}\``).join(', ');
      lines.push(`- **${field.label}**${required}${help} [${opts}]${defaultVal}`);
    } else {
      lines.push(`- **${field.label}**${required}${help}${defaultVal}`);
      if (field.placeholder) lines.push(`  > _${field.placeholder}_`);
    }
  }

  if (data.submitLabel) {
    lines.push('');
    lines.push(`*[${data.submitLabel}]*`);
  }

  return lines.join('\n').trimEnd();
}

// ============================================================================
// TEXT RENDERERS (plain text, no markup)
// ============================================================================

function renderTreeText(nodes: TreeNode[], indent = 0): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const prefix = '  '.repeat(indent) + (indent === 0 ? '' : '  ');
    const badge = node.badge ? ` [${node.badge}]` : '';
    lines.push(`${prefix}${node.label}${badge}`);

    if (node.children && node.children.length > 0) {
      lines.push(renderTreeText(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

function renderDetailText(data: Extract<UiResourceData, { type: 'detail' }>): string {
  const lines: string[] = [];

  if (data.title) {
    lines.push(data.title);
    if (data.subtitle) lines.push(data.subtitle);
    lines.push('');
  }

  for (const section of data.sections) {
    if (section.title) {
      lines.push(section.title);
    }
    for (const field of section.fields) {
      lines.push(`  ${field.label}: ${field.value}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderFormText(data: Extract<UiResourceData, { type: 'form' }>): string {
  const lines: string[] = [];

  if (data.title) {
    lines.push(data.title);
    lines.push('');
  }

  if (data.description) {
    lines.push(data.description);
    lines.push('');
  }

  for (const field of data.fields) {
    const required = field.required ? ' (required)' : '';
    lines.push(`- ${field.label}${required}`);
    if (field.helpText) lines.push(`  ${field.helpText}`);
  }

  return lines.join('\n').trimEnd();
}

// ============================================================================
// HTML RENDERERS
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTreeHtml(nodes: TreeNode[]): string {
  const renderNode = (node: TreeNode): string => {
    const badge = node.badge
      ? ` <span style="font-size:0.8em;background:#e5e7b1;padding:1px 6px;border-radius:3px;">${escapeHtml(node.badge)}</span>`
      : '';
    const icon = node.icon ? `<span>${escapeHtml(node.icon)} </span>` : '';
    const children =
      node.children && node.children.length > 0
        ? `<ul>${node.children.map(renderNode).join('')}</ul>`
        : '';
    return `<li>${icon}${escapeHtml(node.label)}${badge}${children}</li>`;
  };

  return `<ul>${nodes.map(renderNode).join('')}</ul>`;
}

function renderFieldHtml(field: DetailField): string {
  const label = escapeHtml(field.label);
  const value = String(field.value);

  switch (field.type) {
    case 'code':
      return `<dt>${label}</dt><dd><code>${escapeHtml(value)}</code></dd>`;
    case 'url':
      return `<dt>${label}</dt><dd><a href="${escapeHtml(value)}">${escapeHtml(field.linkText || value)}</a></dd>`;
    case 'image':
      return `<dt>${label}</dt><dd><img src="${escapeHtml(value)}" alt="${escapeHtml(field.alt || field.label)}" style="max-width:100%;"/></dd>`;
    case 'markdown':
      return `<dt>${label}</dt><dd>${value}</dd>`;
    default:
      return `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;
  }
}

function renderDetailHtml(data: Extract<UiResourceData, { type: 'detail' }>): string {
  const parts: string[] = [];

  if (data.title) {
    parts.push(`<h3>${escapeHtml(data.title)}</h3>`);
    if (data.subtitle) parts.push(`<p><em>${escapeHtml(data.subtitle)}</em></p>`);
  }

  if (data.imageUrl) {
    parts.push(`<img src="${escapeHtml(data.imageUrl)}" alt="${escapeHtml(data.title || 'image')}" style="max-width:100%;"/>`);
  }

  if (data.badge) {
    parts.push(`<span style="display:inline-block;background:#e5e7b1;padding:2px 8px;border-radius:4px;font-size:0.85em;">${escapeHtml(data.badge)}</span>`);
  }

  for (const section of data.sections) {
    if (section.title) {
      parts.push(`<h4>${escapeHtml(section.title)}</h4>`);
    }
    const rows = section.fields.map(renderFieldHtml).join('');
    parts.push(`<dl>${rows}</dl>`);
  }

  return parts.join('\n');
}

function renderFormHtml(data: Extract<UiResourceData, { type: 'form' }>): string {
  const parts: string[] = [];

  if (data.title) {
    parts.push(`<h3>${escapeHtml(data.title)}</h3>`);
  }

  if (data.description) {
    parts.push(`<p>${escapeHtml(data.description)}</p>`);
  }

  const fields = data.fields
    .map((field) => {
      const required = field.required ? ' <span style="color:#c00;">*</span>' : '';
      const help = field.helpText ? `<br/><small>${escapeHtml(field.helpText)}</small>` : '';
      return `<div><label><strong>${escapeHtml(field.label)}${required}</strong>${help}</label></div>`;
    })
    .join('');

  parts.push(fields);

  if (data.submitLabel) {
    parts.push(`<button type="button">${escapeHtml(data.submitLabel)}</button>`);
  }

  return parts.join('\n');
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Render `UiResourceData` into the requested format.
 *
 * @param data - the structured renderable data from a UI resource handler
 * @param format - the output format (default: 'markdown')
 * @returns the rendered string
 */
export function renderUiResourceData(data: UiResourceData, format: RenderFormat = 'markdown'): string {
  switch (format) {
    case 'html': {
      switch (data.type) {
        case 'tree':
          return renderTreeHtml(data.nodes);
        case 'detail':
          return renderDetailHtml(data);
        case 'form':
          return renderFormHtml(data);
      }
      break;
    }
    case 'text': {
      switch (data.type) {
        case 'tree': {
          const lines: string[] = [];
          if (data.title) {
            lines.push(data.title);
            lines.push('');
          }
          lines.push(renderTreeText(data.nodes));
          return lines.join('\n');
        }
        case 'detail':
          return renderDetailText(data);
        case 'form':
          return renderFormText(data);
      }
      break;
    }
    case 'markdown':
    default: {
      switch (data.type) {
        case 'tree': {
          const lines: string[] = [];
          if (data.title) {
            lines.push(`### ${data.title}`);
            lines.push('');
          }
          lines.push(renderTreeMarkdown(data.nodes));
          return lines.join('\n');
        }
        case 'detail':
          return renderDetailMarkdown(data);
        case 'form':
          return renderFormMarkdown(data);
      }
      break;
    }
  }
}

/**
 * Render `UiResourceData` into a full `RenderedOutput` object.
 *
 * @param data - the structured renderable data from a UI resource handler
 * @param resourceName - the name of the UI resource
 * @param format - the output format (default: 'markdown')
 */
export function renderToOutput(
  data: UiResourceData,
  resourceName: string,
  format: RenderFormat = 'markdown',
): RenderedOutput {
  return {
    format,
    content: renderUiResourceData(data, format),
    resource: resourceName,
    resourceType: data.type,
  };
}
