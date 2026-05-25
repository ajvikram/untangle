/**
 * Unit tests for the UI HTTP server.
 * - 127.0.0.1 bind, ephemeral port, token auth
 * - SSE handshake
 * - State store + activity feed
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { getStore, _resetStore } from "../../src/ui/state.js";

let ui: UiServer;
let base: string;

async function get(path: string, opts: { token?: string | null; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token !== null) {
    headers["Authorization"] = `Bearer ${opts.token ?? ui.token}`;
  }
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
}

beforeAll(async () => {
  _resetStore();
  ui = await startUiServer({ logUrl: false });
  base = `http://127.0.0.1:${ui.port}`;
});
afterAll(async () => { await ui.stop(); });

describe("UI server: bind + healthz", () => {
  it("binds 127.0.0.1 only with an ephemeral port", () => {
    expect(ui.port).toBeGreaterThan(0);
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  });

  it("/healthz is public (no token required)", async () => {
    const res = await get("/healthz", { token: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});

describe("UI server: auth", () => {
  it("rejects API requests without a token", async () => {
    const res = await get("/api/session", { token: null });
    expect(res.status).toBe(401);
  });

  it("accepts Bearer token", async () => {
    const res = await get("/api/session");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId: expect.any(String) });
  });

  it("accepts ?t= query param token", async () => {
    const res = await fetch(`${base}/api/session?t=${ui.token}`);
    expect(res.status).toBe(200);
  });

  it("rejects wrong token", async () => {
    const res = await get("/api/session", { token: "not-the-real-token" });
    expect(res.status).toBe(401);
  });
});

describe("UI server: state store + activity", () => {
  it("activity endpoint returns recent events", async () => {
    getStore().logActivity({ kind: "ui_open", summary: "test activity" });
    const res = await get("/api/activity?limit=5");
    expect(res.status).toBe(200);
    const body = res.body as { activity: Array<{ summary: string }> };
    expect(body.activity.some((e) => e.summary === "test activity")).toBe(true);
  });

  it("proposals endpoint returns empty list when store is empty", async () => {
    _resetStore();
    const res = await get("/api/proposals");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proposals: [] });
  });

  it("404 for unknown API path with valid token", async () => {
    const res = await get("/api/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("UI server: SSE", () => {
  it("rejects SSE without token", async () => {
    const res = await fetch(`${base}/api/sse`);
    expect(res.status).toBe(401);
  });

  it("opens SSE with token and emits activity events", async () => {
    const res = await fetch(`${base}/api/sse?t=${ui.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    // Push an event after a tick
    setTimeout(() => {
      getStore().logActivity({ kind: "ui_open", summary: "sse-test" });
    }, 10);
    // Read until we see the event or hit a timeout
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      if (received.includes("sse-test")) break;
    }
    expect(received).toContain("event: activity");
    expect(received).toContain("sse-test");
    await reader.cancel();
  });
});
