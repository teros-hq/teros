/**
 * LexicalComposerInput
 *
 * Drop-in replacement for InlineComposerInput using Lexical (Meta's rich text engine).
 * Fixes all cursor bugs that plagued the contentEditable-based implementation.
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { EditorState } from 'lexical';
import type { MentionChip } from '../../hooks/useAtMention';
import { $createMentionNode, $isMentionNode, MentionNode } from './MentionNode';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; chip: MentionChip };

export interface InlineComposerInputHandle {
  focus(): void;
  getCursorPos(): number;
  getPlainText(): string;
  serialize(): string;
  clear(): void;
  insertChip(chip: MentionChip, queryLength: number): void;
}

interface LexicalComposerInputProps {
  segments: Segment[];
  onChange: (segments: Segment[], plainText: string) => void;
  onMentionTrigger: (text: string, cursorPos: number) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  placeholder?: string;
  disabled?: boolean;
  fontSize?: number;
  color?: string;
  placeholderColor?: string;
  minHeight?: number;
  maxHeight?: number;
  style?: React.CSSProperties;
}

// ── Serializers ───────────────────────────────────────────────────────────────

function editorStateToSegments(editorState: EditorState): Segment[] {
  const segments: Segment[] = [];
  (editorState as any).read(() => {
    const root = $getRoot();
    for (const child of root.getChildren()) {
      const children = (child as any).getChildren?.() ?? [];
      for (const node of children) {
        if ($isMentionNode(node)) {
          segments.push({ kind: 'chip', chip: node.__chip });
        } else if (node.getType() === 'text') {
          const text = node.getTextContent();
          if (text) segments.push({ kind: 'text', text });
        } else if (node.getType() === 'linebreak') {
          segments.push({ kind: 'text', text: '\n' });
        }
      }
    }
  });
  return segments;
}

export function segmentsToPlainText(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : s.chip.resource.name)).join('');
}

export function segmentsToSendString(segments: Segment[]): string {
  return segments
    .map((s) =>
      s.kind === 'text'
        ? s.text
        : `[${s.chip.resource.name}](teros://${s.chip.resource.type}/${s.chip.resource.id})`,
    )
    .join('');
}

// ── Inner plugin ──────────────────────────────────────────────────────────────

interface InnerPluginProps {
  handle: React.MutableRefObject<InlineComposerInputHandle | null>;
  onChange: (segments: Segment[], plainText: string) => void;
  onMentionTrigger: (text: string, cursorPos: number) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}

function InnerPlugin({ handle, onChange, onMentionTrigger, onKeyDown }: InnerPluginProps) {
  const [editor] = useLexicalComposerContext();

  // Keep onChange in a ref to avoid stale closures
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  useLayoutEffect(() => {
    handle.current = {
      focus() {
        editor.focus();
      },
      getCursorPos() {
        let pos = 0;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;
          const anchor = sel.anchor;
          const root = $getRoot();
          let count = 0;
          let done = false;
          for (const para of root.getChildren()) {
            if (done) break;
            const children = (para as any).getChildren?.() ?? [];
            for (const node of children) {
              if (done) break;
              if (node.getKey() === anchor.key) {
                pos = count + anchor.offset;
                done = true;
              } else if ($isMentionNode(node)) {
                count += 1;
              } else {
                count += node.getTextContent().length;
              }
            }
          }
        });
        return pos;
      },
      getPlainText() {
        return editor.getEditorState().read(() => $getRoot().getTextContent());
      },
      serialize() {
        const segs = editorStateToSegments(editor.getEditorState());
        return segmentsToSendString(segs);
      },
      clear() {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const para = $createParagraphNode();
            root.append(para);
            para.select();
          },
          {
            onUpdate: () => {
              onChangeRef.current([], '');
            },
            discrete: true,
          },
        );
      },
      insertChip(chip: MentionChip, queryLength: number) {
        editor.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;

          // Delete @query (queryLength chars + 1 for '@')
          const totalDelete = queryLength + 1;
          for (let i = 0; i < totalDelete; i++) {
            sel.deleteCharacter(true);
          }

          // Insert chip node + trailing space
          const mentionNode = $createMentionNode(chip);
          const spaceNode = $createTextNode(' ');
          sel.insertNodes([mentionNode, spaceNode]);
          spaceNode.selectEnd();
        });
      },
    };
  }, [editor, handle, onChange]);

  // Detect @ trigger on every change
  const handleChange = useCallback(
    (editorState: EditorState) => {
      const segs = editorStateToSegments(editorState);
      const plainText = segmentsToPlainText(segs);
      onChange(segs, plainText);

      // Build text before cursor for mention detection
      (editorState as any).read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;

        const anchor = sel.anchor;
        const root = $getRoot();
        let textBeforeCursor = '';
        let done = false;

        for (const para of root.getChildren()) {
          if (done) break;
          const children = (para as any).getChildren?.() ?? [];
          for (const node of children) {
            if (done) break;
            if (node.getKey() === anchor.key) {
              if (node.getType() === 'text') {
                textBeforeCursor += node.getTextContent().slice(0, anchor.offset);
              }
              done = true;
            } else if ($isMentionNode(node)) {
              textBeforeCursor += '\x01'; // 1 char placeholder for chip
            } else {
              textBeforeCursor += node.getTextContent();
            }
          }
        }

        const cursorPos = textBeforeCursor.length;
        onMentionTrigger(plainText, cursorPos);
      });
    },
    [onChange, onMentionTrigger],
  );

  // Forward keydown to parent
  useEffect(() => {
    if (!onKeyDown) return;
    const removeListener = editor.registerRootListener((rootElement: HTMLElement | null, prevRootElement: HTMLElement | null) => {
      if (prevRootElement) prevRootElement.removeEventListener('keydown', onKeyDown as any);
      if (rootElement) rootElement.addEventListener('keydown', onKeyDown as any);
    });
    return removeListener;
  }, [editor, onKeyDown]);

  return <OnChangePlugin onChange={handleChange} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export const InlineComposerInput = forwardRef<InlineComposerInputHandle, LexicalComposerInputProps>(
  function LexicalComposerInput(
    {
      segments: _segments,
      onChange,
      onMentionTrigger,
      onKeyDown,
      placeholder = 'Type a message...',
      disabled = false,
      fontSize = 15,
      color = '#E4E4E7',
      placeholderColor = '#52525B',
      minHeight = 40,
      maxHeight = 150,
      style,
    },
    ref,
  ) {
    const handleRef = useRef<InlineComposerInputHandle | null>(null);
    useImperativeHandle(ref, () => handleRef.current!, []);

    const [isEmpty, setIsEmpty] = useState(true);

    const handleChange = useCallback(
      (segs: Segment[], plainText: string) => {
        setIsEmpty(
          segs.length === 0 ||
            (segs.length === 1 && segs[0].kind === 'text' && segs[0].text === ''),
        );
        onChange(segs, plainText);
      },
      [onChange],
    );

    const initialConfig = {
      namespace: 'InlineComposer',
      nodes: [MentionNode],
      onError: (error: Error) => console.error('[LexicalComposerInput]', error),
      editable: !disabled,
    };

    return (
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        {/* Placeholder */}
        {isEmpty && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              transform: 'translateY(-50%)',
              left: 8,
              right: 8,
              pointerEvents: 'none',
              color: placeholderColor,
              fontSize,
              fontFamily: "$body",
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              userSelect: 'none',
              lineHeight: '1.4',
            }}
          >
            {placeholder}
          </div>
        )}

        <LexicalComposer initialConfig={initialConfig}>
          <PlainTextPlugin
            contentEditable={React.createElement(ContentEditable as any, {
              style: {
                outline: 'none',
                border: 'none',
                background: 'transparent',
                color,
                fontSize,
                fontFamily: "$body",
                lineHeight: '1.4',
                minHeight,
                maxHeight,
                overflowY: 'auto',
                overflowX: 'hidden',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                padding: '8px',
                boxSizing: 'border-box',
                cursor: disabled ? 'not-allowed' : 'text',
                opacity: disabled ? 0.5 : 1,
                ...style,
              },
            })}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <InnerPlugin
            handle={handleRef}
            onChange={handleChange}
            onMentionTrigger={onMentionTrigger}
            onKeyDown={onKeyDown}
          />
        </LexicalComposer>
      </div>
    );
  },
);
