/**
 * Local root resolution for the native-fs tools (find-files via tinyglobby,
 * search-in-files via ripgrep/execa). These run against a real filesystem
 * while everything else goes through ctx.volume, so they need to know where
 * the workspace volume actually lives on this machine.
 *
 * Resolution order (workspace/jailed role):
 * 1. MCA_VOLUME_MOUNT_PATH — container mode, volume mounted at /workspace.
 * 2. MCA_WORKSPACE_PATH — stdio mode, set by spawn-impl to the owner
 *    workspace's REAL volume hostPath. Prevents the cross-workspace landmine
 *    where the old bare '/workspace' fallback resolved to the GLOBAL host
 *    symlink → another workspace's volume.
 * 3. '/workspace' — last resort (container convention).
 *
 * Admin role: host root '/' — full host access.
 * @todo nira - 2026-10-19: the admin role is dead code since mca.teros.admin.filesystem
 * was retired (replaced by Teros Remote). Remove MCA_FS_ROLE + native-volume.ts.
 */

export function resolveLocalRoot(): string {
  if (process.env.MCA_FS_ROLE === 'admin') {
    return '/';
  }
  return (
    process.env.MCA_VOLUME_MOUNT_PATH ||
    process.env.MCA_WORKSPACE_PATH ||
    '/workspace'
  );
}
