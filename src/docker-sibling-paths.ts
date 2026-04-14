/**
 * When NanoClaw runs inside Docker with a mounted Docker socket, `docker run -v`
 * paths are resolved on the real host — not inside this container. Named volumes
 * appear as e.g. `/app/data` here but live under `/var/lib/docker/volumes/...` on
 * the host. Translate orchestrator paths to the daemon's bind source paths.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { logger } from './logger.js';

export interface DockerVolumePrefixMapping {
  /** Resolved absolute path as seen inside the orchestrator container */
  containerPrefix: string;
  /** Host path the Docker daemon uses for that mount */
  hostPrefix: string;
}

let cachedMappings: DockerVolumePrefixMapping[] | null = null;
let loadPromise: Promise<DockerVolumePrefixMapping[]> | null = null;

const DOCKER_SOCK = '/var/run/docker.sock';

function readOrchestratorContainerId(): string | null {
  try {
    const h = fs.readFileSync('/etc/hostname', 'utf8').trim();
    if (/^[a-f0-9]{12,64}$/i.test(h)) return h;
  } catch {
    /* not in container or unreadable */
  }
  const env = process.env.HOSTNAME?.trim();
  if (env && /^[a-f0-9]{12,64}$/i.test(env)) return env;
  return null;
}

function dockerGetJson(apiPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: apiPath,
        method: 'GET',
        headers: { Host: 'localhost' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Docker API GET ${apiPath} -> ${res.statusCode}: ${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body) as unknown);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function loadVolumeMappings(): Promise<DockerVolumePrefixMapping[]> {
  if (!fs.existsSync(DOCKER_SOCK)) {
    return [];
  }

  const id = readOrchestratorContainerId();
  if (!id) {
    return [];
  }

  try {
    const json = (await dockerGetJson(`/containers/${id}/json`)) as {
      Mounts?: Array<{
        Type: string;
        Source: string;
        Destination: string;
      }>;
    };
    const mounts = json.Mounts ?? [];
    const mappings: DockerVolumePrefixMapping[] = [];

    for (const m of mounts) {
      if (
        (m.Type === 'bind' || m.Type === 'volume') &&
        m.Source &&
        m.Destination
      ) {
        mappings.push({
          containerPrefix: path.resolve(m.Destination),
          hostPrefix: m.Source,
        });
      }
    }

    mappings.sort(
      (a, b) => b.containerPrefix.length - a.containerPrefix.length,
    );
    return mappings;
  } catch (err) {
    logger.debug(
      { err },
      'Could not inspect self for Docker volume path translation',
    );
    return [];
  }
}

/**
 * Load once; safe to call from every agent spawn. No-op when not applicable.
 */
export async function ensureDockerSiblingPathMappings(): Promise<void> {
  if (cachedMappings !== null) {
    return;
  }
  if (!loadPromise) {
    loadPromise = loadVolumeMappings().then((mappings) => {
      cachedMappings = mappings;
      if (mappings.length > 0) {
        logger.info(
          {
            count: mappings.length,
            prefixes: mappings.map(
              (m) => `${m.containerPrefix}→${m.hostPrefix}`,
            ),
          },
          'Sibling agent bind mounts: using host paths from Docker inspect',
        );
      }
      return mappings;
    });
  }
  await loadPromise;
}

/**
 * Pure translation for tests and for applying cached mappings.
 */
export function translatePathForNestedDocker(
  orchestratorAbsPath: string,
  mappings: DockerVolumePrefixMapping[],
  options: {
    projectRoot: string;
    hostProjectRootEnv?: string;
  },
): string {
  const abs = path.resolve(orchestratorAbsPath);
  for (const m of mappings) {
    if (
      abs === m.containerPrefix ||
      abs.startsWith(m.containerPrefix + path.sep)
    ) {
      const rel = path.relative(m.containerPrefix, abs);
      return path.join(m.hostPrefix, rel);
    }
  }

  const pr = path.resolve(options.projectRoot);
  const fallback = options.hostProjectRootEnv?.trim();
  if (fallback && abs === pr) {
    return path.resolve(fallback);
  }

  return abs;
}

/**
 * After `ensureDockerSiblingPathMappings()`, maps an orchestrator filesystem path
 * to the path the Docker daemon must use in `docker run -v`.
 */
export function translatePathForDockerCliHost(
  orchestratorPath: string,
  projectRoot: string = process.cwd(),
): string {
  const mappings = cachedMappings ?? [];
  return translatePathForNestedDocker(
    path.resolve(orchestratorPath),
    mappings,
    {
      projectRoot,
      hostProjectRootEnv: process.env.NANOCLAW_DOCKER_HOST_PROJECT_ROOT,
    },
  );
}

/** Test helper: reset module cache */
export function resetDockerSiblingPathCacheForTests(): void {
  cachedMappings = null;
  loadPromise = null;
}
