import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, LookupAddress } from "node:dns";

/**
 * SSRF protection for webhook targets (issue #432).
 *
 * A webhook URL is attacker-controlled input that the server will fetch, so
 * it is checked twice:
 *
 *  1. at registration / update ({@link assertWebhookUrlAllowed}) — scheme,
 *     credentials, hostname, and every address it currently resolves to;
 *  2. at connect time ({@link ssrfSafeLookup}) — the delivery agent resolves
 *     the hostname itself and refuses to connect if *any* returned address is
 *     non-public. Connecting to the address that was just checked (instead of
 *     letting the HTTP client resolve again) closes the DNS-rebinding window,
 *     while TLS still verifies the certificate against the original hostname.
 *
 * Redirects are never followed by the delivery client: a 3xx is a failed
 * attempt, so a public endpoint cannot bounce a request into the network.
 *
 * See https://owasp.org/www-community/attacks/Server_Side_Request_Forgery.
 */

export class WebhookUrlRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "WebhookUrlRejectedError";
  }
}

/** Non-public address space: private, loopback, link-local (incl. cloud metadata), CGNAT, reserved, multicast. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 metadata)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** Hostnames that name internal services regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i, /^metadata\.google\.internal$/i];

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6 address. */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `ip` is not a public unicast address. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return BLOCKED.check(v4, "ipv4");
    return BLOCKED.check(bare, "ipv6");
  }
  return true;
}

export interface WebhookUrlPolicy {
  /** Allow http:// and non-public targets — local development only. */
  allowInsecure: boolean;
  /** Resolver, injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

const defaultResolve = (hostname: string): Promise<string[]> =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) =>
      err ? reject(err) : resolve(addresses.map((a) => a.address)),
    ),
  );

/**
 * Validate a webhook URL before it is stored. Returns the normalised URL.
 * Throws {@link WebhookUrlRejectedError} with a client-safe reason.
 */
export async function assertWebhookUrlAllowed(raw: string, policy: WebhookUrlPolicy): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlRejectedError("Webhook URL is not a valid absolute URL", "invalid_url");
  }
  if (url.protocol !== "https:" && !(policy.allowInsecure && url.protocol === "http:")) {
    throw new WebhookUrlRejectedError("Webhook URL must use https", "insecure_scheme");
  }
  if (url.username || url.password) {
    throw new WebhookUrlRejectedError("Webhook URL must not embed credentials", "credentials_in_url");
  }
  if (raw.length > 2048) throw new WebhookUrlRejectedError("Webhook URL is too long", "url_too_long");
  url.hash = "";

  if (policy.allowInsecure) return url.toString();

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.some((re) => re.test(hostname))) {
    throw new WebhookUrlRejectedError("Webhook URL points at an internal hostname", "internal_hostname");
  }
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (policy.resolve ?? defaultResolve)(hostname);
    } catch {
      throw new WebhookUrlRejectedError("Webhook hostname does not resolve", "unresolvable");
    }
  }
  if (addresses.length === 0) throw new WebhookUrlRejectedError("Webhook hostname does not resolve", "unresolvable");
  if (addresses.some(isBlockedAddress)) {
    throw new WebhookUrlRejectedError("Webhook URL resolves to a private, loopback or reserved address", "private_address");
  }
  return url.toString();
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `net.connect`-compatible lookup for the delivery agent: resolves, rejects
 * the connection when any address is non-public, and hands the socket the
 * addresses it just validated.
 */
export function ssrfSafeLookup(allowInsecure: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void => {
    const opts = typeof options === "number" ? { family: options } : options;
    dnsLookup(hostname, { all: true, verbatim: true, family: opts.family as 0 | 4 | 6 | undefined }, (err, addresses) => {
      if (err) return callback(err, opts.all ? [] : "", 0);
      const list = addresses as LookupAddress[];
      if (!allowInsecure && (list.length === 0 || list.some((a) => isBlockedAddress(a.address)))) {
        const blocked = Object.assign(new Error(`SSRF blocked: ${hostname} resolves to a non-public address`), {
          code: "ESSRFBLOCKED",
        });
        return callback(blocked, opts.all ? [] : "", 0);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}
