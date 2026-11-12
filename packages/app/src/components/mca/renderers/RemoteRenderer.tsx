/**
 * Remote MCA — Custom Tool Call Renderer (`mca.teros.remote`)
 *
 * The daemon declares EXACT parity with `mca.teros.filesystem` (2.3.0) and
 * `mca.teros.bash` (1.2.0) — same tool names, same output shapes (verified
 * against teros-remote packages/daemon/src). So the 19 filesystem tools and
 * `bash` delegate to the battle-tested Filesystem/Bash renderers instead of
 * duplicating ~1600 LOC. Only the two device tools get purpose-built UI:
 *   • device-status — tunnel + identity + scope specsheet (REQ-6/13)
 *   • get-info      — six-block system snapshot (T-REM-3)
 *
 * Fallback is a dev-only signal of a missing dispatch entry (same contract
 * as FilesystemRenderer).
 */

import type React from 'react';
import { Badge, ToolCallCard } from '../primitives';
import { getShortToolName } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { createBashRendererBase } from './BashRendererCore';
import { FilesystemToolCallRenderer } from './FilesystemRenderer';
import { DeviceStatusRenderer } from './remote/DeviceStatusRenderer';
import { GetInfoRenderer } from './remote/GetInfoRenderer';

const RemoteBashRendererBase = createBashRendererBase('mca.teros.remote');

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // device tools — purpose-built
  'device-status': DeviceStatusRenderer,
  'get-info': GetInfoRenderer,
  // exec — same UI as local bash, heuristics keyed to the remote mcaId
  'bash': RemoteBashRendererBase,
  // filesystem parity (19 tools) — identical names & output shapes
  'health-check': FilesystemToolCallRenderer,
  'list-roots': FilesystemToolCallRenderer,
  'read-file': FilesystemToolCallRenderer,
  'read-files': FilesystemToolCallRenderer,
  'read-binary': FilesystemToolCallRenderer,
  'create-file': FilesystemToolCallRenderer,
  'append-file': FilesystemToolCallRenderer,
  'edit-file': FilesystemToolCallRenderer,
  'patch-file': FilesystemToolCallRenderer,
  'list-files': FilesystemToolCallRenderer,
  'tree-view': FilesystemToolCallRenderer,
  'file-info': FilesystemToolCallRenderer,
  'hash-file': FilesystemToolCallRenderer,
  'find-files': FilesystemToolCallRenderer,
  'search-in-files': FilesystemToolCallRenderer,
  'delete-file': FilesystemToolCallRenderer,
  'copy-file': FilesystemToolCallRenderer,
  'move-file': FilesystemToolCallRenderer,
  'create-directory': FilesystemToolCallRenderer,
};

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);
  let badge: React.ReactNode = null;
  if (status === 'completed') badge = <Badge text="done" variant="success" />;
  else if (status === 'failed') badge = <Badge text="failed" variant="error" />;
  return (
    <ToolCallCard
      status={status}
      description={shortName.replace(/-/g, ' ')}
      badge={badge}
      iconUri={appIcon}
    />
  );
}

function RemoteRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const RemoteToolCallRenderer = withPermissionSupport(RemoteRendererBase);
export default RemoteToolCallRenderer;
