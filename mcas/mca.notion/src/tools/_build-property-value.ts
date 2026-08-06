/**
 * buildPropertyValue — turns a "simple" agent-friendly value into the
 * verbose Notion property shape required for `pages.create`/`pages.update`.
 *
 * The agent thinks in terms of:
 *   { Status: "Done", Tags: ["urgent"], Assignee: ["uuid"], DueDate: "2026-05-06" }
 *
 * Notion expects:
 *   {
 *     Status:   { status: { name: "Done" } },
 *     Tags:     { multi_select: [{ name: "urgent" }] },
 *     Assignee: { people: [{ id: "uuid" }] },
 *     DueDate:  { date: { start: "2026-05-06" } },
 *   }
 *
 * This helper covers the 14 writable property types. Read-only types
 * (created_time, last_edited_time, formula, rollup, unique_id, button,
 * place, verification) throw a typed error when the agent tries to write
 * to them — same UX as Notion itself.
 */

export class PropertyConversionError extends Error {
  constructor(
    public propertyName: string,
    public notionType: string,
    message: string,
  ) {
    super(`property "${propertyName}" (${notionType}): ${message}`);
    this.name = 'PropertyConversionError';
  }
}

const READ_ONLY_TYPES = new Set([
  'created_time',
  'last_edited_time',
  'formula',
  'rollup',
  'unique_id',
  'button',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.+)?$/;

function asString(name: string, type: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new PropertyConversionError(name, type, `expected a string, got ${typeof value}`);
  }
  return value;
}

function asNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PropertyConversionError(name, 'number', `expected a finite number, got ${typeof value}`);
  }
  return value;
}

function asArray<T = unknown>(name: string, type: string, value: unknown): T[] {
  if (!Array.isArray(value)) {
    throw new PropertyConversionError(name, type, 'expected an array');
  }
  return value as T[];
}

export function buildPropertyValue(
  propertyName: string,
  notionType: string,
  simpleValue: unknown,
): Record<string, unknown> {
  if (READ_ONLY_TYPES.has(notionType)) {
    throw new PropertyConversionError(
      propertyName,
      notionType,
      'this property type is read-only — Notion computes it server-side.',
    );
  }

  // null clears single-value props (Notion convention). We pass through
  // `null` for the underlying value where supported.
  switch (notionType) {
    case 'title': {
      const text = simpleValue == null ? '' : String(simpleValue);
      return { title: [{ text: { content: text } }] };
    }
    case 'rich_text': {
      const text = simpleValue == null ? '' : String(simpleValue);
      return { rich_text: [{ text: { content: text } }] };
    }
    case 'number':
      return { number: simpleValue == null ? null : asNumber(propertyName, simpleValue) };
    case 'checkbox': {
      if (typeof simpleValue !== 'boolean') {
        throw new PropertyConversionError(propertyName, 'checkbox', 'expected boolean');
      }
      return { checkbox: simpleValue };
    }
    case 'url':
      return { url: simpleValue == null ? null : asString(propertyName, 'url', simpleValue) };
    case 'email':
      return { email: simpleValue == null ? null : asString(propertyName, 'email', simpleValue) };
    case 'phone_number':
      return {
        phone_number:
          simpleValue == null ? null : asString(propertyName, 'phone_number', simpleValue),
      };
    case 'select':
      if (simpleValue == null) return { select: null };
      return { select: { name: asString(propertyName, 'select', simpleValue) } };
    case 'status':
      // Status is writable in v5 (was read-only in earlier API versions).
      if (simpleValue == null) return { status: null };
      return { status: { name: asString(propertyName, 'status', simpleValue) } };
    case 'multi_select': {
      if (simpleValue == null) return { multi_select: [] };
      const arr = asArray<string>(propertyName, 'multi_select', simpleValue);
      return {
        multi_select: arr.map((v) => ({ name: asString(propertyName, 'multi_select', v) })),
      };
    }
    case 'date': {
      if (simpleValue == null) return { date: null };
      if (typeof simpleValue === 'string') {
        if (!ISO_DATE_RE.test(simpleValue)) {
          throw new PropertyConversionError(
            propertyName,
            'date',
            'expected ISO 8601 string (YYYY-MM-DD or full datetime)',
          );
        }
        return { date: { start: simpleValue } };
      }
      if (typeof simpleValue === 'object') {
        const obj = simpleValue as { start?: unknown; end?: unknown; timeZone?: unknown };
        if (typeof obj.start !== 'string') {
          throw new PropertyConversionError(propertyName, 'date', 'object form requires `start: string`');
        }
        const date: Record<string, unknown> = { start: obj.start };
        if (obj.end != null) date.end = obj.end;
        if (obj.timeZone != null) date.time_zone = obj.timeZone;
        return { date };
      }
      throw new PropertyConversionError(propertyName, 'date', 'expected ISO string or { start, end?, timeZone? }');
    }
    case 'people': {
      // Notion API rejects bot user IDs in `people` columns with
      // "Cannot mention bots". Pass only person UUIDs.
      if (simpleValue == null) return { people: [] };
      const arr = asArray<unknown>(propertyName, 'people', simpleValue);
      return {
        people: arr.map((id) => ({ id: asString(propertyName, 'people', id) })),
      };
    }
    case 'files': {
      if (simpleValue == null) return { files: [] };
      const arr = asArray<unknown>(propertyName, 'files', simpleValue);
      return {
        files: arr.map((f) => {
          if (typeof f === 'string') {
            return { name: f, external: { url: f } };
          }
          if (f && typeof f === 'object') {
            const o = f as { name?: unknown; url?: unknown; fileUploadId?: unknown };
            if (typeof o.fileUploadId === 'string') {
              return {
                name: typeof o.name === 'string' ? o.name : 'attachment',
                file_upload: { id: o.fileUploadId },
              };
            }
            if (typeof o.url === 'string') {
              return {
                name: typeof o.name === 'string' ? o.name : o.url,
                external: { url: o.url },
              };
            }
          }
          throw new PropertyConversionError(
            propertyName,
            'files',
            'each item must be a URL string, { name?, url } or { name?, fileUploadId }',
          );
        }),
      };
    }
    case 'relation': {
      if (simpleValue == null) return { relation: [] };
      const arr = asArray<unknown>(propertyName, 'relation', simpleValue);
      return {
        relation: arr.map((id) => ({ id: asString(propertyName, 'relation', id) })),
      };
    }
    default:
      throw new PropertyConversionError(
        propertyName,
        notionType,
        'unsupported property type for write — open an issue if this should be supported.',
      );
  }
}

/**
 * Build a Notion `properties` object from a simple `{ key: value }` map and
 * the database schema. Throws a single error per failing property with the
 * column name + type so the agent can fix its payload.
 */
export function buildPropertiesFromSimple(
  schema: Record<string, { type: string; name?: string }>,
  simple: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(simple)) {
    const meta = schema[key];
    if (!meta) {
      throw new PropertyConversionError(
        key,
        'unknown',
        `column does not exist in this database schema. Available columns: ${Object.keys(schema).join(', ') || '(none)'}.`,
      );
    }
    out[key] = buildPropertyValue(key, meta.type, value);
  }
  return out;
}
