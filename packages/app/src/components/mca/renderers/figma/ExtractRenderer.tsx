/**
 * Figma Renderer — extract-colors, extract-typography.
 *
 * Both return `{ count, output: string, format }` where `output` is a
 * formatted string (CSS / Tailwind config / JSON). Render JSON via
 * `CodeBlock` with `language="json"`; CSS / Tailwind via `MarkdownContent`
 * with a fenced code block so the chat's syntax highlighter kicks in.
 */

import { useTranslation } from "react-i18next"
import { MarkdownContent } from "../../../chat/bubbles/MarkdownContent"
import { CodeBlock } from "../../CodeBlock"
import { Empty, ErrorBlock, IconChip, parseOutput } from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { FIGMA_PALETTE, type FigmaExtractResult, FigmaToolShell } from "./shared"

function ExtractBody({ result }: { result: FigmaExtractResult }) {
  const { t } = useTranslation()
  if (!result.output) return <Empty message={t('mca.figma.noOutput')} />
  const fmt = result.format?.toLowerCase() ?? "css"

  if (fmt === "json") {
    return <CodeBlock code={result.output} language="json" maxHeight={320} />
  }
  if (fmt === "css") {
    const fenced = `\`\`\`css\n${result.output}\n\`\`\``
    return <MarkdownContent text={fenced} />
  }
  if (fmt === "tailwind") {
    const fenced = `\`\`\`js\n${result.output}\n\`\`\``
    return <MarkdownContent text={fenced} />
  }
  return <CodeBlock code={result.output} maxHeight={320} />
}

// ============================================================================
// extract-colors
// ============================================================================

export function ExtractColorsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
  input,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output
    ? (parseOutput<FigmaExtractResult>(output) as FigmaExtractResult | null)
    : null
  const fmt = (input?.format as string | undefined) ?? parsed?.format ?? "css"

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      badge={
        parsed ? <IconChip text={`${parsed.count} colors`} accent={FIGMA_PALETTE.red} /> : undefined
      }
      description={`Extract colors (${fmt})`}
    >
      {error && <ErrorBlock error={error} />}
      {!error && parsed && <ExtractBody result={{ ...parsed, format: parsed.format ?? fmt }} />}
    </FigmaToolShell>
  )
}

// ============================================================================
// extract-typography
// ============================================================================

export function ExtractTypographyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
  input,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output
    ? (parseOutput<FigmaExtractResult>(output) as FigmaExtractResult | null)
    : null
  const fmt = (input?.format as string | undefined) ?? parsed?.format ?? "css"

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      badge={
        parsed ? (
          <IconChip text={`${parsed.count} styles`} accent={FIGMA_PALETTE.blue} />
        ) : undefined
      }
      description={`Extract typography (${fmt})`}
    >
      {error && <ErrorBlock error={error} />}
      {!error && parsed && <ExtractBody result={{ ...parsed, format: parsed.format ?? fmt }} />}
    </FigmaToolShell>
  )
}
