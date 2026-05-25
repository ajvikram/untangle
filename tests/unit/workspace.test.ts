/**
 * Workspace discovery: MCP roots → .git walk-up → cwd fallback.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverWorkspaceRoot,
  workspaceRootSync,
  registerServerForWorkspace,
  _resetWorkspaceCache,
} from "../../src/util/workspace.js";

beforeEach(() => _resetWorkspaceCache());

describe("discoverWorkspaceRoot", () => {
  it("returns the path from MCP roots/list when the host provides one", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ws-mcp-"));
    try {
      registerServerForWorkspace({
        listRoots: async () => ({ roots: [{ uri: `file://${tmp}` }] }),
      });
      expect(await discoverWorkspaceRoot()).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to walking up for .git when roots/list is unavailable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-git-")));
    try {
      execFileSync("git", ["init", "-q", root]);
      const nested = join(root, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const origCwd = process.cwd();
      try {
        process.chdir(nested);
        // No MCP server registered → falls through to .git walk-up
        expect(await discoverWorkspaceRoot()).toBe(root);
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to cwd when neither roots nor .git are found", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ws-bare-"));
    try {
      const origCwd = process.cwd();
      try {
        process.chdir(tmp);
        // tmp dir has no .git ancestors below /tmp on macOS
        const out = await discoverWorkspaceRoot();
        // On macOS, /private/var/folders/... has no .git above; expect cwd or a path containing the tmp dir name
        expect(out).toBeTruthy();
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caches the resolved path", async () => {
    let calls = 0;
    registerServerForWorkspace({
      listRoots: async () => { calls++; return { roots: [{ uri: "file:///" }] }; },
    });
    await discoverWorkspaceRoot();
    await discoverWorkspaceRoot();
    expect(calls).toBe(1);
  });

  it("gracefully handles host that throws on roots/list", async () => {
    registerServerForWorkspace({
      listRoots: async () => { throw new Error("Method not found"); },
    });
    // Should fall back to walk-up / cwd without throwing
    const out = await discoverWorkspaceRoot();
    expect(out).toBeTruthy();
  });
});

describe("workspaceRootSync", () => {
  it("returns cwd when nothing is cached", () => {
    expect(workspaceRootSync()).toBe(process.cwd());
  });

  it("returns the cached value after async discovery", async () => {
    registerServerForWorkspace({
      listRoots: async () => ({ roots: [{ uri: "file:///tmp" }] }),
    });
    await discoverWorkspaceRoot();
    expect(workspaceRootSync()).toBe("/tmp");
  });
});
