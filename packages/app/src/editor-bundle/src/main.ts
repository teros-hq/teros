/**
 * CodeMirror 6 editor bundle — entry point
 *
 * This file is compiled by esbuild into a self-contained JS bundle that is
 * inlined into an HTML string and injected into a WebView / iframe.
 *
 * Communication with the React Native host:
 *   RN → WebView: window.terosEditor.init({ content, language, theme, vimMode })
 *   RN → WebView: window.terosEditor.onSaved()
 *   RN → WebView: window.terosEditor.onSaveError(message)
 *   RN → WebView: window.terosEditor.pressEscape()
 *   RN → WebView: window.terosEditor.setTheme(theme)
 *   RN → WebView: window.terosEditor.setVimMode(enabled)
 *
 *   WebView → RN: { type: 'ready' }
 *   WebView → RN: { type: 'change', content }
 *   WebView → RN: { type: 'save' }
 *   WebView → RN: { type: 'saveAndClose' }
 *   WebView → RN: { type: 'close', force: boolean }
 *   WebView → RN: { type: 'reload' }
 *   WebView → RN: { type: 'modeChange', mode, subMode }
 *   WebView → RN: { type: 'blurKeyboard' }
 */

import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, lineNumbers, keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { oneDarkHighlightStyle, oneDarkTheme } from '@codemirror/theme-one-dark'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { vim, Vim, getCM } from '@replit/codemirror-vim'
import { getLanguageExtension } from './languages'

// ============================================================================
// STATE
// ============================================================================

let view: EditorView | null = null
let isDirty = false

// Compartment for the EditorView color theme (colors/bg only — NOT HighlightStyle)
const themeCompartment = new Compartment()

// Compartment for vim mode — allows toggling on/off without recreating the editor
const vimCompartment = new Compartment()

// ============================================================================
// BRIDGE: send message to React Native host
// ============================================================================

function sendToRN(msg: object): void {
  const data = JSON.stringify(msg)
  if ((window as any).ReactNativeWebView) {
    ;(window as any).ReactNativeWebView.postMessage(data)
  } else {
    window.parent.postMessage(data, '*')
  }
}

// ============================================================================
// VIM EX COMMANDS — registered once at bundle load time (global)
// ============================================================================
//
// NOTE: Vim.defineEx(name, prefix, fn) — the prefix must be a valid alphabetic
// prefix of name. Characters like '!' are NOT valid in name/prefix.
// To handle :q! vs :q, register a single 'quit' command and inspect
// params.argString (which contains everything after the command name,
// including the '!' if the user typed :q!).

function registerExCommands(): void {
  // :w / :write — save
  Vim.defineEx('write', 'w', () => {
    sendToRN({ type: 'save' })
  })

  // :q / :quit / :q! — close, optionally forced
  // params.argString === '!' when the user typed :q!
  Vim.defineEx('quit', 'q', (_cm: any, params: any) => {
    const force = params?.argString?.trim() === '!'
    sendToRN({ type: 'close', force })
  })

  // :wq — save and close (! variant also accepted, same behaviour here)
  Vim.defineEx('wq', 'wq', () => {
    sendToRN({ type: 'saveAndClose' })
  })

  // :x / :xit — save if dirty, then close
  Vim.defineEx('xit', 'x', () => {
    sendToRN({ type: 'saveAndClose' })
  })

  // :e / :edit — reload from disk
  Vim.defineEx('edit', 'e', () => {
    sendToRN({ type: 'reload' })
  })
}

// Register Ex commands immediately (global, not per-editor-instance)
registerExCommands()

// vim-mode-change is subscribed per-view inside init(), via getCM(view).on(...)
// See: https://github.com/replit/codemirror-vim — the event is emitted on the
// CodeMirror5-compat cm instance, not on the global Vim object.

// ============================================================================
// PUBLIC API — exposed to React Native via injectJavaScript
// ============================================================================

