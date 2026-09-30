/**
 * AllowlistService unit tests.
 */

import { AllowlistService } from "./allowlist.service";

function buildService(envValue: string): AllowlistService {
  process.env.ABUSE_ALLOWLIST = envValue;
  const svc = new AllowlistService();
  delete process.env.ABUSE_ALLOWLIST;
  return svc;
}

describe("AllowlistService", () => {
  afterEach(() => {
    delete process.env.ABUSE_ALLOWLIST;
  });

  it("returns false when allowlist is empty", () => {
    const svc = buildService("");
    expect(svc.isAllowlisted({ userAddress: "GABC", clientIp: "1.2.3.4" })).toBe(false);
  });

  it("matches by Stellar address (case-insensitive)", () => {
    const svc = buildService("GABC123XYZ");
    expect(svc.isAllowlisted({ userAddress: "gabc123xyz", clientIp: "9.9.9.9" })).toBe(true);
  });

  it("matches by exact IP address", () => {
    const svc = buildService("192.168.1.1");
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "192.168.1.1" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "192.168.1.2" })).toBe(false);
  });

  it("matches by API key (key: prefix)", () => {
    const svc = buildService("key:my-secret-token");
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "my-secret-token" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "wrong-token" })).toBe(false);
  });

  it("supports multiple entries separated by commas", () => {
    const svc = buildService("GADDR1, 10.0.0.1, key:tok1");
    expect(svc.isAllowlisted({ userAddress: "gaddr1", clientIp: "9.9.9.9" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "10.0.0.1" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "tok1" })).toBe(true);
  });

  it("does not match a partial Stellar address", () => {
    const svc = buildService("GFULL");
    expect(svc.isAllowlisted({ userAddress: "GFULL_EXTRA", clientIp: "9.9.9.9" })).toBe(false);
  });
});
