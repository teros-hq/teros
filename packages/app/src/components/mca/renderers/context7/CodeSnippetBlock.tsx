/**
 * CodeSnippetBlock — render de un único snippet de docs Context7.
 *
 * Header (title + lang badge + source link + descripción) + cuerpo de código
 * via `<CodeBlock>` global (syntax highlighting vs2015, scroll vertical y
 * horizontal anidados, detección automática de lenguaje cross-platform).
 *
 * Vive en `renderers/context7/` (no en `primitives/`) porque hoy solo lo
 * consume `mca.context7`. Se promueve a primitivo global cuando un segundo
 * MCA de docs (Brave Docs, GitHub Docs, etc.) lo necesite con la misma
 * shape `{ title, source, description, code?, language? }`.
 */

import { ExternalLink } from '../../primitives';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';

import { CodeBlock } from '../../CodeBlock';
import { Badge, truncate, useColors } from '../../primitives';
import type { DocSnippet } from './shared';

const CODE_BLOCK_MAX_HEIGHT = 240;
const DESCRIPTION_TRUNCATE = 280;

export function CodeSnippetBlock({ snippet }: { snippet: DocSnippet }): React.ReactNode {
  const c = useColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <YStack padding={8} gap={4}>
        <XStack alignItems="center" gap={6}>
          <Text color={c.text} fontSize={11} fontWeight="600" flex={1} numberOfLines={1}>
            {snippet.title}
          </Text>
          {snippet.language && <Badge text={snippet.language} variant="info" />}
        </XStack>
        {snippet.source && (
          <XStack alignItems="center" gap={4}>
            <ExternalLink size={9} color={c.text3} />
            <Text color={c.text3} fontSize={9} fontFamily="$mono" numberOfLines={1} flex={1}>
              {snippet.source}
            </Text>
          </XStack>
        )}
        {snippet.description && (
          <Text color={c.text2} fontSize={10} lineHeight={14}>
            {truncate(snippet.description, DESCRIPTION_TRUNCATE)}
          </Text>
        )}
      </YStack>
      {snippet.code && (
        <CodeBlock
          code={snippet.code}
          language={snippet.language}
          maxHeight={CODE_BLOCK_MAX_HEIGHT}
        />
      )}
    </YStack>
  );
}
