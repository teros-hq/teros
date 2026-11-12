import { describe, it, expect } from 'bun:test';
import {
  UiResourceTypeSchema,
  TreeNodeSchema,
  TreeResourceDataSchema,
  DetailFieldSchema,
  DetailSectionSchema,
  DetailResourceDataSchema,
  UiFormFieldSchema,
  FormResourceDataSchema,
  UiResourceDataSchema,
  UiResourceDefinitionSchema,
  ListUiResourcesRequestSchema,
  ListUiResourcesResponseSchema,
  GetUiResourceRequestSchema,
  GetUiResourceResponseSchema,
  SubmitUiResourceRequestSchema,
  SubmitUiResourceResponseSchema,
  isUiResourceType,
  isTreeResourceData,
  isDetailResourceData,
  isFormResourceData,
} from '@teros/shared';

// ============================================================================
// RESOURCE TYPE ENUM
// ============================================================================

describe('UiResourceTypeSchema', () => {
  it('accepts tree, detail, form', () => {
    expect(UiResourceTypeSchema.safeParse('tree').success).toBe(true);
    expect(UiResourceTypeSchema.safeParse('detail').success).toBe(true);
    expect(UiResourceTypeSchema.safeParse('form').success).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(UiResourceTypeSchema.safeParse('widget').success).toBe(false);
    expect(UiResourceTypeSchema.safeParse('').success).toBe(false);
    expect(UiResourceTypeSchema.safeParse(null).success).toBe(false);
  });
});

// ============================================================================
// TREE NODE
// ============================================================================

