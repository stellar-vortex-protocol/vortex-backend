/**
 * IP allowlist matching for scoped solver credentials (issue #443).
 *
 * A credential may be restricted to a set of source addresses. Entries may be:
 *
 *   - An exact IPv4 address, e.g. `203.0.113.7`.
 *   - An IPv4 CIDR block, e.g. `203.0.113.0/24`.
 *   - An exact IPv6 address, e.g. `2001:db8::1`.
 *   - The literal `*` to allow any source.
 *
 * Anything else — a typo, a hostname, an IPv6 CIDR — is treated as a
 * NON-match, never as a wildcard. An operator who mistypes an allowlist entry
 * locks their own credential out rather than silently opening it to the world,
 * and {@link describeAllowlistEntry} surfaces the reason in the API response.
 *
 * IPv6 CIDR blocks are deliberately not parsed: a partial IPv6 implementation
 * is more dangerous than none, since it would have to decide what to do with
 * the input it cannot understand. Use an exact IPv6 address instead.
 */

/** Result of parsing a single allowlist entry. */
export type AllowlistEntry =
  | { kind: "any" }
  | { kind: "ipv4"; address: number; prefix: number }
  | { kind: "ipv6"; address: bigint }
  | { kind: "invalid"; reason: string };

/**
 * Parse an IPv4 dotted-quad into a 32-bit unsigned integer.
 * Returns `null` for anything that is not exactly four 0-255 octets.
 */
export function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let address = 0;
  for (const part of parts) {
    // Reject empty octets, leading zeros ("01" is ambiguous: octal or decimal?)
    // and anything non-numeric, so a malformed entry can never parse as 0.0.0.0.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    address = (address << 8) | octet;
  }
  return address >>> 0;
}

/**
 * Parse an IPv6 address into a 128-bit unsigned integer.
 * Supports `::` compression and a trailing dotted-quad (e.g. `::ffff:1.2.3.4`).
 * Returns `null` if the text is not a well-formed IPv6 address.
 */
export function parseIpv6(value: string): bigint | null {
  if (!value.includes(":")) return null;

  // A trailing IPv4 form ("::ffff:192.0.2.1") becomes two hex groups.
  let text = value;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColon = text.indexOf("::");
  let head: string[];
  let rear: string[];

  if (doubleColon === -1) {
    head = text.split(":");
    rear = [];
  } else {
    if (text.indexOf("::", doubleColon + 1) !== -1) return null; // two "::"
    // "::" consumes two colons but only one of them is the separator belonging
    // to the head, so a head like "2001:db8::" arrives here as "2001:db8:".
    // Splitting that naively yields a trailing empty group, which would shift
    // the whole address by 16 bits.
    const before = text.slice(0, doubleColon).replace(/:$/, "");
    const after = text.slice(doubleColon + 2);
    head = before === "" ? [] : before.split(":");
    rear = after === "" ? [] : after.split(":");
  }

  const groupsToBigInt = (groups: string[]): bigint | null => {
    let acc = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      acc = (acc << 16n) | BigInt(parseInt(g, 16));
    }
    return acc;
  };

  const headValue = groupsToBigInt(head);
  const rearValue = groupsToBigInt(rear);
  if (headValue === null || rearValue === null) return null;

  const explicitGroups = head.length + rear.length;
  if (doubleColon === -1) {
    // Without "::" the address must be exactly eight groups.
    return explicitGroups === 8 ? headValue : null;
  }
  if (explicitGroups >= 8) return null; // "::" must stand for at least one group

  // The address is head | <missing zero groups> | rear. The head therefore has
  // to clear BOTH the elided groups and the rear groups to end up occupying the
  // most significant groups of the 128-bit address.
  const missingGroups = 8 - explicitGroups;
  const headShift = 16 * (missingGroups + rear.length);
  return (headValue << BigInt(headShift)) | rearValue;
}

