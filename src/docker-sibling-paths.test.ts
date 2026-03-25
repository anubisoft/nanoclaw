import { describe, it, expect } from 'vitest';

import {
  translatePathForNestedDocker,
  type DockerVolumePrefixMapping,
} from './docker-sibling-paths.js';

describe('translatePathForNestedDocker', () => {
  const volData = '/var/lib/docker/volumes/proj_nanoclaw_data/_data';
  const volGroups = '/var/lib/docker/volumes/proj_nanoclaw_groups/_data';

  const mappings: DockerVolumePrefixMapping[] = [
    { containerPrefix: '/app/data', hostPrefix: volData },
    { containerPrefix: '/app/groups', hostPrefix: volGroups },
  ].sort((a, b) => b.containerPrefix.length - a.containerPrefix.length);

  it('maps paths under a named volume to the host _data path', () => {
    expect(
      translatePathForNestedDocker('/app/data/sessions/main/agent-runner-src', mappings, {
        projectRoot: '/app',
      }),
    ).toBe(`${volData}/sessions/main/agent-runner-src`);
  });

  it('prefers the longest matching mount prefix', () => {
    const nested: DockerVolumePrefixMapping[] = [
      { containerPrefix: '/app', hostPrefix: '/host/app' },
      { containerPrefix: '/app/data', hostPrefix: volData },
    ].sort((a, b) => b.containerPrefix.length - a.containerPrefix.length);
    expect(
      translatePathForNestedDocker('/app/data/x', nested, { projectRoot: '/app' }),
    ).toBe(`${volData}/x`);
  });

  it('returns the path unchanged when no mapping matches', () => {
    expect(
      translatePathForNestedDocker('/tmp/orphan', mappings, { projectRoot: '/app' }),
    ).toBe('/tmp/orphan');
  });

  it('maps project root via NANOCLAW_DOCKER_HOST_PROJECT_ROOT when set', () => {
    expect(
      translatePathForNestedDocker('/app', mappings, {
        projectRoot: '/app',
        hostProjectRootEnv: '/home/deploy/stack/nanoclaw',
      }),
    ).toBe('/home/deploy/stack/nanoclaw');
  });
});
