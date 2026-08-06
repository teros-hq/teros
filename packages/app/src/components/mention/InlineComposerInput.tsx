/**
 * InlineComposerInput
 *
 * A contentEditable-based rich text input that renders @mention chips inline
 * within the text flow — like Slack or Notion. Replaces the plain textarea/Input
 * in InputComposer.web.tsx.
 *
 * Architecture
 * ────────────
 * The editor is a `div[contentEditable]`. Its children are a mix of:
 *   • Text nodes  → plain text typed by the user
 *   • <span data-chip-id="..."> → non-editable chip elements
 *
 * We never let React control the DOM directly (that would fight contentEditable).
 * Instead we use an imperative approach:
 *   1. On mount / when `segments` change externally → we rebuild the DOM.
 *   2. On user input (onInput) → we parse the DOM back into segments and call
 *      onChange so the parent can update state.
 *
 * Serialisation (for send)
 * ────────────────────────
 * Walk DOM nodes in order:
 *   • Text node → append raw text
 *   • Chip node → append `[name](teros://type/id)`
 *
 * Cursor management
 * ─────────────────
 * We save/restore the cursor using a character-offset bookmark so that DOM
 * rebuilds (e.g. when a chip is inserted) don't lose the caret position.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import type { MentionChip } from '../../hooks/useAtMention';
import { MentionChip as MentionChipComponent } from './MentionChip';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; chip: MentionChip };

export interface InlineComposerInputHandle {
  /** Focus the editor */
  focus(): void;
  /** Get current cursor position (char offset, chips count as 1) */
  getCursorPos(): number;
  /** Get the plain text representation (chips as their name) */
  getPlainText(): string;
  /** Serialize to send format: text + [name](teros://type/id) */
  serialize(): string;
  /** Clear all content */
  clear(): void;
  /** Insert a chip at the current cursor position, replacing @query */
  insertChip(chip: MentionChip, queryLength: number): void;
}

interface InlineComposerInputProps {
  segments: Segment[];
  onChange: (segments: Segment[], plainText: string) => void;
  onMentionTrigger: (query: string, cursorPos: number) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Tamagui-compatible font size class — we'll map it to px */
  fontSize?: number;
  color?: string;
  placeholderColor?: string;
  minHeight?: number;
  maxHeight?: number;
  style?: React.CSSProperties;
}

// ── Chip DOM attribute ────────────────────────────────────────────────────────

const CHIP_ATTR = 'data-mention-chip';
const CHIP_ID_ATTR = 'data-chip-id';

// ── Cursor bookmark helpers ───────────────────────────────────────────────────

interface Bookmark {
  /** Character offset counting text chars + 1 per chip */
  offset: number;
}

function getBookmark(container: HTMLElement): Bookmark {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { offset: 0 };
  const range = sel.getRangeAt(0);
  return { offset: countOffset(container, range.startContainer, range.startOffset) };
}

function countOffset(container: HTMLElement, targetNode: Node, targetOffset: number): number {
  let count = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === targetNode) {
      // If it's a text node, add the offset within it
      if (node.nodeType === Node.TEXT_NODE) {
        count += targetOffset;
      }
      break;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += (node as Text).data.length;
    } else if ((node as Element).hasAttribute?.(CHIP_ATTR)) {
      count += 1;
      // Skip children of chip
      node = walker.nextSibling() ?? walker.nextNode();
      continue;
    }
    node = walker.nextNode();
  }
  return count;
}

