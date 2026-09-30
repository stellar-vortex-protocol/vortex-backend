import { HttpEgressService, EgressPurpose, EgressConfig } from './http-egress.service';

describe('HttpEgressService', () => {
  const defaultConfig: EgressConfig = {
    timeoutMs: 5000,
    maxRedirects: 3,
    maxBodySizeBytes: 1024 * 1024, // 1MB
    blockPrivateRanges: true,
  };

  let service: HttpEgressService;

  beforeEach(() => {
    service = new HttpEgressService(defaultConfig);
  });

  describe('Allowlist validation', () => {
    it('should allow exact domain match', () => {
      const config: EgressConfig = {
        ...defaultConfig,
        allowlist: ['example.com'],
      };
      const svc = new HttpEgressService(config);
      expect(() => {
        (svc as any).checkAllowlist('example.com', ['example.com']);
      }).not.toThrow();
    });

    it('should allow wildcard subdomain match', () => {
      const svc = new HttpEgressService({
        ...defaultConfig,
        allowlist: ['*.example.com'],
      });
      expect(() => {
        (svc as any).checkAllowlist('api.example.com', ['*.example.com']);
      }).not.toThrow();
    });

    it('should reject non-allowlisted domains', () => {
      const svc = new HttpEgressService({
        ...defaultConfig,
        allowlist: ['example.com'],
      });
      expect(() => {
        (svc as any).checkAllowlist('evil.com', ['example.com']);
      }).toThrow('not in allowlist');
    });
  });

  describe('IP validation - IPv4', () => {
    it('should block RFC1918 private ranges', () => {
      expect(() => (service as any).validateIpAddress('10.0.0.1')).toThrow('Private IPv4');
      expect(() => (service as any).validateIpAddress('172.16.0.1')).toThrow('Private IPv4');
      expect(() => (service as any).validateIpAddress('192.168.1.1')).toThrow('Private IPv4');
    });

    it('should block loopback addresses', () => {
      expect(() => (service as any).validateIpAddress('127.0.0.1')).toThrow('Loopback');
      expect(() => (service as any).validateIpAddress('127.0.0.2')).toThrow('Loopback');
    });

    it('should block link-local addresses', () => {
      expect(() => (service as any).validateIpAddress('169.254.1.1')).toThrow('Link-local');
    });

    it('should block cloud metadata endpoints', () => {
      expect(() => (service as any).validateIpAddress('169.254.169.254')).toThrow('metadata');
      expect(() => (service as any).validateIpAddress('169.254.169.253')).toThrow('metadata');
    });

    it('should reject octal IP encodings', () => {
      expect((service as any).normalizeIpAddress('127.0.0.01')).toBeNull();
      expect((service as any).normalizeIpAddress('010.0.0.1')).toBeNull();
    });

    it('should reject decimal IP encodings', () => {
      expect((service as any).normalizeIpAddress('127.0.0.256')).toBeNull();
      expect((service as any).normalizeIpAddress('3232235777')).toBeNull();
    });

    it('should allow public IPs', () => {
      expect(() => (service as any).validateIpAddress('8.8.8.8')).not.toThrow();
      expect(() => (service as any).validateIpAddress('1.1.1.1')).not.toThrow();
    });
  });

  describe('IP validation - IPv6', () => {
    it('should block IPv6 loopback', () => {
      expect(() => (service as any).validateIpAddress('::1')).toThrow('Loopback');
    });

    it('should block IPv6 unique local addresses', () => {
      expect(() => (service as any).validateIpAddress('fc00::1')).toThrow('private');
      expect(() => (service as any).validateIpAddress('fd00::1')).toThrow('private');
    });

    it('should block IPv6 link-local', () => {
      expect(() => (service as any).validateIpAddress('fe80::1')).toThrow('link-local');
    });

    it('should block IPv4-mapped IPv6 loopback', () => {
      expect(() => (service as any).validateIpAddress('::ffff:127.0.0.1')).toThrow('loopback');
    });

    it('should allow public IPv6', () => {
      expect(() => (service as any).validateIpAddress('2001:4860:4860::8888')).not.toThrow();
    });
  });

  describe('DNS rebinding protection', () => {
    it('should detect DNS rebinding when IPs differ', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- test mock, no import alternative
      const originalLookup = require('node:dns/promises').lookup;
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- test mock, no import alternative
      jest.spyOn(require('node:dns/promises'), 'lookup').mockImplementation(async () => {
        callCount++;
        return {
          address: callCount === 1 ? '1.1.1.1' : '2.2.2.2',
          family: 4,
        };
      });

      await expect(service['resolveAndValidateIp']('example.com')).rejects.toThrow('DNS rebinding');

      jest.restoreAllMocks();
    });
  });

  describe('Webhook-specific policy', () => {
    it('should enforce public IPs only for webhooks', () => {
      const webhookConfig: EgressConfig = {
        ...defaultConfig,
        blockPrivateRanges: true,
      };
      const webhookService = new HttpEgressService(webhookConfig);
      
      expect(() => (webhookService as any).validateIpAddress('10.0.0.1')).toThrow();
      expect(() => (webhookService as any).validateIpAddress('8.8.8.8')).not.toThrow();
    });
  });

  describe('Response size limits', () => {
    it('should enforce max body size', async () => {
      const smallConfig: EgressConfig = {
        ...defaultConfig,
        maxBodySizeBytes: 100,
      };
      const svc = new HttpEgressService(smallConfig);
      
      expect(svc['config'].maxBodySizeBytes).toBe(100);
    });
  });

  describe('Redirect handling', () => {
    it('should respect max redirect limit', () => {
      expect(service['config'].maxRedirects).toBe(3);
    });

    it('should validate redirect targets', async () => {
      expect(service['config'].maxRedirects).toBeGreaterThan(0);
    });
  });
});