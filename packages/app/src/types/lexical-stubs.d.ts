// Type stubs for lexical packages — these components are experimental/dead code
// not imported anywhere in the app. Stubs prevent TS module-not-found errors.

declare module 'lexical' {
  export class LexicalEditor {}
  export class EditorState {}
  export class LexicalNode {
    __key: string;
  }
  export class DecoratorNode<T> extends LexicalNode {
    decorate(editor: LexicalEditor, config: EditorConfig): T;
    createDOM(config: EditorConfig): HTMLElement;
    updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean;
  }
  export interface EditorConfig {
    namespace: string;
    theme: Record<string, any>;
    onError: (error: Error) => void;
  }
  export interface NodeKey {}
  export interface SerializedLexicalNode {
    type: string;
    version: number;
  }
  export type Spread<T, U> = T & Omit<U, keyof T>;

  export function $createParagraphNode(): any;
  export function $createTextNode(text: string): any;
  export function $getRoot(): any;
  export function $getSelection(): any;
  export function $isRangeSelection(selection: any): boolean;
}

declare module '@lexical/react/LexicalAutoFocusPlugin' {
  export function AutoFocusPlugin(props: { defaultSelection?: any }): any;
}

declare module '@lexical/react/LexicalComposer' {
  import { ReactNode } from 'react';
  interface InitialConfig {
    namespace: string;
    onError: (error: Error) => void;
    theme?: Record<string, any>;
    nodes?: any[];
    editorState?: any;
  }
  export function LexicalComposer(props: { initialConfig: InitialConfig; children: ReactNode }): any;
}

declare module '@lexical/react/LexicalContentEditable' {
  export function ContentEditable(props: { className?: string; 'aria-placeholder'?: string; placeholder?: any }): any;
}

declare module '@lexical/react/LexicalErrorBoundary' {
  export function LexicalErrorBoundary(props: { children: any }): any;
}

declare module '@lexical/react/LexicalHistoryPlugin' {
  export function HistoryPlugin(): any;
}

declare module '@lexical/react/LexicalOnChangePlugin' {
  export function OnChangePlugin(props: { onChange: (editorState: any, editor: any, tags: Set<string>) => void }): any;
}

declare module '@lexical/react/LexicalPlainTextPlugin' {
  import { ReactNode } from 'react';
  export function PlainTextPlugin(props: { contentEditable: ReactNode; placeholder: ReactNode; ErrorBoundary: any }): any;
}

declare module '@lexical/react/LexicalComposerContext' {
  export function useLexicalComposerContext(): [any, any];
}

declare module 'react-dom' {
  export function createPortal(children: any, container: Element | DocumentFragment): any;
}

declare module 'react-test-renderer' {
  export function create(element: any, options?: any): any;
  export function act(callback: () => any): any;
}
