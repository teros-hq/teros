/**
 * Curated shape builders for Canva API responses.
 *
 * Convert snake_case Canva fields to camelCase Teros shapes. Always keep
 * visual fields (thumbnail URL/dimensions) so the renderer can paint
 * polaroid previews without a second request.
 */

// ============================================================================
// DESIGNS
// ============================================================================

export interface CanvaDesignShape {
  id: string | null;
  title: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  editUrl: string | null;
  viewUrl: string | null;
  pageCount: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildDesignShape(raw: any): CanvaDesignShape {
  const r = raw?.design ?? raw ?? {};
  return {
    id: r.id ?? null,
    title: r.title ?? null,
    ownerUserId: r.owner?.user_id ?? null,
    ownerTeamId: r.owner?.team_id ?? null,
    thumbnailUrl: r.thumbnail?.url ?? null,
    thumbnailWidth: r.thumbnail?.width ?? null,
    thumbnailHeight: r.thumbnail?.height ?? null,
    editUrl: r.urls?.edit_url ?? null,
    viewUrl: r.urls?.view_url ?? null,
    pageCount: r.page_count ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// ============================================================================
// FOLDERS
// ============================================================================

export interface CanvaFolderShape {
  id: string | null;
  name: string | null;
  thumbnailUrl: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildFolderShape(raw: any): CanvaFolderShape {
  const r = raw?.folder ?? raw ?? {};
  return {
    id: r.id ?? null,
    name: r.name ?? null,
    thumbnailUrl: r.thumbnail?.url ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

export interface CanvaFolderItemShape {
  type: string | null;
  id: string | null;
  name: string | null;
  thumbnailUrl: string | null;
  pinStatus: string | null;
}

export function buildFolderItemShape(raw: any): CanvaFolderItemShape {
  const r = raw ?? {};
  const inner = r.design ?? r.folder ?? r.image ?? r.video ?? {};
  return {
    type: r.type ?? null,
    id: inner.id ?? null,
    name: inner.title ?? inner.name ?? null,
    thumbnailUrl: inner.thumbnail?.url ?? null,
    pinStatus: r.pin_status ?? null,
  };
}

// ============================================================================
// ASSETS
// ============================================================================

export interface CanvaAssetShape {
  id: string | null;
  name: string | null;
  type: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildAssetShape(raw: any): CanvaAssetShape {
  const r = raw?.asset ?? raw ?? {};
  return {
    id: r.id ?? null,
    name: r.name ?? null,
    type: r.type ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    thumbnailUrl: r.thumbnail?.url ?? null,
    thumbnailWidth: r.thumbnail?.width ?? null,
    thumbnailHeight: r.thumbnail?.height ?? null,
    metadata: r.metadata ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// ============================================================================
// BRAND TEMPLATES
// ============================================================================

export interface CanvaBrandTemplateShape {
  id: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  viewUrl: string | null;
  createUrl: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildBrandTemplateShape(raw: any): CanvaBrandTemplateShape {
  const r = raw?.brand_template ?? raw ?? {};
  return {
    id: r.id ?? null,
    title: r.title ?? null,
    thumbnailUrl: r.thumbnail?.url ?? null,
    viewUrl: r.view_url ?? null,
    createUrl: r.create_url ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// ============================================================================
// JOBS — export, import, autofill, resize, asset upload
// ============================================================================

export type JobStatus = 'in_progress' | 'success' | 'failed' | string;

export interface CanvaJobShape<TResult = unknown> {
  id: string | null;
  status: JobStatus | null;
  error: { code: string | null; message: string | null } | null;
  result: TResult | null;
}

function extractError(r: any): CanvaJobShape['error'] {
  if (!r?.error) return null;
  return { code: r.error.code ?? null, message: r.error.message ?? null };
}

export function buildExportJobShape(raw: any): CanvaJobShape<{ urls: string[] }> {
  const r = raw?.job ?? raw ?? {};
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    error: extractError(r),
    result: Array.isArray(r.urls) ? { urls: r.urls } : null,
  };
}

export function buildImportJobShape(raw: any): CanvaJobShape<{ designId: string | null }> {
  const r = raw?.job ?? raw ?? {};
  const designs = r.result?.designs;
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    error: extractError(r),
    result: Array.isArray(designs) && designs[0] ? { designId: designs[0].id ?? null } : null,
  };
}

export function buildAutofillJobShape(raw: any): CanvaJobShape<CanvaDesignShape> {
  const r = raw?.job ?? raw ?? {};
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    error: extractError(r),
    result: r.result?.design ? buildDesignShape(r.result.design) : null,
  };
}

export function buildResizeJobShape(raw: any): CanvaJobShape<CanvaDesignShape> {
  const r = raw?.job ?? raw ?? {};
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    error: extractError(r),
    result: r.result?.design ? buildDesignShape(r.result.design) : null,
  };
}

export function buildAssetUploadJobShape(raw: any): CanvaJobShape<CanvaAssetShape> {
  const r = raw?.job ?? raw ?? {};
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    error: extractError(r),
    result: r.asset ? buildAssetShape(r.asset) : null,
  };
}

// ============================================================================
// COMMENTS — threads + replies
// ============================================================================

export interface CanvaThreadShape {
  id: string | null;
  designId: string | null;
  authorUserId: string | null;
  messagePlaintext: string | null;
  resolved: boolean | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildThreadShape(raw: any): CanvaThreadShape {
  const r = raw?.thread ?? raw ?? {};
  return {
    id: r.id ?? null,
    designId: r.design_id ?? null,
    authorUserId: r.author?.user_id ?? null,
    messagePlaintext: r.content?.plaintext ?? r.message_plaintext ?? null,
    resolved: typeof r.resolved === 'boolean' ? r.resolved : null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

export interface CanvaReplyShape {
  id: string | null;
  threadId: string | null;
  authorUserId: string | null;
  messagePlaintext: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function buildReplyShape(raw: any): CanvaReplyShape {
  const r = raw?.reply ?? raw ?? {};
  return {
    id: r.id ?? null,
    threadId: r.thread_id ?? null,
    authorUserId: r.author?.user_id ?? null,
    messagePlaintext: r.content?.plaintext ?? r.message_plaintext ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// ============================================================================
// USERS
// ============================================================================

export interface CanvaUserShape {
  userId: string | null;
  teamId: string | null;
}

export function buildUserShape(raw: any): CanvaUserShape {
  return {
    userId: raw?.team_user?.user_id ?? raw?.user_id ?? null,
    teamId: raw?.team_user?.team_id ?? raw?.team_id ?? null,
  };
}

export interface CanvaUserProfileShape {
  displayName: string | null;
}

export function buildUserProfileShape(raw: any): CanvaUserProfileShape {
  return {
    displayName: raw?.profile?.display_name ?? null,
  };
}

export interface CanvaUserCapabilitiesShape {
  capabilities: string[];
}

export function buildUserCapabilitiesShape(raw: any): CanvaUserCapabilitiesShape {
  return {
    capabilities: Array.isArray(raw?.capabilities) ? raw.capabilities : [],
  };
}

// ============================================================================
// DESIGN PAGES + EXPORT FORMATS
// ============================================================================

export interface CanvaDesignPageShape {
  index: number | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface CanvaDesignPagesShape {
  pages: CanvaDesignPageShape[];
}

export function buildDesignPagesShape(raw: any): CanvaDesignPagesShape {
  const items = Array.isArray(raw?.pages) ? raw.pages : [];
  return {
    pages: items.map((p: any, idx: number) => ({
      index: p.index ?? idx,
      thumbnailUrl: p.thumbnail?.url ?? null,
      width: p.thumbnail?.width ?? null,
      height: p.thumbnail?.height ?? null,
    })),
  };
}

export interface CanvaExportFormatsShape {
  formats: string[];
}

export function buildExportFormatsShape(raw: any): CanvaExportFormatsShape {
  const f = raw?.formats;
  if (!f) return { formats: [] };
  return { formats: Object.keys(f).filter((k) => f[k]) };
}
