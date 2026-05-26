/**
 * Persistent state for the UI session.
 *   ~/.config/untangle/session.json  — stable token + last-used port
 *   ~/.config/untangle/state.json    — proposals + activity log
 *
 * Survives MCP server restarts so bookmarks keep working and the dashboard
 * isn't empty on reload. Best-effort: read failures are non-fatal.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "../util/logger.js";

/** Resolved lazily so tests can set UNTANGLE_CONFIG_DIR before persist is touched. */
function configDir(): string {
  if (process.env.UNTANGLE_CONFIG_DIR) return process.env.UNTANGLE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "untangle");
  return join(homedir(), ".config", "untangle");
}
const sessionFile = (): string => join(configDir(), "session.json");
const stateFile = (): string => join(configDir(), "state.json");

export interface PersistedSession {
  token: string;
  preferredPort: number;
  createdAt: string;
}

function ensureDir(): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function atomicWrite(path: string, data: string): void {
  ensureDir();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Force-rotate the persisted token (returns the new session). */
export function rotateSessionToken(): PersistedSession {
  const existing = existsSync(sessionFile())
    ? (JSON.parse(readFileSync(sessionFile(), "utf8")) as PersistedSession)
    : null;
  const next: PersistedSession = {
    token: randomBytes(24).toString("base64url"),
    preferredPort: existing?.preferredPort ?? 7842,
    createdAt: new Date().toISOString(),
  };
  atomicWrite(sessionFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Load (or create) the persistent session — same token across restarts. */
export function loadOrCreateSession(defaultPort = 7842): PersistedSession {
  try {
    if (existsSync(sessionFile())) {
      const parsed = JSON.parse(readFileSync(sessionFile(), "utf8")) as Partial<PersistedSession>;
      if (parsed.token && typeof parsed.token === "string" && parsed.token.length >= 20) {
        return {
          token: parsed.token,
          preferredPort: typeof parsed.preferredPort === "number" ? parsed.preferredPort : defaultPort,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    logger.warn("session_load_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const created: PersistedSession = {
    token: randomBytes(24).toString("base64url"),
    preferredPort: defaultPort,
    createdAt: new Date().toISOString(),
  };
  try {
    atomicWrite(sessionFile(), JSON.stringify(created, null, 2));
  } catch (err) {
    logger.warn("session_persist_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return created;
}

/** Update the persisted port (if the OS gave us a different one). */
export function updatePersistedPort(port: number): void {
  try {
    const existing = existsSync(sessionFile())
      ? (JSON.parse(readFileSync(sessionFile(), "utf8")) as PersistedSession)
      : null;
    if (existing) {
      existing.preferredPort = port;
      atomicWrite(sessionFile(), JSON.stringify(existing, null, 2));
    }
  } catch { /* non-fatal */ }
}

export interface PersistedState {
  proposals: unknown[];
  activity: unknown[];
  savedAt: string;
}

export function loadState(): PersistedState | null {
  try {
    if (!existsSync(stateFile())) return null;
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<PersistedState>;
    return {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("state_load_failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

let _saveTimer: NodeJS.Timeout | null = null;
let _pendingPayload: PersistedState | null = null;

/** Debounced save — multiple rapid updates collapse to one write. */
export function saveStateDebounced(payload: PersistedState, ms = 1000): void {
  _pendingPayload = payload;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    flushPendingState();
  }, ms);
}

/** Flush any pending debounced write synchronously. Safe to call from exit handlers. */
export function flushPendingState(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (!_pendingPayload) return;
  try {
    atomicWrite(stateFile(), JSON.stringify(_pendingPayload));
  } catch (err) {
    logger.warn("state_persist_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  _pendingPayload = null;
}

export const PATHS = {
  get configDir() { return configDir(); },
  get sessionFile() { return sessionFile(); },
  get stateFile() { return stateFile(); },
};
