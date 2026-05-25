/**
 * Unit tests for src/ui/auth.ts — token generation + constant-time check.
 */

import { describe, it, expect } from "vitest";
import { generateToken, checkToken } from "../../src/ui/auth.js";
import type { IncomingMessage } from "node:http";

function mkReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("auth", () => {
  it("generateToken produces a sufficiently random, url-safe string", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("checkToken accepts a Bearer header", () => {
    const t = generateToken();
    const req = mkReq({ authorization: `Bearer ${t}` });
    expect(checkToken(req, t, new URL("http://x/"))).toBe(true);
  });

  it("checkToken accepts a ?t= query param", () => {
    const t = generateToken();
    const url = new URL(`http://x/?t=${t}`);
    expect(checkToken(mkReq(), t, url)).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(checkToken(mkReq(), "expected", new URL("http://x/"))).toBe(false);
  });

  it("rejects a wrong token", () => {
    const t = generateToken();
    const req = mkReq({ authorization: `Bearer wrong-${t}` });
    expect(checkToken(req, t, new URL("http://x/"))).toBe(false);
  });

  it("rejects tokens of different length without crashing", () => {
    const req = mkReq({ authorization: "Bearer short" });
    expect(checkToken(req, "much-longer-expected-token", new URL("http://x/"))).toBe(false);
  });
});
