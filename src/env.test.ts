import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  const origCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join('/tmp', 'nanoclaw-env-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try {
      fs.rmSync(tmp, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('fills missing keys from process.env when file omits them', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'ONLY_IN_FILE=1\n', 'utf-8');
    process.env.FOO_FROM_ENV = 'from-process-env';
    try {
      const r = readEnvFile(['ONLY_IN_FILE', 'FOO_FROM_ENV']);
      expect(r.ONLY_IN_FILE).toBe('1');
      expect(r.FOO_FROM_ENV).toBe('from-process-env');
    } finally {
      delete process.env.FOO_FROM_ENV;
    }
  });

  it('prefers file over process.env when both set', () => {
    process.env.FOO_FROM_ENV = 'from-process-env';
    try {
      fs.writeFileSync(
        path.join(tmp, '.env'),
        'FOO_FROM_ENV=from-file\n',
        'utf-8',
      );
      const r = readEnvFile(['FOO_FROM_ENV']);
      expect(r.FOO_FROM_ENV).toBe('from-file');
    } finally {
      delete process.env.FOO_FROM_ENV;
    }
  });
});