/** Parse one allowlist entry into a comparable form. */
export function parseAllowlistEntry(entry: string): AllowlistEntry {
  const trimmed = entry.trim();
  if (trimmed === "*") return { kind: "any" };

  if (trimmed.includes("/")) {
    const [addr, prefixText, ...rest] = trimmed.split("/");
    if (rest.length > 0 || prefixText === undefined) {
      return { kind: "invalid", reason: "malformed CIDR" };
    }
    if (!/^[0-9]{1,3}$/.test(prefixText)) {
      return { kind: "invalid", reason: "malformed CIDR prefix" };
    }
    const prefix = Number(prefixText);
    const v4 = parseIpv4(addr);
    if (v4 !== null) {
      if (prefix > 32) return { kind: "invalid", reason: "IPv4 prefix must be 0-32" };
      return { kind: "ipv4", address: v4, prefix };
    }
    if (parseIpv6(addr) !== null) {
      return {
        kind: "invalid",
        reason: "IPv6 CIDR blocks are not supported; use an exact IPv6 address",
      };
    }
    return { kind: "invalid", reason: "not an IP address" };
  }

  const v4 = parseIpv4(trimmed);
  if (v4 !== null) return { kind: "ipv4", address: v4, prefix: 32 };

  const v6 = parseIpv6(trimmed);
  if (v6 !== null) return { kind: "ipv6", address: v6 };

  return { kind: "invalid", reason: "not an IP address or CIDR block" };
}

/** Whether `ip` is covered by a single already-parsed entry. */
function entryMatches(entry: AllowlistEntry, ip: AllowlistEntry): boolean {
  if (entry.kind === "any") return true;
  if (entry.kind === "invalid") return false;

  if (entry.kind === "ipv4") {
    if (ip.kind !== "ipv4") return false;
    if (entry.prefix === 0) return true;
    const mask = (0xffffffff << (32 - entry.prefix)) >>> 0;
    return (ip.address & mask) >>> 0 === (entry.address & mask) >>> 0;
  }

  // entry.kind === "ipv6" — an exact match, including IPv4-mapped addresses
  // which parse to the low 32 bits of the 128-bit space.
  if (ip.kind === "ipv4") {
    // `::ffff:a.b.c.d` is a.b.c.d mapped into the IPv6 space, so an allowlist
    // entry written that way still matches the plain IPv4 peer.
    const mapped = (0xffffn << 32n) | BigInt(ip.address >>> 0);
    return entry.address === 0n || entry.address === mapped;
  }
  return ip.kind === "ipv6" && ip.address === entry.address;
}

/**
 * Whether `ip` is permitted by `allowlist`.
 *
 * A `null` or empty allowlist means "no restriction" and matches every source,
 * because the restriction is opt-in. Otherwise the address must be covered by at
 * least one entry; entries that do not parse simply never match.
 */
export function ipMatchesAllowlist(
  ip: string | undefined | null,
  allowlist: string[] | null | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!ip) return false;

  // `::ffff:203.0.113.7` and `203.0.113.7` are the same host; Node reports
  // IPv4 peers in the mapped form when the socket is IPv6.
  const normalized = ip.startsWith("::ffff:") && !ip.includes(".") ? ip.slice(7) : ip;

  const parsedIp = (() => {
    const v4 = parseIpv4(normalized);
    if (v4 !== null) return { kind: "ipv4", address: v4, prefix: 32 } as AllowlistEntry;
    // An IPv4 peer can reach us in three textual forms depending on the socket
    // family: "203.0.113.7", "::ffff:203.0.113.7" and "::ffff:cb00:7107".
    // All three must compare equal, otherwise a dual-stack listener would
    // silently exclude a client that an IPv4-only allowlist intends to admit.
    if (normalized.startsWith("::ffff:")) {
      const tail = normalized.slice(7);
      const tailV4 = parseIpv4(tail) ?? (parseIpv6(tail) !== null && parseIpv6(tail)! <= 0xffffn
        ? Number(parseIpv6(tail))
        : null);
      if (tailV4 !== null) {
        return { kind: "ipv4", address: tailV4 >>> 0, prefix: 32 } as AllowlistEntry;
      }
    }
    const v6 = parseIpv6(normalized);
    if (v6 !== null) return { kind: "ipv6", address: v6 } as AllowlistEntry;
    return { kind: "invalid", reason: "not an IP address" } as AllowlistEntry;
  })();

  if (parsedIp.kind === "invalid") return false;
  return allowlist.some((entry) => entryMatches(parseAllowlistEntry(entry), parsedIp));
}

/** Human-readable explanation of an allowlist entry, for API responses and logs. */
export function describeAllowlistEntry(entry: string): string {
  const parsed = parseAllowlistEntry(entry);
  switch (parsed.kind) {
    case "any":
      return "wildcard (any source address)";
    case "ipv4":
      return `IPv4 ${parsed.prefix === 32 ? "address" : `CIDR /${parsed.prefix}`}`;
    case "ipv6":
      return "IPv6 address";
    case "invalid":
      return `invalid: ${parsed.reason}`;
  }
}
