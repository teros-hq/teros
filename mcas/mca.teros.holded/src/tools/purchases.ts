import { holdedRequest, holdedUpload, MAX_ATTACHMENT_BYTES } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw purchase shape returned by the Holded API */
interface HoldedPurchase {
  id?: string;
  _id?: string;
  document_number?: string;
  number?: string;
  date?: string;
  due_date?: string;
  contact_id?: string;
  contact?: string;
  contact_name?: string;
  description?: string;
  notes?: string;
  total?: number;
  subtotal?: number;
  tax?: number;
  status?: string;
  currency?: string;
  items?: unknown[];
  lines?: unknown[];
  tags?: string[];
  custom_fields?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** Line item input for create/update (Holded v2 purchases use `items`) */
interface PurchaseItemInput {
  name?: string;
  type?: string;
  price?: number;
  units?: number;
  quantity?: number;
  discount?: number;
  taxes?: unknown;
  sku?: string;
  serviceId?: string;
  service_id?: string;
  account?: string;
  projectId?: string;
  project_id?: string;
  unitType?: string;
  unit_type?: string;
}

/** Curated purchase detail */
interface CuratedPurchase {
  id: string | null;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  contactId: string | null;
  contactName: string | null;
  description: string | null;
  notes: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  status: string | null;
  currency: string | null;
  items: unknown | null;
  tags: string[] | null;
  customFields: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapPurchaseDetail(p: HoldedPurchase): CuratedPurchase {
  return {
    id: p.id ?? p._id ?? null,
    number: p.document_number ?? p.number ?? null,
    date: p.date ?? null,
    dueDate: p.due_date ?? null,
    contactId: p.contact_id ?? p.contact ?? null,
    contactName: p.contact_name ?? null,
    description: p.description ?? null,
    notes: p.notes ?? null,
    total: p.total ?? null,
    subtotal: p.subtotal ?? null,
    tax: p.tax ?? null,
    status: p.status ?? null,
    currency: p.currency ?? null,
    items: p.items ?? p.lines ?? null,
    tags: p.tags ?? null,
    customFields: p.custom_fields ?? null,
    createdAt: p.created_at ?? null,
    updatedAt: p.updated_at ?? null,
  };
}

/** Convert camelCase item input to the snake_case fields Holded v2 expects. */
function mapPurchaseItem(item: PurchaseItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (item.name !== undefined) out.name = item.name;
  if (item.type !== undefined) out.type = item.type;
  if (item.price !== undefined) out.price = item.price;
  if (item.units !== undefined) out.units = item.units;
  else if (item.quantity !== undefined) out.units = item.quantity;
  if (item.discount !== undefined) out.discount = item.discount;
  if (item.taxes !== undefined) out.taxes = item.taxes;
  if (item.sku !== undefined) out.sku = item.sku;
  if (item.service_id !== undefined) out.service_id = item.service_id;
  else if (item.serviceId !== undefined) out.service_id = item.serviceId;
  if (item.account !== undefined) out.account = item.account;
  if (item.project_id !== undefined) out.project_id = item.project_id;
  else if (item.projectId !== undefined) out.project_id = item.projectId;
  if (item.unit_type !== undefined) out.unit_type = item.unit_type;
  else if (item.unitType !== undefined) out.unit_type = item.unitType;
  return out;
}

/** Build the create/update body from tool args (shared by both tools). */
function buildPurchaseBody(args: {
  contactId?: string;
  contactName?: string;
  date?: string;
  dueDate?: string;
  description?: string;
  notes?: string;
  currency?: string;
  language?: string;
  items?: PurchaseItemInput[];
  tags?: string[];
  customFields?: Array<{ field: string; value: string }> | Record<string, unknown>;
  number?: string;
  warehouseId?: string;
  discount?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.contactId) body.contact_id = args.contactId;
  if (args.contactName) body.contact_name = args.contactName;
  if (args.date) body.date = args.date;
  if (args.dueDate) body.due_date = args.dueDate;
  if (args.description) body.description = args.description;
  if (args.notes) body.notes = args.notes;
  if (args.currency) body.currency = args.currency;
  if (args.language) body.language = args.language;
  if (args.items) body.items = args.items.map(mapPurchaseItem);
  if (args.tags) body.tags = args.tags;
  if (args.customFields) body.custom_fields = args.customFields;
  if (args.number) body.number = args.number;
  if (args.warehouseId) body.warehouse_id = args.warehouseId;
  if (args.discount !== undefined) body.discount = args.discount;
  return body;
}

/** JSON schema for a purchase item (shared by create/update parameters). */
const purchaseItemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Item name' },
    type: {
      type: 'string',
      description: "Item type (e.g. 'product', 'service')",
    },
    price: { type: 'number', description: 'Unit price' },
    units: { type: 'number', description: 'Quantity (default: 1)' },
    discount: { type: 'number', description: 'Discount percentage (0-100)' },
    taxes: {
      type: 'array',
      description: 'Array of tax IDs (e.g. ["s_iva_21"]) applied to this item',
      items: { type: 'string' },
    },
    sku: { type: 'string', description: 'Product SKU' },
    serviceId: { type: 'string', description: 'Related service ID' },
    account: { type: 'string', description: 'Accounting account for this item' },
    projectId: { type: 'string', description: 'Related project ID' },
    unitType: { type: 'string', description: 'Unit type (e.g. units, hours, kg)' },
  },
} as const;