describe('TreeNodeSchema', () => {
  it('accepts a minimal leaf node', () => {
    const node = { id: 'n1', label: 'My File' };
    const result = TreeNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it('accepts a node with all optional fields', () => {
    const node = {
      id: 'n1',
      label: 'folder',
      icon: 'folder',
      badge: '3 items',
      expanded: true,
      meta: { path: '/foo' },
    };
    const result = TreeNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it('accepts recursive children', () => {
    const node = {
      id: 'root',
      label: 'root',
      children: [
        { id: 'c1', label: 'child 1' },
        {
          id: 'c2',
          label: 'child 2',
          children: [{ id: 'g1', label: 'grandchild' }],
        },
      ],
    };
    const result = TreeNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it('rejects missing id or label', () => {
    expect(TreeNodeSchema.safeParse({ label: 'no id' }).success).toBe(false);
    expect(TreeNodeSchema.safeParse({ id: 'no-label' }).success).toBe(false);
  });
});

// ============================================================================
// TREE RESOURCE DATA
// ============================================================================

describe('TreeResourceDataSchema', () => {
  it('accepts a tree with nodes', () => {
    const data = {
      type: 'tree',
      nodes: [{ id: 'n1', label: 'root' }],
    };
    const result = TreeResourceDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts a tree with title and multiSelect', () => {
    const data = {
      type: 'tree',
      nodes: [],
      title: 'Project Files',
      multiSelect: true,
    };
    const result = TreeResourceDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing nodes array', () => {
    expect(TreeResourceDataSchema.safeParse({ type: 'tree' }).success).toBe(false);
  });

  it('rejects wrong type discriminator', () => {
    expect(
      TreeResourceDataSchema.safeParse({ type: 'detail', nodes: [] }).success,
    ).toBe(false);
  });
});

// ============================================================================
// DETAIL RESOURCE DATA
// ============================================================================

describe('DetailFieldSchema', () => {
  it('accepts a string value with default type', () => {
    const field = { label: 'Name', value: 'teros' };
    const result = DetailFieldSchema.safeParse(field);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('text');
    }
  });

  it('accepts number and boolean values', () => {
    expect(DetailFieldSchema.safeParse({ label: 'Stars', value: 42 }).success).toBe(true);
    expect(DetailFieldSchema.safeParse({ label: 'Active', value: true }).success).toBe(true);
  });

  it('accepts all field types', () => {
    for (const type of ['text', 'code', 'date', 'url', 'markdown', 'image']) {
      expect(
        DetailFieldSchema.safeParse({ label: 'L', value: 'v', type }).success,
      ).toBe(true);
    }
  });
});

describe('DetailResourceDataSchema', () => {
  it('accepts a detail with sections', () => {
    const data = {
      type: 'detail',
      title: 'teros/teros',
      sections: [
        {
          title: 'Info',
          fields: [
            { label: 'Stars', value: 100 },
            { label: 'URL', value: 'https://github.com/teros/teros', type: 'url' },
          ],
        },
      ],
    };
    const result = DetailResourceDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing sections', () => {
    expect(DetailResourceDataSchema.safeParse({ type: 'detail' }).success).toBe(false);
  });
});

// ============================================================================
// FORM RESOURCE DATA
// ============================================================================

describe('UiFormFieldSchema', () => {
  it('accepts a text field', () => {
    const field = { name: 'title', label: 'Title', fieldType: 'text' };
    const result = UiFormFieldSchema.safeParse(field);
    expect(result.success).toBe(true);
  });

  it('accepts a select field with options', () => {
    const field = {
      name: 'priority',
      label: 'Priority',
      fieldType: 'select',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    };
    const result = UiFormFieldSchema.safeParse(field);
    expect(result.success).toBe(true);
  });

  it('accepts a number field with min/max', () => {
    const field = {
      name: 'age',
      label: 'Age',
      fieldType: 'number',
      min: 0,
      max: 120,
      required: true,
    };
    const result = UiFormFieldSchema.safeParse(field);
    expect(result.success).toBe(true);
  });

  it('rejects missing fieldType', () => {
    expect(
      UiFormFieldSchema.safeParse({ name: 'x', label: 'X' }).success,
    ).toBe(false);
  });
});

describe('FormResourceDataSchema', () => {
  it('accepts a form with fields and submitTool', () => {
    const data = {
      type: 'form',
      title: 'Create Issue',
      fields: [
        { name: 'title', label: 'Title', fieldType: 'text', required: true },
        {
          name: 'priority',
          label: 'Priority',
          fieldType: 'select',
          options: [{ value: 'low', label: 'Low' }],
        },
      ],
      submitTool: 'create-issue',
    };
    const result = FormResourceDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing fields', () => {
    expect(FormResourceDataSchema.safeParse({ type: 'form' }).success).toBe(false);
  });
});

// ============================================================================
// DISCRIMINATED UNION
// ============================================================================

describe('UiResourceDataSchema', () => {
  it('discriminates tree by type', () => {
    const result = UiResourceDataSchema.safeParse({
      type: 'tree',
      nodes: [{ id: 'n1', label: 'x' }],
    });
    expect(result.success).toBe(true);
  });

  it('discriminates detail by type', () => {
    const result = UiResourceDataSchema.safeParse({
      type: 'detail',
      sections: [{ fields: [{ label: 'K', value: 'V' }] }],
    });
    expect(result.success).toBe(true);
  });

  it('discriminates form by type', () => {
    const result = UiResourceDataSchema.safeParse({
      type: 'form',
      fields: [{ name: 'x', label: 'X', fieldType: 'text' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(
      UiResourceDataSchema.safeParse({ type: 'widget', data: {} }).success,
    ).toBe(false);
  });
});

// ============================================================================
// RESOURCE DEFINITION
// ============================================================================

describe('UiResourceDefinitionSchema', () => {
  it('accepts a minimal definition', () => {
    const def = {
      name: 'repo-tree',
      resourceType: 'tree',
      description: 'Repository file tree',
    };
    const result = UiResourceDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it('accepts a full definition with parameters and bindings', () => {
    const def = {
      name: 'repo-tree',
      resourceType: 'tree',
      description: 'Repository file tree',
      parameters: {
        type: 'object' as const,
        properties: { repo: { type: 'string' } },
        required: ['repo'],
      },
      boundTools: ['list-files'],
      refreshOnEvents: ['file:changed'],
    };
    const result = UiResourceDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(
      UiResourceDefinitionSchema.safeParse({
        resourceType: 'tree',
        description: 'x',
      }).success,
    ).toBe(false);
  });
});

// ============================================================================
// PROTOCOL MESSAGES
// ============================================================================

describe('Protocol Messages', () => {
  it('list_ui_resources request', () => {
    const result = ListUiResourcesRequestSchema.safeParse({
      type: 'list_ui_resources',
    });
    expect(result.success).toBe(true);
  });

  it('list_ui_resources response with resources', () => {
    const result = ListUiResourcesResponseSchema.safeParse({
      type: 'ui_resources_list',
      resources: [
        { name: 'repo-tree', resourceType: 'tree', description: 'File tree' },
        { name: 'issue-detail', resourceType: 'detail', description: 'Issue details' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('get_ui_resource request with params', () => {
    const result = GetUiResourceRequestSchema.safeParse({
      type: 'get_ui_resource',
      name: 'repo-tree',
      params: { repo: 'teros/teros' },
    });
    expect(result.success).toBe(true);
  });

  it('get_ui_resource response with tree data', () => {
    const result = GetUiResourceResponseSchema.safeParse({
      type: 'ui_resource_data',
      data: {
        type: 'tree',
        nodes: [{ id: 'n1', label: 'root' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('submit_ui_resource request with values', () => {
    const result = SubmitUiResourceRequestSchema.safeParse({
      type: 'submit_ui_resource',
      name: 'create-issue',
      values: { title: 'Bug', priority: 'high' },
    });
    expect(result.success).toBe(true);
  });

  it('submit_ui_resource response', () => {
    const result = SubmitUiResourceResponseSchema.safeParse({
      type: 'ui_resource_submitted',
      success: true,
      message: 'Issue created',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// TYPE GUARDS
// ============================================================================

describe('Type Guards', () => {
  it('isUiResourceType', () => {
    expect(isUiResourceType('tree')).toBe(true);
    expect(isUiResourceType('detail')).toBe(true);
    expect(isUiResourceType('form')).toBe(true);
    expect(isUiResourceType('widget')).toBe(false);
  });

  it('isTreeResourceData', () => {
    expect(isTreeResourceData({ type: 'tree', nodes: [] })).toBe(true);
    expect(isTreeResourceData({ type: 'detail', sections: [] })).toBe(false);
  });

  it('isDetailResourceData', () => {
    expect(
      isDetailResourceData({ type: 'detail', sections: [{ fields: [] }] }),
    ).toBe(true);
    expect(isDetailResourceData({ type: 'tree', nodes: [] })).toBe(false);
  });

  it('isFormResourceData', () => {
    expect(
      isFormResourceData({ type: 'form', fields: [{ name: 'x', label: 'X', fieldType: 'text' }] }),
    ).toBe(true);
    expect(isFormResourceData({ type: 'tree', nodes: [] })).toBe(false);
  });
});
