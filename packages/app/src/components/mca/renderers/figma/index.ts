/**
 * Figma renderer — barrel exports.
 *
 * One sub-renderer per cohesive Figma domain (file/components/styles/comments/
 * versions/export/extract). The dispatcher in `../FigmaRenderer.tsx` maps
 * each tool short-name to its sub-renderer.
 */

export {
  CreateCommentRenderer,
  DeleteCommentRenderer,
  GetCommentsRenderer,
} from "./CommentsRenderer"
export {
  GetComponentSetsRenderer,
  GetComponentsRenderer,
} from "./ComponentsRenderer"
export { ExportImagesRenderer } from "./ExportImagesRenderer"
export { ExtractColorsRenderer, ExtractTypographyRenderer } from "./ExtractRenderer"
export { GetFileRenderer, GetNodeRenderer } from "./FileRenderer"
export { HealthCheckRenderer } from "./HealthCheckRenderer"
export { GetFileStylesRenderer, GetFileVariablesRenderer } from "./StylesRenderer"
export * from "./shared"
export { ListFileVersionsRenderer } from "./VersionsRenderer"
