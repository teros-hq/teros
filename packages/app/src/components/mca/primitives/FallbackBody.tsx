/**
 * Fallback Body — Renderer UX Guide v2 §0.
 *
 * Default body rendered when an MCA does not register a custom renderer
 * for a given tool. Composed of `ParamsTable` + an output/error block,
 * picked by status:
 *
 *   pending             → ParamsTable(input)
 *   running             → ParamsTable(input)
 *   pending_permission  → ParamsTable(input)         (ControlsBar lives outside)
 *   completed           → ParamsTable(input) + OutputBlock
 *   failed              → ParamsTable(input) + ErrorBlock
 *
 * The Controls Bar for `pending_permission` is intentionally NOT rendered
 * here — it is injected by `withPermissionSupport` HOC (Fase 4), so this
 * primitive stays orthogonal to the permission flow.
 *
 * Output is shown as plain monospaced text. If the tool emits structured
 * JSON, a pretty-printed (compact) variant is used. Never `JsonPreview`,
 * never raw stringify with full nesting (guide §7 DON'T list).
 */

import { Image, ScrollView } from 'react-native';
import { Text, YStack } from 'tamagui';
import type { McaStatusType } from './colors';
import { ErrorBlock } from './Containers';
import { formatOutput } from './formatOutput';
import { ParamsTable } from './ParamsTable';
import { MCA_STRINGS } from './strings';
import { useColors } from './useColors';

export interface FallbackBodyProps {
  status: McaStatusType;
  input?: Record<string, unknown> | null;
  output?: string;
  error?: string;
  /** Maximum height for the OutputBlock scroll area. Default 220 px. */
  outputMaxHeight?: number;
  /** Attachments from tool execution (images, files, etc.) — rendered inline */
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
}

export function FallbackBody({
  status,
  input,
  output,
  error,
  outputMaxHeight = 220,
  attachments,
}: FallbackBodyProps) {
  const imageAttachments = attachments?.filter((a) => a.mime.startsWith('image/')) ?? [];

  return (
    <YStack gap={8} padding={2}>
      <ParamsTable params={input ?? null} emptyHint={MCA_STRINGS.fallback.noParams} />
      {status === 'completed' && output ? (
        <OutputBlock content={output} maxHeight={outputMaxHeight} />
      ) : null}
      {status === 'failed' && error ? <ErrorBlock error={error} /> : null}
      {status === 'completed' && imageAttachments.length > 0 ? (
        <YStack gap={6}>
          {imageAttachments.map((a, i) => (
            <Image
              key={`${a.url}-${i}`}
              source={{ uri: a.url }}
              style={{ width: '100%', height: 200, borderRadius: 6, resizeMode: 'contain' }}
            />
          ))}
        </YStack>
      ) : null}
    </YStack>
  );
}

function OutputBlock({ content, maxHeight }: { content: string; maxHeight: number }) {
  const c = useColors();
  const display = formatOutput(content);
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <Text
        color={c.text3}
        fontSize={9}
        fontFamily="$mono"
        textTransform="uppercase"
        letterSpacing={0.4}
        paddingHorizontal={12}
        paddingTop={8}
        paddingBottom={4}
      >
        {MCA_STRINGS.fallback.output}
      </Text>
      <ScrollView style={{ maxHeight }} showsVerticalScrollIndicator>
        <Text
          color={c.text2}
          fontSize={10}
          fontFamily="$mono"
          paddingHorizontal={12}
          paddingBottom={10}
        >
          {display}
        </Text>
      </ScrollView>
    </YStack>
  );
}

// `formatOutput` moved to ./formatOutput.ts so it can be unit-tested
// without dragging react-native / tamagui imports into the test
// runtime — bun:test cannot parse react-native's Flow-only source.
