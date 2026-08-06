/**
 * Language extension resolver for CodeMirror 6
 *
 * Maps a language identifier (derived from file extension) to the appropriate
 * CodeMirror language extension. Falls back to no highlighting for unknown languages.
 */

import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { Extension } from '@codemirror/state'

/**
 * Returns the CodeMirror language extension for the given language string.
 * Language strings match what languageDetector.ts produces from file extensions.
 */
export function getLanguageExtension(language: string): Extension {
  switch (language) {
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true })
    case 'jsx':
      return javascript({ jsx: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'python':
      return python()
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'html':
      return html()
    case 'css':
    case 'scss':
    case 'sass':
      return css()
    case 'sql':
      return sql()
    case 'xml':
      return xml()
    case 'shell':
      return StreamLanguage.define(shell)
    case 'yaml':
      return StreamLanguage.define(yaml)
    default:
      // Plain text — no syntax highlighting
      return []
  }
}
