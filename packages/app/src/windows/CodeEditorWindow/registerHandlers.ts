/**
 * registerCodeEditorHandlers
 *
 * Registers file-open handlers for all supported code/text extensions.
 * Called from registerAllWindowTypes() in windows/index.ts.
 */

import { registerFileOpenHandler } from '../../services/fileOpener';
import { useTilingStore } from '../../store/tilingStore';

const CODE_EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx',
  'ts', 'tsx',
  'py',
  'json', 'jsonc',
  'css', 'scss', 'sass',
  'sh', 'bash', 'zsh',
  'yaml', 'yml',
  'sql',
  'xml',
  'txt',
  'env',
  'toml',
  'ini',
  'cfg',
  'conf',
  'md', 'markdown',
];

const HTML_EXTENSIONS = ['html', 'htm'];

export function registerCodeEditorHandlers(): void {
  const openWindow = useTilingStore.getState().openWindow;

  for (const ext of CODE_EXTENSIONS) {
    registerFileOpenHandler(ext, (path: string, workspaceId?: string) => {
      openWindow('code-editor', { filePath: path, workspaceId }, false);
      return true;
    });
  }

  // HTML files open in the File Viewer (real-time preview with auto-refresh)
  for (const ext of HTML_EXTENSIONS) {
    registerFileOpenHandler(ext, (path: string, workspaceId?: string) => {
      openWindow('file-viewer', { filePath: path, workspaceId }, false);
      return true;
    });
  }
}
