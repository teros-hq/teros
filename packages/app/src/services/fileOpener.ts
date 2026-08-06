/**
 * fileOpener — Extension-based file open handler registry
 *
 * Allows different parts of the app to register handlers for specific file
 * extensions. When a file is opened (e.g. from the File Browser), the
 * registered handler for that extension is called.
 *
 * The second argument (`contextId`) is a generic workspace/channel identifier.
 * Callers pass whatever context they have:
 *   - File Browser passes `workspaceId`
 *   - Chat bubbles pass `channelId`
 * Handlers receive this value and use it as appropriate.
 *
 * Usage:
 *   // Register a handler for .md files (done once at app init)
 *   registerFileOpenHandler('md', (path, contextId) => {
 *     openWindow('markdown-viewer', { filePath: path, channelId: contextId });
 *     return true;
 *   });
 *
 *   // Open a file (called from File Browser or other entry points)
 *   const handled = openFile('/workspace/spec.md', workspaceId);
 *   if (!handled) { toast.info('No viewer available for this file type.'); }
 */

/**
 * A handler for opening a file.
 * @param path      Absolute path to the file (e.g. '/workspace/spec.md')
 * @param contextId Workspace ID or channel ID — whatever the caller has
 * @returns true if the file was handled, false otherwise
 */
export type FileOpenHandler = (path: string, contextId: string) => boolean | void;

const handlers: Record<string, FileOpenHandler> = {};

/**
 * Register a handler for a specific file extension (without the leading dot).
 * Example: registerFileOpenHandler('md', handler)
 */
export function registerFileOpenHandler(extension: string, handler: FileOpenHandler): void {
  handlers[extension.toLowerCase()] = handler;
}

/**
 * Open a file by dispatching to the registered handler for its extension.
 *
 * @returns true if a handler was found and called, false if no handler exists
 */
export function openFile(path: string, contextId: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const handler = handlers[ext];
  if (!handler) {
    console.warn(`[fileOpener] No handler registered for extension: .${ext} (path: ${path})`);
    return false;
  }
  handler(path, contextId);
  return true;
}

/**
 * Check whether a handler is registered for a given extension.
 */
export function hasFileOpenHandler(extension: string): boolean {
  return extension.toLowerCase() in handlers;
}
