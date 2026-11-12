/**
 * ChangelogMarkdownRenderer — the changelog surface of the unified markdown
 * renderer (MD-UNIFY v2, step 1). The `external` variant of components/markdown:
 * same DS rules as every surface, external images allowed (changelog content is
 * author-controlled). Public API unchanged: <ChangelogMarkdownRenderer content={...} />.
 */
import { Markdown as UnifiedMarkdown } from "../markdown"

export function ChangelogMarkdownRenderer({ content }: { content: string }) {
  return <UnifiedMarkdown text={content} variant="external" />
}
