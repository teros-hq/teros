import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession, findElement } from '../lib/index.js';

export const fillForm: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Fill multiple form fields at once.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      fields: {
        type: 'array',
        description: 'Fields to fill',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable field name' },
            ref: { type: 'string', description: 'Element ref or CSS selector' },
            type: {
              type: 'string',
              enum: ['textbox', 'checkbox', 'radio', 'combobox'],
              description: 'Field type',
            },
            value: { type: 'string', description: 'Value to set' },
          },
          required: ['name', 'ref', 'type', 'value'],
        },
      },
    },
    required: ['sessionId', 'fields'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    const fields = args.fields as Array<{ name: string; ref: string; type: string; value: string }>;
    const results: string[] = [];

    for (const field of fields) {
      const el = await findElement(page, field.ref);
      if (!el) { results.push(`❌ ${field.name}: element not found`); continue; }

      try {
        switch (field.type) {
          case 'textbox':
            await el.fill(field.value);
            results.push(`✅ ${field.name}: filled`);
            break;
          case 'checkbox': {
            const checked = await el.isChecked();
            const want = field.value === 'true';
            if (checked !== want) await el.click();
            results.push(`✅ ${field.name}: ${want ? 'checked' : 'unchecked'}`);
            break;
          }
          case 'radio':
            await el.click();
            results.push(`✅ ${field.name}: selected`);
            break;
          case 'combobox':
            await el.selectOption({ label: field.value });
            results.push(`✅ ${field.name}: selected "${field.value}"`);
            break;
          default:
            results.push(`❌ ${field.name}: unknown type "${field.type}"`);
        }
      } catch (e) {
        results.push(`❌ ${field.name}: ${e instanceof Error ? e.message : 'error'}`);
      }
    }

    return results.join('\n');
  },
};
