/**
 * Discover the user's workspace root automatically.
 *
 * Strategy, in order:
 *   1. Ask the MCP host via `roots/list` (the standard way — Cursor / Claude
 *      Desktop / Continue / Cline forward this).
 *   2. Walk up from process.cwd() looking for `.git/`.
 *   3. Fall back to process.cwd() unchanged.
 *
 * Result is cached for the lifetime of the process (workspace doesn't change
 * mid-session). Callers can pass an explicit `repo` arg to override.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";

type ServerLike = {
  listRoots?: (params?: object) => Promise<{ roots?: Array<{ uri?: string; name?: string }> } | undefined>;
};

let _server: ServerLike | null = null;
let _cached: string | null = null;
let _resolved = false;
let _inflight: Promise<string> | null = null;

export function registerServerForWorkspace(server: ServerLike): void {
  _server = server;
}

/**
 * Returns a best-guess workspace path. Never throws — falls back to cwd.
 * Use this for *defaults*, not for hard requirements.
 */
export async function discoverWorkspaceRoot(): Promise<string> {
  if (_resolved && _cached) return _cached;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const found = await detect();
    _cached = found;
    _resolved = true;
    _inflight = null;
    return found;
  })();
  return _inflight;
}

/** Synchronous variant — returns the cached value or cwd if not yet resolved. */
export function workspaceRootSync(): string {
  return _cached ?? process.cwd();
}

async function detect(): Promise<string> {
  // 1. MCP roots/list — the spec-blessed way.
  if (_server && typeof _server.listRoots === "function") {
    try {
      const res = await _server.listRoots();
      const uri = res?.roots?.[0]?.uri;
      if (typeof uri === "string") {
        const path = uri.replace(/^file:\/\//, "");
        if (path && existsSync(path)) {
          logger.info("workspace_discovered", { source: "mcp_roots", path });
          return path;
        }
      }
    } catch (err) {
      // Host doesn't support roots, or no roots are declared. Fall through.
      logger.info("workspace_roots_unavailable", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Walk up from cwd looking for a .git directory.
  const cwd = process.cwd();
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, ".git"))) {
      logger.info("workspace_discovered", { source: "git_walkup", path: dir });
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Fall back to cwd unchanged.
  logger.info("workspace_discovered", { source: "cwd", path: cwd });
  return cwd;
}

/** Test-only: reset the cache. */
export function _resetWorkspaceCache(): void {
  _server = null;
  _cached = null;
  _resolved = false;
  _inflight = null;
}
