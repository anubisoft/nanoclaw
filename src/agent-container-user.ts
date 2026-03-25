/**
 * Agent containers run as the `node` user (uid 1000) by default, or as the
 * orchestrator's uid when it is neither root nor 1000 (typical bind-mount setups).
 * Volume files must be owned accordingly so the agent can unlink IPC inputs and
 * write under mounted `.claude`.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

export function agentContainerUidGid(): { uid: number; gid: number } {
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    return { uid: hostUid, gid: hostGid ?? hostUid };
  }
  return { uid: 1000, gid: 1000 };
}

/** When orchestrator is root, fix ownership so the agent user can read/write. */
export function chownPathToAgentRecursiveIfRoot(targetPath: string): void {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = agentContainerUidGid();
  try {
    if (!fs.existsSync(targetPath)) return;
    spawnSync('chown', ['-R', `${uid}:${gid}`, targetPath], {
      stdio: 'ignore',
    });
  } catch {
    /* best-effort */
  }
}

export function chownPathToAgentIfRoot(targetPath: string): void {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = agentContainerUidGid();
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch {
    /* best-effort */
  }
}
