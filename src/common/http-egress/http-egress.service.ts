import { request, Agent, Dispatcher } from 'undici';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { lookup } from 'node:dns/promises';

export enum EgressPurpose {
  WEBHOOK = 'webhook',
  RPC = 'rpc',
  HORIZON = 'horizon',
  ORACLE = 'oracle',
  ARCHIVAL = 'archival',
  GENERIC = 'generic',
}

export interface EgressConfig {
  timeoutMs: number;
  maxRedirects: number;
  maxBodySizeBytes: number;
  allowlist?: string[];
  blockPrivateRanges: boolean;
}

export interface EgressResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  bodyBytes: number;
  finalUrl: string;
  ipUsed: string;
}

const PRIVATE_IPV4_RANGES = [
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
];

const METADATA_IPS = [
  '169.254.169.254',
  '169.254.169.253',
  'fd00:ec2::254',
];

const LOOPBACK_IPS = ['127.0.0.0', '127.0.0.1', '::1'];

export class HttpEgressService {
  private readonly agent: Agent;
  private readonly config: EgressConfig;

  constructor(config: EgressConfig) {
    this.config = config;
    this.agent = new Agent({
      connect: {
        timeout: config.timeoutMs,
      },
      bodyTimeout: config.timeoutMs,
      headersTimeout: config.timeoutMs,
    });
  }

  async fetch(url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    purpose?: EgressPurpose;
  }): Promise<EgressResponse> {
    const purpose = options?.purpose ?? EgressPurpose.GENERIC;
    const method = options?.method ?? 'GET';
    const headers = options?.headers ?? {};
    const body = options?.body;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Invalid URL: ${message}`);
    }

    if (this.config.allowlist && this.config.allowlist.length > 0) {
      this.checkAllowlist(parsedUrl.hostname, this.config.allowlist);
    }

    const resolvedIp = await this.resolveAndValidateIp(parsedUrl.hostname);

    if (this.config.blockPrivateRanges) {
      this.validateIpAddress(resolvedIp);
    }

    const requestUrl = new URL(parsedUrl);
    requestUrl.hostname = resolvedIp;
    requestUrl.host = resolvedIp + (parsedUrl.port ? ':' + parsedUrl.port : '');

    const requestHeaders = { ...headers, Host: parsedUrl.hostname };

    const response = await this.makeRequest(requestUrl, resolvedIp, {
      method,
      headers: requestHeaders,
      body,
      maxRedirects: this.config.maxRedirects,
    });

    if (response.bodyBytes > this.config.maxBodySizeBytes) {
      throw new Error(
        `Response body size ${response.bodyBytes} exceeds limit ${this.config.maxBodySizeBytes}`
      );
    }

    return response;
  }

  private checkAllowlist(hostname: string, allowlist: string[]): void {
    const isAllowed = allowlist.some(allowed => {
      if (hostname === allowed) return true;
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1);
        return hostname.endsWith(suffix);
      }
      return false;
    });

    if (!isAllowed) {
      throw new Error(`Hostname ${hostname} not in allowlist`);
    }
  }

  private async resolveAndValidateIp(hostname: string): Promise<string> {
    if (isIP(hostname) !== 0) {
      return hostname;
    }

    const [first, second] = await Promise.all([
      lookup(hostname, { family: 4 }),
      lookup(hostname, { family: 4 }),
    ]);

    if (first.address !== second.address) {
      throw new Error('DNS rebinding detected: IP changed between resolutions');
    }

    return first.address;
  }

  private validateIpAddress(ip: string): void {
    if (LOOPBACK_IPS.includes(ip) || ip.startsWith('127.')) {
      throw new Error(`Loopback address blocked: ${ip}`);
    }

    if (METADATA_IPS.includes(ip)) {
      throw new Error(`Cloud metadata endpoint blocked: ${ip}`);
    }

    if (ip === '::1' || ip.startsWith('::ffff:127.')) {
      throw new Error(`IPv6 loopback blocked: ${ip}`);
    }

    if (ip.startsWith('::ffff:')) {
      const ipv4 = ip.slice(7);
      this.validateIpv4Range(ipv4);
      return;
    }

    if (isIPv4(ip)) {
      this.validateIpv4Range(ip);
      return;
    }

    if (isIPv6(ip)) {
      if (ip.startsWith('fc') || ip.startsWith('fd')) {
        throw new Error(`IPv6 private range blocked: ${ip}`);
      }
      if (ip.startsWith('fe80:') || ip.startsWith('fe8')) {
        throw new Error(`IPv6 link-local blocked: ${ip}`);
      }
    }
  }

  private validateIpv4Range(ip: string): void {
    const normalized = this.normalizeIpAddress(ip);
    if (!normalized) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }

    const ipNum = this.ipToNumber(normalized);

    for (const range of PRIVATE_IPV4_RANGES) {
      const start = this.ipToNumber(range.start);
      const end = this.ipToNumber(range.end);
      if (ipNum >= start && ipNum <= end) {
        throw new Error(`Private IPv4 range blocked: ${ip}`);
      }
    }

    const linkLocalStart = this.ipToNumber('169.254.0.0');
    const linkLocalEnd = this.ipToNumber('169.254.255.255');
    if (ipNum >= linkLocalStart && ipNum <= linkLocalEnd) {
      throw new Error(`Link-local IPv4 blocked: ${ip}`);
    }
  }

  private normalizeIpAddress(ip: string): string | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    for (const part of parts) {
      if (part.length > 1 && part.startsWith('0')) {
        return null;
      }
      if (part.length > 3) {
        return null;
      }
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return null;
      }
    }

    return ip;
  }

  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  }

  private async makeRequest(
    url: URL,
    initialIp: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string | Buffer;
      maxRedirects: number;
    }
  ): Promise<EgressResponse> {
    let redirects = 0;
    let currentUrl = url;
    let lastIp = initialIp;
    let lastResponse: Dispatcher.ResponseData | null = null;

    while (redirects <= options.maxRedirects) {
      const response = await request(currentUrl, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        dispatcher: this.agent,
      });

      lastResponse = response;

      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        redirects++;
        const location = response.headers['location'];
        if (!location) {
          throw new Error('Redirect without Location header');
        }

        try {
          currentUrl = new URL(location, url);
          
          const resolvedIp = await this.resolveAndValidateIp(currentUrl.hostname);
          if (this.config.blockPrivateRanges) {
            this.validateIpAddress(resolvedIp);
          }
          
          lastIp = resolvedIp;
          options.headers.Host = currentUrl.hostname;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          throw new Error(`Invalid redirect URL: ${message}`);
        }
        continue;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        chunks.push(chunk);
      }
      const bodyBuffer = Buffer.concat(chunks);

      return {
        statusCode: response.statusCode,
        headers: response.headers as Record<string, string | string[]>,
        body: bodyBuffer.toString('utf8'),
        bodyBytes: bodyBuffer.length,
        finalUrl: currentUrl.toString(),
        ipUsed: lastIp,
      };
    }

    throw new Error(`Too many redirects (${redirects})`);
  }
}