;(window as any).terosEditor = {
  /**
   * Initialize (or re-initialize) the editor with content.
   * Called by the RN component after the WebView signals 'ready'.
   */
  init({
    content,
    language,
    theme,
    vimMode = true,
  }: {
    content: string
    language: string
    theme: 'dark' | 'light'
    vimMode?: boolean
  }): void {
    // Destroy previous instance if any
    if (view) {
      view.destroy()
      view = null
    }

    isDirty = false

    // ── Theme split ────────────────────────────────────────────────────────
    // syntaxHighlighting() registers a Facet and MUST live in the base
    // extension array — it cannot be placed inside a Compartment or it will
    // not be applied correctly by the CodeMirror state machinery.
    //
    // The Compartment only holds the EditorView.theme (CSS colors / bg),
    // which CAN be reconfigured dynamically (e.g. for live theme switching).
    const highlightExt = theme === 'dark'
      ? syntaxHighlighting(oneDarkHighlightStyle)
      : syntaxHighlighting(defaultHighlightStyle)

    const viewThemeExt = theme === 'dark' ? oneDarkTheme : []

    const extensions = [
      // Vim mode in a Compartment — can be toggled on/off dynamically
      vimCompartment.of(vimMode ? vim() : []),

      // Line numbers
      lineNumbers(),

      // Indentation
      indentUnit.of('  '),
      indentOnInput(),
      keymap.of([...defaultKeymap, indentWithTab]),

      // Language — provides the parser; MUST be before syntaxHighlighting
      getLanguageExtension(language),

      // Syntax highlighting — registered as a base Facet, NOT in a Compartment
      highlightExt,

      // Base layout + gutter theme — structural rules and dark gutter colors
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "Courier New", monospace',
          fontSize: '14px',
          lineHeight: '1.6',
        },
        // Gutter (line numbers): slightly darker bg than editor, muted text
        '.cm-gutters': {
          backgroundColor: '#21252b',
          color: '#636d83',
          borderRight: '1px solid #181a1f',
        },
        '.cm-lineNumbers .cm-gutterElement': {
          paddingLeft: '8px',
          paddingRight: '8px',
        },
        '.cm-vim-panel': {
          fontFamily: 'monospace',
          fontSize: '13px',
          padding: '2px 8px',
          minHeight: '22px',
        },
      }),

      // Color theme in a Compartment (only EditorView.theme, no HighlightStyle)
      themeCompartment.of(viewThemeExt),

      // Change listener → notify RN
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          isDirty = true
          sendToRN({ type: 'change', content: update.state.doc.toString() })
        }
      }),
    ]

    const container = document.getElementById('editor')
    if (!container) {
      console.error('[TerosEditor] #editor element not found')
      return
    }

    view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: container,
    })

    // Subscribe to vim-mode-change via the CodeMirror5-compat cm instance.
    // getCM(view) returns the cm instance after vim() has been initialised.
    // Must be called AFTER EditorView is created.
    if (vimMode) {
      const cm = getCM(view)
      if (cm) {
        cm.on('vim-mode-change', (event: { mode: string; subMode?: string }) => {
          sendToRN({ type: 'modeChange', mode: event.mode, subMode: event.subMode ?? null })
          if (event.mode === 'normal') {
            sendToRN({ type: 'blurKeyboard' })
          }
        })
      }
    }
  },

  /**
   * Called by RN after a successful save.
   * Clears the dirty flag.
   */
  onSaved(): void {
    isDirty = false
  },

  /**
   * Called by RN when a save fails.
   */
  onSaveError(message: string): void {
    console.error('[TerosEditor] Save error:', message)
  },

  /**
   * Simulate pressing Escape — used by the ESC toolbar button on mobile.
   * Exits Insert/Visual mode and returns to Normal mode.
   */
  pressEscape(): void {
    if (view) {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    }
  },

  /**
   * Dynamically swap the color theme without recreating the editor.
   * Only reconfigures the EditorView.theme (colors/bg) — the HighlightStyle
   * is baked into the base extensions and cannot change without recreating.
   */
  setTheme(theme: 'dark' | 'light'): void {
    if (view) {
      view.dispatch({
        effects: themeCompartment.reconfigure(theme === 'dark' ? oneDarkTheme : []),
      })
    }
  },

  /**
   * Toggle vim mode on/off without recreating the editor.
   * Uses the vimCompartment to reconfigure the vim() extension dynamically.
   * When enabling, re-subscribes to vim-mode-change events.
   */
  setVimMode(enabled: boolean): void {
    if (!view) return
    view.dispatch({
      effects: vimCompartment.reconfigure(enabled ? vim() : []),
    })
    if (enabled) {
      // Re-attach vim-mode-change listener after reconfiguration
      const cm = getCM(view)
      if (cm) {
        cm.on('vim-mode-change', (event: { mode: string; subMode?: string }) => {
          sendToRN({ type: 'modeChange', mode: event.mode, subMode: event.subMode ?? null })
          if (event.mode === 'normal') {
            sendToRN({ type: 'blurKeyboard' })
          }
        })
      }
    } else {
      // Notify host that we're back to a neutral mode
      sendToRN({ type: 'modeChange', mode: 'normal', subMode: null })
    }
  },

  /**
   * Get current dirty state (for debugging).
   */
  isDirty(): boolean {
    return isDirty
  },
}

// ============================================================================
// KEYBOARD SHORTCUT: Cmd+S / Ctrl+S
// ============================================================================

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    sendToRN({ type: 'save' })
  }
})

// ============================================================================
// WEB IFRAME: listen for __terosInject messages from the parent frame
//
// On React Native, the host uses injectJavaScript() which runs code directly
// in the WebView context. On web (iframe), that path is unavailable — the host
// uses postMessage({ __terosInject: '<code>' }, '*') instead.
// We receive that here and eval() it so the same injectJS() path works on both.
// ============================================================================

window.addEventListener('message', (e: MessageEvent) => {
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    if (data && typeof data.__terosInject === 'string') {
      // eslint-disable-next-line no-eval
      eval(data.__terosInject)
    }
  } catch {
    // ignore parse / eval errors
  }
})

// ============================================================================
// SIGNAL READY
// ============================================================================

// Signal to the RN component that the bundle has loaded and the editor API
// is available. The component will call terosEditor.init() in response.
sendToRN({ type: 'ready' })
