/**
 * Fallback Body — Renderer UX Guide v2 §0.
 *
 * Default body rendered when an MCA does not register a custom renderer
 * for a given tool. Composed of `ParamsTable` + an output/error block,
 * picked by status:
 *
 *   pending             → ParamsTable(input)
 *   running             → ParamsTable(input)
 *   completed           → ParamsTable(input) + OutputBlock
 *   failed              → ParamsTable(input) + ErrorBlock
 *
 * …minus the ParamsTable whenever an approval detail is mounted in the same card,
 * which is the one case that leaves nothing at all to draw:
 *
 * The ParamsTable is suppressed while an approval DETAIL is mounted in the same
 * card, because `PermissionDetail` renders `AnnotatedParamsTable` over the same
 * input — ranked, schema-annotated and expandable, i.e. strictly more than this
 * primitive can show. Rendering both stated the same thing twice in two
 * different wordings ("No params" against "This tool will be called with no
 * parameters."). See docs/specs/mca/permission-approval-detail.md.
 *
 * The condition is the detail's PRESENCE, not `status === 'pending_permission'`,
 * because those two come apart for a GROUPED approval: there the HOC passes
 * `detail: null` (the panel owns the whole decision surface), so keying on status
 * suppressed the params table with nothing to replace it — and since a rendered
 * `<FallbackBody/>` element is truthy to `ToolCallCard` whatever it returns,
 * `forceExpand` opened the card onto an empty padded box where dev showed the
 * params. Grouped cards therefore keep the plain table, as before.
 *
 * Returns `null` rather than an empty wrapper when nothing is left to draw, so a
 * card whose body is only this primitive stays a bare header.
 *
 * Reading the permission context is a deliberate exception to this primitive's
 * orthogonality: the de-duplication rule is *about* the detail, so it has to ask
 * whether one is there. It still renders no permission CONTROLS — the Controls Bar
 * is rendered by the `withPermissionSupport` HOC as a sibling below the card, so
 * collapsing this body can never hide the Allow/Deny decision.
 *
 * Output is shown as plain monospaced text in the prototype's `.tc-json` step
 * card (mono 12, radius 10, hairline, 240px scroll). If the tool emits
 * structured JSON, a pretty-printed (compact) variant is used. Never
 * `JsonPreview`, never raw stringify with full nesting (guide §7 DON'T list).
 */

import { Image, ScrollView } from "react-native"
import { YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import type { McaStatusType } from "./colors"
import { ErrorBlock } from "./Containers"
import { formatOutput } from "./formatOutput"
import { ParamsTable } from "./ParamsTable"
import { usePermissionControls } from "./PermissionControlsContext"
import { MCA_STRINGS } from "./strings"
import { useColors } from "./useColors"

export interface FallbackBodyProps {
  status: McaStatusType
  input?: Record<string, unknown> | null
  output?: string
  error?: string
  /** Maximum height for the OutputBlock scroll area. Default 240 px. */
  outputMaxHeight?: number
  /** Attachments from tool execution (images, files, etc.) — rendered inline */
  attachments?: Array<{ url: string; mime: string; filename?: string }>
}

export function FallbackBody({
  status,
  input,
  output,
  error,
  outputMaxHeight = 240,
  attachments,
}: FallbackBodyProps) {
  const imageAttachments = attachments?.filter((a) => a.mime.startsWith("image/")) ?? []
  const hasApprovalDetail = Boolean(usePermissionControls()?.detail)

  // Built as values rather than inline JSX so the "nothing to draw" check below
  // reads the same conditions the render does, instead of restating them.
  const paramsBlock = hasApprovalDetail ? null : (
    <ParamsTable params={input ?? null} emptyHint={MCA_STRINGS.fallback.noParams} />
  )
  const outputBlock =
    status === "completed" && output ? (
      <OutputBlock content={output} maxHeight={outputMaxHeight} />
    ) : null
  const errorBlock = status === "failed" && error ? <ErrorBlock error={error} /> : null
  const imagesBlock =
    status === "completed" && imageAttachments.length > 0 ? (
      <YStack gap={8}>
        {imageAttachments.map((a, i) => (
          <Image
            key={`${a.url}-${i}`}
            source={{ uri: a.url }}
            style={{ width: "100%", height: 200, borderRadius: 10, resizeMode: "contain" }}
          />
        ))}
      </YStack>
    ) : null

  if (!paramsBlock && !outputBlock && !errorBlock && !imagesBlock) return null

  return (
    <YStack gap={10}>
      {paramsBlock}
      {outputBlock}
      {errorBlock}
      {imagesBlock}
    </YStack>
  )
}

function OutputBlock({ content, maxHeight }: { content: string; maxHeight: number }) {
  const c = useColors()
  const display = formatOutput(content)
  return (
    <YStack gap={6}>
      <T step="codenote" tone="text3">
        {MCA_STRINGS.fallback.output}
      </T>
      <ScrollView
        style={{
          maxHeight,
          backgroundColor: c.bgStep,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: c.border,
        }}
        showsVerticalScrollIndicator
        nestedScrollEnabled
      >
        <T
          step="code"
          tone="text2"
          selectable
          style={{ paddingVertical: 10, paddingHorizontal: 12, lineHeight: 18 }}
        >
          {display}
        </T>
      </ScrollView>
    </YStack>
  )
}

// `formatOutput` moved to ./formatOutput.ts so it can be unit-tested
// without dragging react-native / tamagui imports into the test
// runtime — bun:test cannot parse react-native's Flow-only source.
