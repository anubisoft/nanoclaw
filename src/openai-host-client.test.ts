import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getContainerConfigMock = vi.fn();

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    getContainerConfig = getContainerConfigMock;
  },
}));

vi.mock('./config.js', () => ({
  ONECLI_URL: 'http://onecli.test',
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe('getHostOpenAIClient', () => {
  beforeEach(() => {
    vi.resetModules();
    getContainerConfigMock.mockReset();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('uses OPENAI_API_KEY when set', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct-test';
    const { getHostOpenAIClient } = await import('./openai-host-client.js');
    const c = await getHostOpenAIClient();
    expect(c).not.toBeNull();
    expect(getContainerConfigMock).not.toHaveBeenCalled();
  });

  it('builds client from OneCLI proxy config when key is unset', async () => {
    getContainerConfigMock.mockResolvedValue({
      env: {
        HTTPS_PROXY: 'http://x:tok@host.docker.internal:10255',
      },
      caCertificate:
        '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      caCertificateContainerPath: '/tmp/onecli-gateway-ca.pem',
    });
    const { getHostOpenAIClient } = await import('./openai-host-client.js');
    const c = await getHostOpenAIClient();
    expect(c).not.toBeNull();
    expect(getContainerConfigMock).toHaveBeenCalledTimes(1);
  });
});
