/**
 * Sancho Renderer — semantic recall (`recall`).
 *
 * Ranked passages — search-results style: quote of the passage, docPath as
 * the source, score when the server sends one. Never whole documents.
 */

import { Search } from '../../primitives';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  formatCountBadge,
  ErrorBlock,
  IconChip,
  IconTile,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  narrowObject,
  parseSanchoOutput,
  pickArray,
  pickText,
  SanchoToolShell,
  truncate,
  useScrollStyle,
} from './shared';

interface PassageShape {
  quote?: string;
  text?: string;
  passage?: string;
  docPath?: string;
  path?: string;
  score?: number;
}

const MAX_PASSAGES = 12;

function passageBody(p: unknown): string {
  const o = narrowObject<Record<string, unknown>>(p);
  if (!o) return typeof p === 'string' ? p : '';
  return pickText(o, ['quote', 'text', 'passage', 'content', 'snippet']) ?? '';
}

function passageSource(p: unknown): string | null {
  const o = narrowObject<Record<string, unknown>>(p);
  if (!o) return null;
  return pickText(o, ['docPath', 'path', 'source', 'doc']);
}

function passageScore(p: unknown): number | null {
  const o = narrowObject<Record<string, unknown>>(p);
  if (!o) return null;
  const raw = o.score;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

export function RecallRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(340);
  const parsed = parseSanchoOutput<unknown>(output);
  const o = narrowObject<Record<string, unknown>>(parsed);
  const passages = pickArray(o, ['passages', 'results', 'items', 'recall']) as PassageShape[];
  const query = typeof input?.query === 'string' ? input.query : undefined;

  const description = query ? `Recall · "${truncate(query, 36)}"` : 'Recall';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
      badge={
        status === 'completed' ? (
          <Badge
            text={formatCountBadge(passages.length, 'passage')}
            variant={countBadgeVariant(passages.length)}
          />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
          <YStack gap={6}>
            {passages.length === 0 && (
              <Text color={c.text2} fontSize={10}>
                No passages matched the query.
              </Text>
            )}
            {passages.slice(0, MAX_PASSAGES).map((p, i) => {
              const body = passageBody(p);
              const source = passageSource(p);
              const score = passageScore(p);
              return (
                <YStack
                  // biome-ignore lint/suspicious/noArrayIndexKey: ranked list
                  key={`${source ?? 'passage'}-${i}`}
                  gap={4}
                  padding={8}
                  borderRadius={5}
                  backgroundColor={c.wash}
                  borderWidth={1}
                  borderColor={c.border}
                >
                  <Text color={c.text} fontSize={10} lineHeight={15}>
                    {body ? truncate(body, 320) : '(empty passage)'}
                  </Text>
                  <XStack gap={6} alignItems="center" flexWrap="wrap">
                    <IconTile icon={<Search size={10} color={c.accent} />} size={16} />
                    {source && (
                      <Text color={c.text3} fontSize={9} fontFamily="$mono" numberOfLines={1}>
                        {source}
                      </Text>
                    )}
                    {score != null && <IconChip text={score.toFixed(2)} accent={c.accent} />}
                  </XStack>
                </YStack>
              );
            })}
            {passages.length > MAX_PASSAGES && (
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                +{passages.length - MAX_PASSAGES} more passages
              </Text>
            )}
          </YStack>
        </ScrollView>
      )}
    </SanchoToolShell>
  );
}
