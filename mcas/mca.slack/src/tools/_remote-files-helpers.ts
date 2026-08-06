import { tsToIso } from "./_helpers"

export interface CuratedRemoteFile {
  id: string
  externalId: string | null
  externalUrl: string | null
  title: string
  fileType: string | null
  size: number | null
  user: string | null
  createdAt: string | null
  permalink: string | null
  channels: string[]
}

export function extractRemoteFile(raw: any): CuratedRemoteFile {
  return {
    id: raw?.id ?? "",
    externalId: raw?.external_id ?? null,
    externalUrl: raw?.external_url ?? null,
    title: raw?.title ?? raw?.name ?? "",
    fileType: raw?.filetype ?? null,
    size: typeof raw?.size === "number" ? raw.size : null,
    user: raw?.user ?? null,
    createdAt: tsToIso(raw?.created),
    permalink: raw?.permalink ?? null,
    channels: Array.isArray(raw?.channels) ? raw.channels : [],
  }
}
