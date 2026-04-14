import { describe, it, expect, vi, afterEach } from 'vitest';

import { agentContainerUidGid } from './agent-container-user.js';

describe('agentContainerUidGid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 1000 when uid is root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.spyOn(process, 'getgid').mockReturnValue(0);
    expect(agentContainerUidGid()).toEqual({ uid: 1000, gid: 1000 });
  });

  it('returns 1000 when uid is 1000', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'getgid').mockReturnValue(1000);
    expect(agentContainerUidGid()).toEqual({ uid: 1000, gid: 1000 });
  });

  it('returns host uid when non-root and not 1000', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1001);
    vi.spyOn(process, 'getgid').mockReturnValue(1002);
    expect(agentContainerUidGid()).toEqual({ uid: 1001, gid: 1002 });
  });
});
