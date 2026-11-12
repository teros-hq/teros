import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw product shape returned by the Holded API */
interface HoldedProduct {
  id?: string;
  _id?: string;
  name?: string;
  sku?: string;
  description?: string;
  price?: number;
  cost_price?: number;
  stock?: number;
  category?: string;
  type?: string;
  unit_type?: string;
  tax?: number;
  taxes?: unknown[];
  created_at?: string;
  updated_at?: string;
}

/** Curated product output returned by our tools */
interface CuratedProduct {
  id: string | null;
  name: string | null;
  sku: string | null;
  description: string | null;
  price: number | null;
  costPrice: number | null;
  stock: number | null;
  category: string | null;
  type: string | null;
  unitType: string | null;
  tax: number | null;
  taxes: unknown[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapProduct(p: HoldedProduct): CuratedProduct {
  return {
    id: p.id ?? p._id ?? null,
    name: p.name ?? null,
    sku: p.sku ?? null,
    description: p.description ?? null,
    price: p.price ?? null,
    costPrice: p.cost_price ?? null,
    stock: p.stock ?? null,
    category: p.category ?? null,
    type: p.type ?? null,
    unitType: p.unit_type ?? null,
    tax: p.tax ?? null,
    taxes: p.taxes ?? null,
    createdAt: p.created_at ?? null,
    updatedAt: p.updated_at ?? null,
  };
}

// =============================================================================
// LIST PRODUCTS
// =============================================================================

export const listProducts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List products from Holded. Returns a curated list of products with id, name, SKU, price, cost price, stock, category, type, and tax info. Supports pagination via page and limit.',
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
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as {
      page?: number;
      limit?: number;
    };

    const params: Record<string, string | number> = { page, limit };

    const data = (await holdedRequest(context, '/v2/products', {
      params,
    })) as HoldedProduct[] | { items?: HoldedProduct[]; has_more?: boolean; cursor?: string };

    const rawProducts = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const products = rawProducts.map(mapProduct);

    return {
      products,
      count: products.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET PRODUCT
// =============================================================================

export const getProduct: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single product from Holded by its ID. Returns full product details including price, cost price, stock, category, type, unit type, and tax info.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded product ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/products/${encodeURIComponent(id)}`,
    )) as HoldedProduct;

    return mapProduct(data);
  },
};

// =============================================================================
// CREATE PRODUCT
// =============================================================================

export const createProduct: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new product in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Product name',
      },
      sku: {
        type: 'string',
        description: 'Product SKU (stock keeping unit)',
      },
      description: {
        type: 'string',
        description: 'Product description',
      },
      price: {
        type: 'number',
        description: 'Selling price',
      },
      cost_price: {
        type: 'number',
        description: 'Cost price',
      },
      category: {
        type: 'string',
        description: 'Product category',
      },
      type: {
        type: 'string',
        description: 'Product type: "product" or "service"',
        enum: ['product', 'service'],
      },
      unit_type: {
        type: 'string',
        description: 'Unit of measure (e.g. pcs, kg, hours)',
      },
      tax: {
        type: 'number',
        description: 'Tax rate percentage',
      },
      stock: {
        type: 'number',
        description: 'Initial stock quantity',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const {
      name,
      sku,
      description,
      price,
      cost_price,
      category,
      type,
      unit_type,
      tax,
      stock,
    } = args as {
      name: string;
      sku?: string;
      description?: string;
      price?: number;
      cost_price?: number;
      category?: string;
      type?: string;
      unit_type?: string;
      tax?: number;
      stock?: number;
    };

    const body: Record<string, unknown> = { name };
    if (sku) body.sku = sku;
    if (description) body.description = description;
    if (price !== undefined) body.price = price;
    if (cost_price !== undefined) body.cost_price = cost_price;
    if (category) body.category = category;
    if (type) body.type = type;
    if (unit_type) body.unit_type = unit_type;
    if (tax !== undefined) body.tax = tax;
    if (stock !== undefined) body.stock = stock;

    const data = (await holdedRequest(context, '/v2/products', {
      method: 'POST',
      body,
    })) as HoldedProduct;

    return mapProduct(data);
  },
};

// =============================================================================
// UPDATE PRODUCT
// =============================================================================

export const updateProduct: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing product in Holded by its ID. All fields are optional.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded product ID',
      },
      name: {
        type: 'string',
        description: 'Product name',
      },
      sku: {
        type: 'string',
        description: 'Product SKU',
      },
      description: {
        type: 'string',
        description: 'Product description',
      },
      price: {
        type: 'number',
        description: 'Selling price',
      },
      cost_price: {
        type: 'number',
        description: 'Cost price',
      },
      category: {
        type: 'string',
        description: 'Product category',
      },
      type: {
        type: 'string',
        description: 'Product type: "product" or "service"',
        enum: ['product', 'service'],
      },
      unit_type: {
        type: 'string',
        description: 'Unit of measure',
      },
      tax: {
        type: 'number',
        description: 'Tax rate percentage',
      },
      stock: {
        type: 'number',
        description: 'Stock quantity',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const {
      id,
      name,
      sku,
      description,
      price,
      cost_price,
      category,
      type,
      unit_type,
      tax,
      stock,
    } = args as {
      id: string;
      name?: string;
      sku?: string;
      description?: string;
      price?: number;
      cost_price?: number;
      category?: string;
      type?: string;
      unit_type?: string;
      tax?: number;
      stock?: number;
    };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (sku) body.sku = sku;
    if (description) body.description = description;
    if (price !== undefined) body.price = price;
    if (cost_price !== undefined) body.cost_price = cost_price;
    if (category) body.category = category;
    if (type) body.type = type;
    if (unit_type) body.unit_type = unit_type;
    if (tax !== undefined) body.tax = tax;
    if (stock !== undefined) body.stock = stock;

    const data = (await holdedRequest(
      context,
      `/v2/products/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedProduct;

    return mapProduct(data);
  },
};

// =============================================================================
// DELETE PRODUCT
// =============================================================================

export const deleteProduct: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a product from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded product ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/products/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};