// =============================================================================
// LIST PURCHASES
// =============================================================================

export const listPurchases: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List purchases from Holded. Returns purchase records with id, number, date, supplier, total, and status. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      contactId: {
        type: 'string',
        description: 'Filter purchases by supplier contact ID',
      },
      status: {
        type: 'string',
        description: 'Filter by purchase status (e.g. draft, sent, paid)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, contactId, status } = args as {
      page?: number;
      limit?: number;
      contactId?: string;
      status?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (contactId) params.contact_id = contactId;
    if (status) params.status = status;

    const data = (await holdedRequest(context, '/v2/purchases', {
      params,
    })) as HoldedPurchase[] | { items?: HoldedPurchase[]; has_more?: boolean; cursor?: string };

    const rawPurchases = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const purchases = rawPurchases.map(mapPurchaseDetail);

    return { purchases, count: purchases.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET PURCHASE
// =============================================================================

export const getPurchase: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single purchase from Holded by its ID, including line items and full details.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded purchase ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/purchases/${encodeURIComponent(id)}`,
    )) as HoldedPurchase;

    return mapPurchaseDetail(data);
  },
};

// =============================================================================
// CREATE PURCHASE
// =============================================================================

export const createPurchase: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new purchase (supplier invoice) in Holded. Requires an existing supplier contactId and at least one item. Returns the created purchase with its id.',
  parameters: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: 'Supplier contact ID (required — must be an existing contact)',
      },
      contactName: { type: 'string', description: 'Supplier contact name (optional)' },
      items: {
        type: 'array',
        description: 'Purchase line items (required)',
        items: purchaseItemSchema,
      },
      date: { type: 'string', description: 'Purchase date (ISO 8601, e.g. 2026-01-15)' },
      dueDate: { type: 'string', description: 'Payment due date (ISO 8601)' },
      description: { type: 'string', description: 'Purchase description or title' },
      notes: { type: 'string', description: 'Internal notes' },
      currency: { type: 'string', description: 'Currency code (e.g. EUR, USD)' },
      language: { type: 'string', description: 'Document language code (e.g. es, en)' },
      tags: {
        type: 'array',
        description: 'Tags to assign to the purchase',
        items: { type: 'string' },
      },
      customFields: {
        type: 'array',
        description: 'Custom fields as {field, value} pairs',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Custom field name' },
            value: { type: 'string', description: 'Custom field value' },
          },
        },
      },
      number: { type: 'string', description: 'Custom document number (optional)' },
      warehouseId: { type: 'string', description: 'Warehouse ID for stock movements' },
      discount: { type: 'number', description: 'Global discount percentage (0-100)' },
    },
    required: ['contactId', 'items'],
  },
  handler: async (args, context) => {
    const body = buildPurchaseBody(args);

    if (!body.contact_id) {
      throw new Error('contactId is required to create a purchase.');
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new Error('At least one item is required to create a purchase.');
    }

    const data = (await holdedRequest(context, '/v2/purchases', {
      method: 'POST',
      body,
    })) as HoldedPurchase;

    // Holded returns the created id (sometimes nested under info/data).
    const id = data.id ?? data._id ?? null;
    if (!id) {
      // Surface the raw response so the caller can still find the id.
      return { ...mapPurchaseDetail(data), raw: data };
    }
    return mapPurchaseDetail(data);
  },
};

// =============================================================================
// UPDATE PURCHASE
// =============================================================================

export const updatePurchase: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing purchase in Holded by its ID. All fields are optional.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded purchase ID' },
      contactId: { type: 'string', description: 'Supplier contact ID' },
      contactName: { type: 'string', description: 'Supplier contact name' },
      items: {
        type: 'array',
        description: 'Updated purchase items (replaces existing)',
        items: purchaseItemSchema,
      },
      date: { type: 'string', description: 'Purchase date (ISO 8601)' },
      dueDate: { type: 'string', description: 'Payment due date (ISO 8601)' },
      description: { type: 'string', description: 'Purchase description or title' },
      notes: { type: 'string', description: 'Internal notes' },
      currency: { type: 'string', description: 'Currency code (e.g. EUR, USD)' },
      language: { type: 'string', description: 'Document language code (e.g. es, en)' },
      tags: {
        type: 'array',
        description: 'Tags to assign to the purchase',
        items: { type: 'string' },
      },
      customFields: {
        type: 'array',
        description: 'Custom fields as {field, value} pairs',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Custom field name' },
            value: { type: 'string', description: 'Custom field value' },
          },
        },
      },
      number: { type: 'string', description: 'Custom document number' },
      warehouseId: { type: 'string', description: 'Warehouse ID for stock movements' },
      discount: { type: 'number', description: 'Global discount percentage (0-100)' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, ...rest } = args as { id: string } & Parameters<typeof buildPurchaseBody>[0];

    const body = buildPurchaseBody(rest);

    const data = (await holdedRequest(
      context,
      `/v2/purchases/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedPurchase;

    // PUT responses are often sparse ({id, updated}) — re-read the purchase so
    // the caller gets the full curated shape back.
    const updated = (await holdedRequest(
      context,
      `/v2/purchases/${encodeURIComponent(id)}`,
    )) as HoldedPurchase;

    return mapPurchaseDetail({ ...data, ...updated });
  },
};

