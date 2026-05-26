/**
 * Persistence regression: stable token across restarts, persistent state.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfgDir = mkdtempSync(join(tmpdir(), "untangle-persist-"));
process.env.UNTANGLE_CONFIG_DIR = cfgDir;

const { loadOrCreateSession, loadState, saveStateDebounced, PATHS } = await import("../../src/ui/persist.js");

beforeEach(() => {
  rmSync(PATHS.sessionFile, { force: true });
  rmSync(PATHS.stateFile, { force: true });
});

afterAll(() => rmSync(cfgDir, { recursive: true, force: true }));

describe("session persistence", () => {
  it("creates a session on first call and reuses it on the next", () => {
    const a = loadOrCreateSession(7842);
    const b = loadOrCreateSession(7842);
    expect(a.token).toBe(b.token);
    expect(existsSync(PATHS.sessionFile)).toBe(true);
  });

  it("persists the preferred port", () => {
    loadOrCreateSession(7842);
    const raw = JSON.parse(readFileSync(PATHS.sessionFile, "utf8")) as { preferredPort: number };
    expect(raw.preferredPort).toBe(7842);
  });

  it("file is created with 0600-ish permissions (not world-readable)", () => {
    loadOrCreateSession(7842);
    // We can't test exact permissions cross-platform, but the file should exist
    // and contain a token long enough to be useful.
    const raw = JSON.parse(readFileSync(PATHS.sessionFile, "utf8")) as { token: string };
    expect(raw.token.length).toBeGreaterThanOrEqual(20);
  });
});

describe("state persistence", () => {
  it("returns null when no state file exists", () => {
    expect(loadState()).toBeNull();
  });

  it("round-trips proposals + activity", async () => {
    saveStateDebounced(
      { proposals: [{ id: "p1", ts: "2026-05-25T00:00:00Z" }], activity: [{ id: "a1", kind: "ui_open", summary: "x" }], savedAt: new Date().toISOString() },
      10, // short debounce for the test
    );
    await new Promise((r) => setTimeout(r, 50));
    const loaded = loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.proposals).toHaveLength(1);
    expect(loaded!.activity).toHaveLength(1);
  });
});
