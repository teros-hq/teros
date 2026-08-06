/**
 * Renderer for `mca.teros.admin.bash` — same UI as user bash, distinct
 * `mcaId` for permission heuristics routing.
 *
 * Admin scope is strictly more privileged than user bash (runs as the
 * service host process, no container sandbox), so the same destructive
 * idioms map to even greater consequences. The visual treatment is
 * intentionally identical — risk visibility shouldn't depend on which
 * scope happened to dispatch the call.
 *
 * All UI logic lives in `BashRendererCore.tsx`. This file is a thin
 * shim — duplication eliminated in commit GG.
 */

import { withPermissionSupport } from '../withPermissionSupport';
import { createBashRendererBase } from './BashRendererCore';

const AdminBashRendererBase = createBashRendererBase('mca.teros.admin.bash');

export const AdminBashToolCallRenderer = withPermissionSupport(AdminBashRendererBase);

export default AdminBashToolCallRenderer;