function restoreBookmark(container: HTMLElement, bookmark: Bookmark) {
  const sel = window.getSelection();
  if (!sel) return;

  let remaining = bookmark.offset;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL);
  let node: Node | null = walker.nextNode();

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length;
      if (remaining <= len) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
    } else if ((node as Element).hasAttribute?.(CHIP_ATTR)) {
      if (remaining === 0) {
        // Place cursor before chip
        const range = document.createRange();
        range.setStartBefore(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= 1;
      // Skip chip children
      node = walker.nextSibling() ?? walker.nextNode();
      continue;
    }
    node = walker.nextNode();
  }

  // Fallback: end of container
  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── DOM → Segments parser ─────────────────────────────────────────────────────

function domToSegments(container: HTMLElement, chipMap: Map<string, MentionChip>): Segment[] {
  const segments: Segment[] = [];
  let pendingText = '';

  const flush = () => {
    // Strip zero-width / empty cursor-anchor text nodes that buildDom inserts
    // around chips — they must not appear as content segments.
    const cleaned = pendingText.replace(/\u200B/g, '');
    if (cleaned) {
      segments.push({ kind: 'text', text: cleaned });
    }
    pendingText = '';
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pendingText += (node as Text).data;
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.hasAttribute(CHIP_ATTR)) {
        flush();
        const chipId = el.getAttribute(CHIP_ID_ATTR) ?? '';
        const chip = chipMap.get(chipId);
        if (chip) {
          segments.push({ kind: 'chip', chip });
        }
        return; // don't recurse into chip
      }
      // div/br inserted by browser on Enter → treat as newline
      if (el.tagName === 'DIV' || el.tagName === 'P') {
        pendingText += '\n';
      }
      if (el.tagName === 'BR') {
        pendingText += '\n';
        return;
      }
      for (const child of Array.from(el.childNodes)) {
        walk(child);
      }
    }
  };

  for (const child of Array.from(container.childNodes)) {
    walk(child);
  }
  flush();
  return segments;
}

// ── Segments → plain text ─────────────────────────────────────────────────────

export function segmentsToPlainText(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : s.chip.resource.name)).join('');
}

// ── Segments → send string ────────────────────────────────────────────────────

export function segmentsToSendString(segments: Segment[]): string {
  return segments
    .map((s) =>
      s.kind === 'text'
        ? s.text
        : `[${s.chip.resource.name}](teros://${s.chip.resource.type}/${s.chip.resource.id})`,
    )
    .join('');
}

// ── Chip container (portal target) ───────────────────────────────────────────

/**
 * Renders a MentionChip React component into a pre-existing DOM span.
 * We use ReactDOM.createPortal so React manages the chip's own state/events
 * while the span lives inside the contentEditable div.
 */
