/**
 * MentionNode — Custom Lexical DecoratorNode for @mention chips.
 * Renders the MentionChip component inline inside the Lexical editor.
 */
import type { EditorConfig, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { DecoratorNode } from 'lexical';
import React from 'react';
import type { MentionChip } from '../../hooks/useAtMention';
import { MentionChip as MentionChipComponent } from './MentionChip';

export type SerializedMentionNode = Spread<
  { chip: MentionChip; type: 'mention'; version: 1 },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<React.ReactElement> {
  __chip: MentionChip;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__chip, node.__key);
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return new MentionNode(serialized.chip);
  }

  constructor(chip: MentionChip, key?: NodeKey) {
    super();
    this.__chip = chip;
  }

  exportJSON(): SerializedMentionNode {
    return { type: 'mention', version: 1, chip: this.__chip };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.style.verticalAlign = 'middle';
    span.style.userSelect = 'none';
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): React.ReactElement {
    return (
      <MentionChipComponent
        chip={this.__chip}
        onRemove={(chipId) => {
          const event = new CustomEvent('mention-remove', { detail: { chipId } });
          document.dispatchEvent(event);
        }}
      />
    );
  }
}

export function $createMentionNode(chip: MentionChip): MentionNode {
  return new MentionNode(chip);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}
