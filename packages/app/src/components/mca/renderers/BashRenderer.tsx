/**
 * Renderer for `mca.teros.bash`. The actual UI lives in
 * `BashRendererCore.tsx` — this file is a thin shim that:
 *
 *   1. Calls the factory with the user-scope `mcaId` (so the per-call
 *      heuristics registry looks up `mca.teros.bash:bash`).
 *   2. Wraps the resulting base in `withPermissionSupport` so the
 *      `pending_permission` context (forceExpand + ControlsBar) flows
 *      through.
 *
 * Any fix to the bash UI lives in the Core, never duplicated here.
 * (The admin-bash variant went away with mca.teros.admin.bash on
 * 2026-10-19 — host access is served by Teros Remote now.)
 */

import { withPermissionSupport } from '../withPermissionSupport';
import { createBashRendererBase } from './BashRendererCore';

const BashRendererBase = createBashRendererBase('mca.teros.bash');

export const BashToolCallRenderer = withPermissionSupport(BashRendererBase);

export default BashToolCallRenderer;