function ChipPortal({
  mountNode,
  chip,
  onRemove,
}: {
  mountNode: HTMLElement;
  chip: MentionChip;
  onRemove: (id: string) => void;
}) {
  return createPortal(
    <MentionChipComponent chip={chip} onRemove={onRemove} />,
    mountNode,
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export const InlineComposerInput = forwardRef<InlineComposerInputHandle, InlineComposerInputProps>(
  function InlineComposerInput(
    {
      segments,
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
    const editorRef = useRef<HTMLDivElement>(null);
    // Map chipId → MentionChip for fast lookup during DOM parsing
    const chipMapRef = useRef<Map<string, MentionChip>>(new Map());
    // Map chipId → DOM span (the portal mount nodes we created)
    const chipMountNodesRef = useRef<Map<string, HTMLElement>>(new Map());
    // Track whether we are in the middle of a programmatic DOM rebuild
    const isRebuildingRef = useRef(false);
    // Last segments we built the DOM from (to detect external changes)
    const lastSegmentsRef = useRef<Segment[]>([]);
    // When insertChip is called, store the newly inserted chip's id so that
    // buildDom can force the cursor to the text node immediately after that
    // chip span — bypassing restoreBookmark which can be confused by the
    // contenteditable=false chip spans.
    const pendingChipFocusIdRef = useRef<string | null>(null);
    // Portal state: array of {chipId, mountNode, chip} for rendering portals
    const [portals, setPortals] = React.useState<
      Array<{ chipId: string; mountNode: HTMLElement; chip: MentionChip }>
    >([]);

    // ── Chip removal handler ────────────────────────────────────────────────

    const handleRemoveChip = useCallback(
      (chipId: string) => {
        const mountNode = chipMountNodesRef.current.get(chipId);
        if (mountNode && mountNode.parentNode) {
          mountNode.parentNode.removeChild(mountNode);
        }
        chipMountNodesRef.current.delete(chipId);
        chipMapRef.current.delete(chipId);

        // Re-parse and notify
        const editor = editorRef.current;
        if (editor) {
          const newSegments = domToSegments(editor, chipMapRef.current);
          const plainText = segmentsToPlainText(newSegments);
          onChange(newSegments, plainText);
        }

        // Remove portal
        setPortals((prev) => prev.filter((p) => p.chipId !== chipId));
      },
      [onChange],
    );

    // ── Build DOM from segments ─────────────────────────────────────────────

    const buildDom = useCallback(
      (segs: Segment[], restoreCursor?: Bookmark) => {
        const editor = editorRef.current;
        if (!editor) return;

        isRebuildingRef.current = true;

        // Save cursor if not provided
        const bookmark = restoreCursor ?? getBookmark(editor);

        // Clear existing chip mount nodes tracking (we'll recreate)
        chipMountNodesRef.current.clear();
        chipMapRef.current.clear();

        // Build new DOM fragment
        const fragment = document.createDocumentFragment();
        const newPortals: Array<{ chipId: string; mountNode: HTMLElement; chip: MentionChip }> = [];

        // Helper: append a text node to the fragment
        const appendText = (text: string) => {
          // Split by newline to handle multiline
          const lines = text.split('\n');
          lines.forEach((line, i) => {
            if (line) fragment.appendChild(document.createTextNode(line));
            if (i < lines.length - 1) {
              fragment.appendChild(document.createTextNode('\n'));
            }
          });
        };

        // Helper: append a chip span to the fragment
        const appendChip = (chip: MentionChip) => {
          const chipId = chip.id;
          chipMapRef.current.set(chipId, chip);

          const span = document.createElement('span');
          span.setAttribute(CHIP_ATTR, '');
          span.setAttribute(CHIP_ID_ATTR, chipId);
          span.setAttribute('contenteditable', 'false');
          span.style.display = 'inline-flex';
          span.style.verticalAlign = 'middle';
          span.style.userSelect = 'none';
          span.style.margin = '0 2px';

          chipMountNodesRef.current.set(chipId, span);
          newPortals.push({ chipId, mountNode: span, chip });
          fragment.appendChild(span);
        };

        // Walk segments, ensuring text nodes exist around every chip so the
        // browser always has a caret position before the first chip, after the
        // last chip, and between two consecutive chips.
        let lastWasChip = false;

        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];

          if (seg.kind === 'text') {
            if (seg.text) {
              appendText(seg.text);
            } else {
              // Empty text segment — still append an empty text node so the
              // caret has somewhere to land (e.g. the space after a chip).
              fragment.appendChild(document.createTextNode(''));
            }
            lastWasChip = false;
          } else {
            // Before inserting a chip, ensure there is a text node immediately
            // preceding it so the cursor can be placed before the chip.
            // We need this when:
            //   • the chip is the first segment (no preceding text node), OR
            //   • the previous segment was also a chip (two chips in a row).
            if (i === 0 || lastWasChip) {
              fragment.appendChild(document.createTextNode(''));
            }

            appendChip(seg.chip);
            lastWasChip = true;
          }
        }

        // After the last segment, if it was a chip, append a trailing empty
        // text node so the cursor can be placed after the chip.
        if (lastWasChip) {
          fragment.appendChild(document.createTextNode(''));
        }

        // Replace editor content
        editor.innerHTML = '';
        editor.appendChild(fragment);

        // Ensure editor is not empty (for cursor placement)
        if (!editor.childNodes.length) {
          editor.appendChild(document.createTextNode(''));
        }

        // Update portals state so React renders chip components into mount nodes
        setPortals(newPortals);

        lastSegmentsRef.current = segs;

        // Restore cursor.
        // If a chip was just inserted (pendingChipFocusIdRef is set), we MUST
        // force the cursor into the text node that immediately follows the chip
        // span. We cannot rely solely on restoreBookmark here because:
        //   1. The chip span has contenteditable="false", which makes browsers
        //      reluctant to place the caret adjacent to it via a Range offset.
        //   2. React renders the chip portal asynchronously, so the chip span's
        //      inner content may not be finalised when restoreBookmark runs.
        // Using a double-rAF ensures we run after React's portal flush.
        const chipIdToFocus = pendingChipFocusIdRef.current;
        if (chipIdToFocus) {
          pendingChipFocusIdRef.current = null;
          // First rAF: let React flush the portal renders.
          requestAnimationFrame(() => {
            // Second rAF: browser has painted, chip span is fully in the DOM.
            requestAnimationFrame(() => {
              const chipSpan = editor.querySelector(
                `[${CHIP_ID_ATTR}="${chipIdToFocus}"]`,
              ) as HTMLElement | null;
              const afterChip = chipSpan?.nextSibling ?? null;
              const sel = window.getSelection();
              if (sel && afterChip) {
                // Place cursor at the very start of the text node after the chip.
                const range = document.createRange();
                range.setStart(afterChip, 0);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
              } else {
                // Fallback: use the bookmark-based restore.
                restoreBookmark(editor, bookmark);
              }
              isRebuildingRef.current = false;
            });
          });
        } else {
          requestAnimationFrame(() => {
            restoreBookmark(editor, bookmark);
            isRebuildingRef.current = false;
          });
        }
      },
      [],
    );

    // ── Sync external segment changes → DOM ────────────────────────────────

    useLayoutEffect(() => {
      // Skip rebuild if the change originated from inside this component
      // (insertChip / handleRemoveChip / clear already updated the DOM directly
      // and set lastSegmentsRef.current before calling onChange, so the parent
      // will echo back a new array with identical content — we must NOT rebuild
      // or we'll destroy the cursor).
      if (segments === lastSegmentsRef.current) return;

      // Deep-equality guard: if the serialised form matches what we already
      // have in the DOM, the parent is just echoing back our own onChange call
      // with a new array reference. Skip the rebuild to avoid cursor loss.
      const incomingKey = segmentsToSendString(segments);
      const currentKey = segmentsToSendString(lastSegmentsRef.current);
      if (incomingKey === currentKey) {
        // Adopt the new reference so future comparisons work correctly
        lastSegmentsRef.current = segments;
        return;
      }

      buildDom(segments);
    }, [segments, buildDom]);

    // ── Imperative handle ───────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          editorRef.current?.focus();
        },
        getCursorPos() {
          return editorRef.current ? getBookmark(editorRef.current).offset : 0;
        },
        getPlainText() {
          return editorRef.current
            ? segmentsToPlainText(domToSegments(editorRef.current, chipMapRef.current))
            : '';
        },
        serialize() {
          return editorRef.current
            ? segmentsToSendString(domToSegments(editorRef.current, chipMapRef.current))
            : '';
        },
        clear() {
          if (editorRef.current) {
            editorRef.current.innerHTML = '';
            editorRef.current.appendChild(document.createTextNode(''));
            chipMapRef.current.clear();
            chipMountNodesRef.current.clear();
            setPortals([]);
            lastSegmentsRef.current = [];
            onChange([], '');
          }
        },
        insertChip(chip: MentionChip, queryLength: number) {
          const editor = editorRef.current;
          if (!editor) return;

          // ── Strategy: segment-level replacement (avoids all DOM cursor bugs) ──
          //
          // Instead of manipulating the DOM directly (which is fragile with mixed
          // text/chip nodes), we:
          //   1. Read the current segments from the DOM.
          //   2. Compute the cursor offset (char-based, chips count as 1).
          //   3. Find the @query span in the segments (queryLength + 1 chars ending
          //      at the cursor offset).
          //   4. Replace that span with [chip segment] + [' ' text segment].
          //   5. Rebuild the DOM from the new segments via buildDom(), which
          //      correctly positions the cursor right after the chip.
          //   6. Notify the parent via onChange() — using the same array reference
          //      that buildDom() stored in lastSegmentsRef, so the useLayoutEffect
          //      deep-equality guard skips the redundant rebuild.

          const currentSegments = domToSegments(editor, chipMapRef.current);
          const cursorOffset = getBookmark(editor).offset;
          const charsToDelete = queryLength + 1; // '@' + query text

          // Walk segments to find where the @query lives and split them.
          const newSegments: Segment[] = [];
          let charsSeen = 0;
          let inserted = false;

          for (const seg of currentSegments) {
            if (inserted) {
              newSegments.push(seg);
              continue;
            }

            if (seg.kind === 'chip') {
              charsSeen += 1;
              newSegments.push(seg);
              continue;
            }

            // Text segment
            const segStart = charsSeen;
            const segEnd = charsSeen + seg.text.length;

            if (cursorOffset >= segStart && cursorOffset <= segEnd && segEnd > segStart) {
              // The cursor is inside this text segment.
              // The @query ends at cursorOffset (relative to segment start).
              const localCursor = cursorOffset - segStart;
              const localAtStart = localCursor - charsToDelete;

              // Text before '@'
              if (localAtStart > 0) {
                newSegments.push({ kind: 'text', text: seg.text.slice(0, localAtStart) });
              }

              // The chip itself
              newSegments.push({ kind: 'chip', chip });

              // A single space after the chip (cursor will land here)
              newSegments.push({ kind: 'text', text: ' ' });

              // Text after the query (the part the user hadn't typed yet)
              if (localCursor < seg.text.length) {
                newSegments.push({ kind: 'text', text: seg.text.slice(localCursor) });
              }

              inserted = true;
            } else {
              newSegments.push(seg);
            }

            charsSeen = segEnd;
          }

          if (!inserted) {
            // Fallback: cursor was at the very end or we couldn't locate the @query.
            // Just append chip + space.
            newSegments.push({ kind: 'chip', chip });
            newSegments.push({ kind: 'text', text: ' ' });
          }

          // Compute the cursor position after insertion:
          // It should land right after the space that follows the chip.
          // Walk newSegments to find the char offset of the end of the space.
          let targetCursorOffset = 0;
          for (const seg of newSegments) {
            if (seg.kind === 'chip') {
              if (seg.chip.id === chip.id) {
                // The space after the chip is the next segment; cursor goes after it (+1).
                targetCursorOffset += 1 + 1; // chip(1) + space(1)
                break;
              }
              targetCursorOffset += 1;
            } else {
              targetCursorOffset += seg.text.length;
            }
          }

          // Signal buildDom to force the cursor after this chip's span
          // instead of using the bookmark-based restore (which is unreliable
          // next to contenteditable=false chip spans).
          pendingChipFocusIdRef.current = chip.id;

          // Rebuild DOM from segments, restoring cursor to after the chip+space.
          buildDom(newSegments, { offset: targetCursorOffset });

          // Notify parent. lastSegmentsRef.current is already set to newSegments
          // by buildDom(), so the useLayoutEffect deep-equality guard will skip
          // the redundant rebuild when the parent echoes back setSegments().
          const plainText = segmentsToPlainText(newSegments);
          onChange(newSegments, plainText);
        },
      }),
      [onChange, buildDom],
    );

    // ── Input handler ───────────────────────────────────────────────────────

    const handleInput = useCallback(() => {
      if (isRebuildingRef.current) return;
      const editor = editorRef.current;
      if (!editor) return;

      // ── Sync chip tracking maps after browser-native edits (e.g. Backspace) ──
      // The browser can remove chip spans from the DOM without going through our
      // React handlers (e.g. the user presses Backspace next to a chip). When
      // that happens we must evict the stale chip from chipMapRef /
      // chipMountNodesRef and remove its portal so React doesn't try to render
      // into a detached node.
      const chipsInDom = new Set(
        Array.from(editor.querySelectorAll(`[${CHIP_ID_ATTR}]`)).map(
          (el) => el.getAttribute(CHIP_ID_ATTR) as string,
        ),
      );
      let removedAny = false;
      for (const chipId of Array.from(chipMapRef.current.keys())) {
        if (!chipsInDom.has(chipId)) {
          chipMapRef.current.delete(chipId);
          chipMountNodesRef.current.delete(chipId);
          removedAny = true;
        }
      }
      if (removedAny) {
        // Prune portals for chips no longer in the DOM.
        setPortals((prev) => prev.filter((p) => chipsInDom.has(p.chipId)));
      }

      const newSegments = domToSegments(editor, chipMapRef.current);
      const plainText = segmentsToPlainText(newSegments);
      lastSegmentsRef.current = newSegments;

      // Detect @mention trigger.
      // IMPORTANT: onMentionTrigger expects a cursor offset measured in the
      // *expanded* plainText (where chips are their name strings), NOT in the
      // bookmark offset (where chips count as 1). We convert here by walking
      // segments and accumulating the expanded length up to the bookmark offset.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const bookmarkOffset = getBookmark(editor).offset;
        // Translate bookmark offset → plainText offset
        let bookmarkRemaining = bookmarkOffset;
        let plainTextCursor = 0;
        for (const seg of newSegments) {
          if (bookmarkRemaining <= 0) break;
          if (seg.kind === 'chip') {
            bookmarkRemaining -= 1;
            plainTextCursor += seg.chip.resource.name.length;
          } else {
            const take = Math.min(seg.text.length, bookmarkRemaining);
            bookmarkRemaining -= take;
            plainTextCursor += take;
          }
        }
        onMentionTrigger(plainText, plainTextCursor);
      }

      onChange(newSegments, plainText);
    }, [onChange, onMentionTrigger]);

    // ── Keydown handler ─────────────────────────────────────────────────────

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        // ── Backspace: remove chip when cursor is immediately after it ──────
        // Browsers treat contenteditable=false spans inconsistently on Backspace:
        // some require two presses (first to "select", then to delete). We
        // intercept Backspace here and, if the node immediately before the caret
        // is a chip span, we remove it ourselves so one press always suffices.
        if (e.key === 'Backspace') {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
            const range = sel.getRangeAt(0);
            // Only act when the caret is at offset 0 inside a text node whose
            // previous sibling is a chip span (i.e. cursor is right after a chip).
            if (
              range.startOffset === 0 &&
              range.startContainer.nodeType === Node.TEXT_NODE
            ) {
              const prevSibling = range.startContainer.previousSibling as Element | null;
              if (prevSibling && prevSibling.hasAttribute?.(CHIP_ATTR)) {
                e.preventDefault();
                const chipId = prevSibling.getAttribute(CHIP_ID_ATTR) ?? '';
                prevSibling.parentNode?.removeChild(prevSibling);
                // Clean up tracking maps
                chipMapRef.current.delete(chipId);
                chipMountNodesRef.current.delete(chipId);
                setPortals((prev) => prev.filter((p) => p.chipId !== chipId));
                // Re-parse and notify parent
                const editor = editorRef.current;
                if (editor) {
                  const newSegments = domToSegments(editor, chipMapRef.current);
                  lastSegmentsRef.current = newSegments;
                  onChange(newSegments, segmentsToPlainText(newSegments));
                }
                // Don't call onKeyDown for this event — it's fully handled.
                return;
              }
            }
          }
        }

        onKeyDown?.(e.nativeEvent);
      },
      [onKeyDown, onChange],
    );

    // ── Paste handler — strip HTML, keep plain text ─────────────────────────

    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    }, []);

    // ── Placeholder visibility ──────────────────────────────────────────────

    const isEmpty = segments.length === 0 || (segments.length === 1 && segments[0].kind === 'text' && segments[0].text === '');

    // ── Render ──────────────────────────────────────────────────────────────

    return (
      <>
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

          {/* Editor */}
          <div
            ref={editorRef}
            contentEditable={disabled ? false : true}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            style={{
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
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              cursor: disabled ? 'not-allowed' : 'text',
              opacity: disabled ? 0.5 : 1,
              // Scrollbar styling
              scrollbarWidth: 'thin' as any,
              scrollbarColor: 'rgba(63,63,70,0.5) transparent',
              ...style,
            }}
          />
        </div>

        {/* Portals: render React chip components into DOM spans inside the editor */}
        {portals.map(({ chipId, mountNode, chip }) => (
          <ChipPortal
            key={chipId}
            mountNode={mountNode}
            chip={chip}
            onRemove={handleRemoveChip}
          />
        ))}
      </>
    );
  },
);