// =============================================================================
// DELETE PURCHASE
// =============================================================================

export const deletePurchase: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a purchase from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded purchase ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/purchases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};

// =============================================================================
// ATTACH PURCHASE FILE (multipart/form-data)
// =============================================================================

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/;

/** Decode the tool's file input into bytes + filename + content type. */
function decodeAttachmentInput(args: {
  purchaseId?: string;
  filename?: string;
  contentType?: string;
  dataUrl?: string;
  base64?: string;
}): { data: Uint8Array; filename: string; contentType: string } {
  const { filename, contentType, dataUrl, base64 } = args;

  if (!dataUrl && !base64) {
    throw new Error('Either dataUrl (data:<mime>;base64,<payload>) or base64 is required.');
  }
  if (dataUrl && base64) {
    throw new Error('Pass only one of dataUrl / base64.');
  }

  let bytes: Uint8Array;
  let mime: string | undefined;
  if (dataUrl) {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) {
      throw new Error('dataUrl must be of shape "data:<mime>;base64,<payload>".');
    }
    mime = m[1];
    bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
  } else {
    bytes = new Uint8Array(Buffer.from(base64 as string, 'base64'));
  }

  if (!filename) {
    throw new Error('filename is required (e.g. "invoice.pdf").');
  }

  return {
    data: bytes,
    filename,
    contentType: contentType || mime || 'application/octet-stream',
  };
}

export const attachPurchaseFile: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Attach a file (e.g. the supplier invoice PDF) to a Holded purchase. Uploads real multipart/form-data with the file under the `file` field — max 10 MB. Provide either dataUrl (data:<mime>;base64,<payload>) or a raw base64 string, plus a filename. Returns the attachment info.',
  parameters: {
    type: 'object',
    properties: {
      purchaseId: { type: 'string', description: 'The Holded purchase ID' },
      filename: {
        type: 'string',
        description: "Filename including extension (e.g. 'factura-proveedor.pdf')",
      },
      contentType: {
        type: 'string',
        description: "MIME type (e.g. 'application/pdf'). Defaults from dataUrl or octet-stream.",
      },
      dataUrl: {
        type: 'string',
        description:
          'Data URI scheme — exact format `data:<mime>;base64,<base64Payload>`. Either this or base64 is required.',
      },
      base64: {
        type: 'string',
        description: 'Raw base64-encoded file content. Either this or dataUrl is required.',
      },
    },
    required: ['purchaseId', 'filename'],
  },
  handler: async (args, context) => {
    const { purchaseId } = args as { purchaseId: string };

    const file = decodeAttachmentInput(args as Parameters<typeof decodeAttachmentInput>[0]);

    const data = (await holdedUpload(
      context,
      `/v2/purchases/${encodeURIComponent(purchaseId)}/attachments`,
      file,
    )) as Record<string, unknown>;

    return {
      purchaseId,
      attachmentId: (data.id ?? data._id ?? data.attachmentId) ?? null,
      filename: file.filename,
      contentType: file.contentType,
      size: file.data.byteLength,
      success: true,
      raw: data,
    };
  },
};

// =============================================================================
// LIST PURCHASE ATTACHMENTS
// =============================================================================

export const listPurchaseAttachments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List files attached to a Holded purchase by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded purchase ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/purchases/${encodeURIComponent(id)}/attachments`,
    )) as Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> };

    const rawAttachments = Array.isArray(data) ? data : (data?.items ?? []);

    const attachments = rawAttachments.map((a: Record<string, unknown>) => {
      // Holded returns attachments as {id: "<filename>"} — the id IS the name.
      const explicitName = (a.name ?? a.filename ?? a.file_name) as string | null;
      const id = (a.id ?? a._id) as string | null;
      const name = explicitName ?? (id && id.includes('.') ? id : null);
      return {
        id,
        name,
        contentType: (a.content_type ?? a.contentType ?? a.mime) ?? null,
        size: (a.size ?? a.file_size) ?? null,
        url: (a.url ?? a.download_url) ?? null,
        createdAt: (a.created_at ?? a.createdAt) ?? null,
      };
    });

    return { attachments, count: attachments.length };
  },
};
