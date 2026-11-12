import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw warehouse shape returned by the Holded API */
interface HoldedWarehouse {
  id?: string;
  _id?: string;
  name?: string;
  address?: string;
  city?: string;
  zip?: string;
  postal_code?: string;
  country?: string;
  is_default?: boolean;
  default?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Curated warehouse output */
interface CuratedWarehouse {
  id: string | null;
  name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  isDefault: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Raw warehouse stock item shape */
interface HoldedWarehouseStockItem {
  product_id?: string;
  productId?: string;
  product_name?: string;
  productName?: string;
  sku?: string;
  stock?: number;
  min_stock?: number;
  minStock?: number;
}

/** Curated warehouse stock item output */
interface CuratedWarehouseStockItem {
  productId: string | null;
  productName: string | null;
  sku: string | null;
  stock: number | null;
  minStock: number | null;
}

/** Raw price list shape returned by the Holded API */
interface HoldedPriceList {
  id?: string;
  _id?: string;
  name?: string;
  description?: string;
  currency?: string;
  is_default?: boolean;
  default?: boolean;
  prices?: unknown[];
  items?: unknown[];
  created_at?: string;
  updated_at?: string;
}

/** Curated price list output */
interface CuratedPriceList {
  id: string | null;
  name: string | null;
  description: string | null;
  currency: string | null;
  isDefault: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Curated price list detail (for get-price-list) */
interface CuratedPriceListDetail extends CuratedPriceList {
  prices: unknown | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapWarehouse(w: HoldedWarehouse): CuratedWarehouse {
  return {
    id: w.id ?? w._id ?? null,
    name: w.name ?? null,
    address: w.address ?? null,
    city: w.city ?? null,
    zip: w.zip ?? w.postal_code ?? null,
    country: w.country ?? null,
    isDefault: w.is_default ?? w.default ?? null,
    createdAt: w.created_at ?? null,
    updatedAt: w.updated_at ?? null,
  };
}

function mapWarehouseStockItem(item: HoldedWarehouseStockItem): CuratedWarehouseStockItem {
  return {
    productId: item.product_id ?? item.productId ?? null,
    productName: item.product_name ?? item.productName ?? null,
    sku: item.sku ?? null,
    stock: item.stock ?? null,
    minStock: item.min_stock ?? item.minStock ?? null,
  };
}

function mapPriceList(pl: HoldedPriceList): CuratedPriceList {
  return {
    id: pl.id ?? pl._id ?? null,
    name: pl.name ?? null,
    description: pl.description ?? null,
    currency: pl.currency ?? null,
    isDefault: pl.is_default ?? pl.default ?? null,
    createdAt: pl.created_at ?? null,
    updatedAt: pl.updated_at ?? null,
  };
}

function mapPriceListDetail(pl: HoldedPriceList): CuratedPriceListDetail {
  return {
    ...mapPriceList(pl),
    prices: pl.prices ?? pl.items ?? null,
  };
}

// =============================================================================
// LIST WAREHOUSES
// =============================================================================

export const listWarehouses: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List warehouses from Holded. Warehouses are storage locations for product inventory. Supports pagination via page and limit.',
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
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };

    const data = (await holdedRequest(context, '/v2/warehouses', {
      params: { page, limit },
    })) as HoldedWarehouse[] | { items?: HoldedWarehouse[]; has_more?: boolean; cursor?: string };

    const rawWarehouses = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const warehouses = rawWarehouses.map(mapWarehouse);

    return {
      warehouses,
      count: warehouses.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET WAREHOUSE
// =============================================================================

export const getWarehouse: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single warehouse from Holded by its ID. Returns warehouse details including name, address, and default status.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded warehouse ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/warehouses/${encodeURIComponent(id)}`,
    )) as HoldedWarehouse;

    return mapWarehouse(data);
  },
};

// =============================================================================
// GET WAREHOUSE STOCK
// =============================================================================

export const getWarehouseStock: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get stock levels for a specific warehouse in Holded. Returns a list of products with their stock quantities in that warehouse.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded warehouse ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/warehouses/${encodeURIComponent(id)}/stock`,
    )) as HoldedWarehouseStockItem[] | { items?: HoldedWarehouseStockItem[] };

    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const stock = rawItems.map(mapWarehouseStockItem);

    return {
      warehouseId: id,
      stock,
      count: stock.length,
    };
  },
};

// =============================================================================
// LIST PRICE LISTS
// =============================================================================

export const listPriceLists: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List price lists from Holded. Price lists define custom pricing tiers for different customer segments. Supports pagination via page and limit.',
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
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };

    const data = (await holdedRequest(context, '/v2/price-lists', {
      params: { page, limit },
    })) as HoldedPriceList[] | { items?: HoldedPriceList[]; has_more?: boolean; cursor?: string };

    const rawLists = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const priceLists = rawLists.map(mapPriceList);

    return {
      priceLists,
      count: priceLists.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET PRICE LIST
// =============================================================================

export const getPriceList: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single price list from Holded by its ID, including the full list of product prices.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded price list ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/price-lists/${encodeURIComponent(id)}`,
    )) as HoldedPriceList;

    return mapPriceListDetail(data);
  },
};
