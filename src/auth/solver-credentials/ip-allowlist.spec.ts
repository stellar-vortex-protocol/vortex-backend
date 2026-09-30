import {
  describeAllowlistEntry,
  ipMatchesAllowlist,
  parseAllowlistEntry,
  parseIpv4,
  parseIpv6,
} from "./ip-allowlist";

describe("parseIpv4", () => {
  it("parses dotted quads", () => {
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("203.0.113.7")).toBe(3405803783);
    expect(parseIpv4("255.255.255.255")).toBe(4294967295);
  });

  it.each([
    ["", "empty"],
    ["1.2.3", "too few octets"],
    ["1.2.3.4.5", "too many octets"],
    ["256.1.1.1", "octet out of range"],
    ["1.2.3.256", "octet out of range"],
    ["01.2.3.4", "leading zero is ambiguous"],
    ["1.2.3.", "empty octet"],
    ["1.2.3.x", "non-numeric"],
    ["1.2.3.-4", "negative"],
    [" 1.2.3.4", "leading whitespace"],
  ])("rejects %s (%s)", (input) => {
    expect(parseIpv4(input)).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("parses full addresses", () => {
    // 2001:0db8:0000:0000:0000:0000:0000:0001 as one 128-bit integer.
    expect(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")?.toString(16)).toBe(
      "20010db8000000000000000000000001",
    );
  });

  it("parses :: compression", () => {
    expect(parseIpv6("::1")).toBe(1n);
    // The compressed form must equal the expanded one — this is the assertion
    // that catches a head/tail misalignment in the "::" expansion.
    expect(parseIpv6("2001:db8::1")).toBe(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001"));
  });

  it("compresses a head and a tail around the elided groups", () => {
    // 2001:db8:1:2:3::6:7 — "::" stands for exactly one zero group.
    expect(parseIpv6("2001:db8:1:2:3::6:7")?.toString(16)).toBe("20010db8000100020003000000060007");
  });

  it("rejects a '::' that would stand for zero groups", () => {
    // Eight explicit groups plus a "::" is over-long, not a valid spelling.
    expect(parseIpv6("2001:db8:1:2:3:4::5:6")).toBeNull();
  });

  it("parses the unspecified address", () => {
    expect(parseIpv6("::")).toBe(0n);
  });

  it("parses a trailing dotted quad", () => {
    expect(parseIpv6("::ffff:192.0.2.1")).toBe(parseIpv6("::ffff:c000:201"));
  });

  it.each([
    ["2001:db8", "too few groups without ::"],
    ["1:2:3:4:5:6:7:8:9", "too many groups"],
    ["1::2::3", "two ::"],
    ["2001:db8:::1", "malformed ::"],
    ["2001:db8:zzzz::1", "non-hex group"],
    ["2001:db8:12345::1", "group too long"],
  ])("rejects %s (%s)", (input) => {
    expect(parseIpv6(input)).toBeNull();
  });
});

describe("parseAllowlistEntry", () => {
  it("recognises the wildcard", () => {
    expect(parseAllowlistEntry("*")).toEqual({ kind: "any" });
  });

  it("treats a bare IPv4 address as a /32", () => {
    expect(parseAllowlistEntry("203.0.113.7")).toEqual({
      kind: "ipv4",
      address: parseIpv4("203.0.113.7"),
      prefix: 32,
    });
  });

  it("parses an IPv4 CIDR block", () => {
    expect(parseAllowlistEntry("203.0.113.0/24")).toEqual({
      kind: "ipv4",
      address: parseIpv4("203.0.113.0"),
      prefix: 24,
    });
  });

  it("rejects an out-of-range IPv4 prefix instead of clamping it", () => {
    const entry = parseAllowlistEntry("203.0.113.0/33");
    expect(entry.kind).toBe("invalid");
  });

  it("refuses IPv6 CIDR rather than guessing at the semantics", () => {
    const entry = parseAllowlistEntry("2001:db8::/32");
    expect(entry.kind).toBe("invalid");
    if (entry.kind === "invalid") expect(entry.reason).toMatch(/IPv6 CIDR/);
  });

  it("rejects hostnames", () => {
    expect(parseAllowlistEntry("solver.example.com").kind).toBe("invalid");
  });
});

describe("ipMatchesAllowlist", () => {
  describe("no restriction", () => {
    it("allows any source when the allowlist is null", () => {
      expect(ipMatchesAllowlist("198.51.100.1", null)).toBe(true);
    });

    it("allows any source when the allowlist is empty", () => {
      expect(ipMatchesAllowlist("198.51.100.1", [])).toBe(true);
    });
  });

  describe("exact IPv4", () => {
    const list = ["203.0.113.7"];

    it("matches the listed address", () => {
      expect(ipMatchesAllowlist("203.0.113.7", list)).toBe(true);
    });

    it("does not match a different address", () => {
      expect(ipMatchesAllowlist("203.0.113.8", list)).toBe(false);
    });

    it("does not match a prefix-sharing address", () => {
      expect(ipMatchesAllowlist("203.0.113.70", list)).toBe(false);
    });
  });

  describe("IPv4 CIDR", () => {
    const list = ["203.0.113.0/24"];

    it("matches inside the block", () => {
      expect(ipMatchesAllowlist("203.0.113.1", list)).toBe(true);
      expect(ipMatchesAllowlist("203.0.113.255", list)).toBe(true);
    });

    it("does not match outside the block", () => {
      expect(ipMatchesAllowlist("203.0.114.1", list)).toBe(false);
      expect(ipMatchesAllowlist("203.0.112.255", list)).toBe(false);
    });

    it("honours the prefix length, not just the /24 case", () => {
      expect(ipMatchesAllowlist("203.0.113.7", ["203.0.0.0/8"])).toBe(true);
      expect(ipMatchesAllowlist("203.0.113.7", ["203.0.113.0/25"])).toBe(true);
      expect(ipMatchesAllowlist("203.0.113.200", ["203.0.113.0/25"])).toBe(false);
    });

    it("treats /0 as every IPv4 source", () => {
      expect(ipMatchesAllowlist("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    });
  });

  describe("IPv6", () => {
    it("matches an exact IPv6 address", () => {
      expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::1"])).toBe(true);
    });

    it("does not match a different IPv6 address", () => {
      expect(ipMatchesAllowlist("2001:db8::2", ["2001:db8::1"])).toBe(false);
    });

    it("matches an IPv4 peer against its ::ffff:-mapped entry", () => {
      // Node reports IPv4 peers in this form on a dual-stack listener.
      expect(ipMatchesAllowlist("::ffff:203.0.113.7", ["::ffff:203.0.113.7"])).toBe(true);
    });

    it("normalises a ::ffff:-mapped peer back to its IPv4 form", () => {
      expect(ipMatchesAllowlist("::ffff:203.0.113.7", ["203.0.113.7"])).toBe(true);
      expect(ipMatchesAllowlist("::ffff:203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    });
  });

  describe("fail-closed behaviour", () => {
    it("does not match when the entry is a hostname", () => {
      expect(ipMatchesAllowlist("203.0.113.7", ["solver.example.com"])).toBe(false);
    });

    it("does not match when every entry is unparseable", () => {
      expect(ipMatchesAllowlist("203.0.113.7", ["nonsense", "also-nonsense"])).toBe(false);
    });

    it("does not match when the client address is missing", () => {
      expect(ipMatchesAllowlist(undefined, ["203.0.113.7"])).toBe(false);
    });

    it("does not match when the client address is itself unparseable", () => {
      expect(ipMatchesAllowlist("not-an-ip", ["*"])).toBe(false);
    });

    it("allows a valid entry alongside an unparseable one", () => {
      expect(ipMatchesAllowlist("203.0.113.7", ["nonsense", "203.0.113.0/24"])).toBe(true);
    });
  });

  describe("wildcard", () => {
    it("allows any parseable source", () => {
      expect(ipMatchesAllowlist("203.0.113.7", ["*"])).toBe(true);
      expect(ipMatchesAllowlist("2001:db8::1", ["*"])).toBe(true);
    });
  });
});

describe("describeAllowlistEntry", () => {
  it("describes each supported form", () => {
    expect(describeAllowlistEntry("*")).toMatch(/wildcard/);
    expect(describeAllowlistEntry("203.0.113.7")).toMatch(/IPv4 address/);
    expect(describeAllowlistEntry("203.0.113.0/24")).toMatch(/CIDR \/24/);
    expect(describeAllowlistEntry("2001:db8::1")).toMatch(/IPv6 address/);
  });

  it("surfaces why an entry was rejected", () => {
    expect(describeAllowlistEntry("solver.example.com")).toMatch(/invalid/);
    expect(describeAllowlistEntry("2001:db8::/32")).toMatch(/IPv6 CIDR/);
  });
});
