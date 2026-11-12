export { createGraphClient, buildGraphError, type GraphRequestOptions } from './graph-client'
export {
  assertDisplayName,
  buildMultipartPage,
  buildPageHtml,
  escapeHtml,
  escapeODataLiteral,
  formatNotebook,
  formatPage,
  formatSection,
  formatSectionGroup,
  type GraphRequestFn,
  htmlToMarkdown,
  type IdRef,
  markdownToHtmlFragment,
  type OneNoteOperation,
  optionalId,
  PAGE_EXPAND,
  pollOperation,
  requireId,
  SECTION_EXPAND,
  SECTION_GROUP_EXPAND,
} from './helpers'
export type { GraphSecrets, GraphError } from './types'
