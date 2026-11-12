import { describe, expect, it } from 'bun:test';
import {
  renderUiResourceData,
  renderToOutput,
  type UiResourceData,
  type TreeNode,
  type DetailSection,
  type UiFormField,
} from '../src/renderer';

// ============================================================================
// TREE RENDERING
// ============================================================================

describe('renderer — tree', () => {
  const treeData: UiResourceData = {
    type: 'tree',
    title: 'Project Files',
    nodes: [
      {
        id: '1',
        label: 'src/',
        icon: '📁',
        children: [
          { id: '2', label: 'index.ts' },
          { id: '3', label: 'utils.ts', badge: 'new' },
        ],
      },
      { id: '4', label: 'README.md' },
    ],
  };

  it('renders tree as markdown', () => {
    const output = renderUiResourceData(treeData, 'markdown');
    expect(output).toContain('### Project Files');
    expect(output).toContain('- 📁 src/');
    expect(output).toContain('  - index.ts');
    expect(output).toContain('  - utils.ts `new`');
    expect(output).toContain('- README.md');
  });

  it('renders tree as text', () => {
    const output = renderUiResourceData(treeData, 'text');
    expect(output).toContain('Project Files');
    expect(output).toContain('src/');
    expect(output).toContain('index.ts');
    expect(output).toContain('utils.ts [new]');
    expect(output).toContain('README.md');
    // No markdown markers in text output
    expect(output).not.toContain('###');
    expect(output).not.toContain('`');
  });

  it('renders tree as html', () => {
    const output = renderUiResourceData(treeData, 'html');
    expect(output).toContain('<ul>');
    expect(output).toContain('<li>');
    expect(output).toContain('src/');
    expect(output).toContain('index.ts');
    expect(output).toContain('utils.ts');
    expect(output).toContain('</ul>');
  });

  it('renders tree without title', () => {
    const data: UiResourceData = {
      type: 'tree',
      nodes: [{ id: '1', label: 'root' }],
    };
    const md = renderUiResourceData(data, 'markdown');
    expect(md).not.toContain('###');
    expect(md).toContain('- root');
  });
});

// ============================================================================
// DETAIL RENDERING
// ============================================================================

describe('renderer — detail', () => {
  const detailData: UiResourceData = {
    type: 'detail',
    title: 'GitHub Repo',
    subtitle: 'teros/teros',
    badge: 'public',
    sections: [
      {
        title: 'Info',
        fields: [
          { label: 'Stars', value: 1234, type: 'text' },
          { label: 'Language', value: 'TypeScript', type: 'code' },
          { label: 'URL', value: 'https://github.com/teros/teros', type: 'url', linkText: 'View on GitHub' },
        ],
      },
    ],
  };

  it('renders detail as markdown', () => {
    const output = renderUiResourceData(detailData, 'markdown');
    expect(output).toContain('### GitHub Repo');
    expect(output).toContain('*teros/teros*');
    expect(output).toContain('`public`');
    expect(output).toContain('**Info**');
    expect(output).toContain('**Stars:** 1234');
    expect(output).toContain('**Language:** `TypeScript`');
    expect(output).toContain('[View on GitHub](https://github.com/teros/teros)');
  });

  it('renders detail as text', () => {
    const output = renderUiResourceData(detailData, 'text');
    expect(output).toContain('GitHub Repo');
    expect(output).toContain('teros/teros');
    expect(output).toContain('Stars: 1234');
    expect(output).toContain('Language: TypeScript');
    // No markdown in text
    expect(output).not.toContain('###');
    expect(output).not.toContain('**');
  });

  it('renders detail as html', () => {
    const output = renderUiResourceData(detailData, 'html');
    expect(output).toContain('<h3>GitHub Repo</h3>');
    expect(output).toContain('<em>teros/teros</em>');
    expect(output).toContain('<dl>');
    expect(output).toContain('<dt>Stars</dt>');
    expect(output).toContain('<dd>1234</dd>');
    expect(output).toContain('<code>TypeScript</code>');
    expect(output).toContain('<a href="https://github.com/teros/teros">View on GitHub</a>');
  });

  it('escapes HTML in detail fields', () => {
    const data: UiResourceData = {
      type: 'detail',
      sections: [
        {
          fields: [
            { label: 'Description', value: '<script>alert("xss")</script>', type: 'text' },
          ],
        },
      ],
    };
    const html = renderUiResourceData(data, 'html');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

// ============================================================================
// FORM RENDERING
// ============================================================================

describe('renderer — form', () => {
  const formData: UiResourceData = {
    type: 'form',
    title: 'Create Issue',
    description: 'Fill in the details below',
    fields: [
      { name: 'title', label: 'Title', fieldType: 'text', required: true, placeholder: 'Enter title' },
      { name: 'priority', label: 'Priority', fieldType: 'select', options: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ]},
      { name: 'body', label: 'Body', fieldType: 'textarea', helpText: 'Markdown supported' },
    ],
    submitLabel: 'Create',
  };

  it('renders form as markdown', () => {
    const output = renderUiResourceData(formData, 'markdown');
    expect(output).toContain('### Create Issue');
    expect(output).toContain('Fill in the details below');
    expect(output).toContain('**Title** *(required)*');
    expect(output).toContain('_Enter title_');
    expect(output).toContain('`low`');
    expect(output).toContain('`high`');
    expect(output).toContain('— Markdown supported');
    expect(output).toContain('*[Create]*');
  });

  it('renders form as text', () => {
    const output = renderUiResourceData(formData, 'text');
    expect(output).toContain('Create Issue');
    expect(output).toContain('Title (required)');
    expect(output).toContain('Markdown supported');
    // No markdown
    expect(output).not.toContain('###');
    expect(output).not.toContain('**');
  });

  it('renders form as html', () => {
    const output = renderUiResourceData(formData, 'html');
    expect(output).toContain('<h3>Create Issue</h3>');
    expect(output).toContain('<label>');
    expect(output).toContain('<strong>Title');
    expect(output).toContain('<button');
    expect(output).toContain('Create');
  });
});

// ============================================================================
// renderToOutput
// ============================================================================

describe('renderToOutput', () => {
  it('produces a full RenderedOutput object', () => {
    const data: UiResourceData = {
      type: 'tree',
      nodes: [{ id: '1', label: 'root' }],
    };
    const output = renderToOutput(data, 'my-resource', 'markdown');
    expect(output.format).toBe('markdown');
    expect(output.content).toContain('- root');
    expect(output.resource).toBe('my-resource');
    expect(output.resourceType).toBe('tree');
  });

  it('defaults to markdown format', () => {
    const data: UiResourceData = {
      type: 'detail',
      sections: [{ fields: [{ label: 'X', value: 1 }] }],
    };
    const output = renderToOutput(data, 'res');
    expect(output.format).toBe('markdown');
  });
});

// ============================================================================
// DEFAULT FORMAT
// ============================================================================

describe('renderUiResourceData — default format', () => {
  it('defaults to markdown when no format specified', () => {
    const data: UiResourceData = {
      type: 'tree',
      nodes: [{ id: '1', label: 'test' }],
    };
    const output = renderUiResourceData(data);
    expect(output).toContain('- test');
  });
});
