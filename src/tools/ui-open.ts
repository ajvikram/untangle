/**
 * Tool: ui_open — return the URL of the embedded UI server.
 * Returns null if the UI server was not started (e.g., headless mode).
 */

let _server: { url: string; port: number; token: string; staticRoot: string | null } | null = null;

export function registerUiServer(server: { url: string; port: number; token: string; staticRoot: string | null }): void {
  _server = server;
}

export interface UiOpenInput {
  /** Optional in-app path to deep-link to (e.g., "/proposals/abc"). */
  path?: string;
}

export interface UiOpenOutput {
  schemaVersion: "1";
  enabled: boolean;
  url: string | null;
  port: number | null;
  token: string | null;
  hasUi: boolean;
  hint?: string;
}

export async function uiOpen(input: UiOpenInput = {}): Promise<UiOpenOutput> {
  if (!_server) {
    return {
      schemaVersion: "1",
      enabled: false,
      url: null,
      port: null,
      token: null,
      hasUi: false,
      hint: "UI server is not running. Set UNTANGLE_UI=0 to disable explicitly, or start the MCP server in a host that supports stdio.",
    };
  }
  const sep = _server.url.includes("?") ? "&" : "?";
  const base = _server.url.split("?")[0]!;
  const tokenQs = `t=${encodeURIComponent(_server.token)}`;
  const url = input.path
    ? `${base}#${input.path.startsWith("/") ? input.path : "/" + input.path}${sep}${tokenQs}`
    : _server.url;
  // Cleaner form: append token via query, deep-link via hash
  const finalUrl = input.path
    ? `http://127.0.0.1:${_server.port}/?${tokenQs}#${input.path.startsWith("/") ? input.path : "/" + input.path}`
    : url;
  return {
    schemaVersion: "1",
    enabled: true,
    url: finalUrl,
    port: _server.port,
    token: _server.token,
    hasUi: _server.staticRoot !== null,
    hint: _server.staticRoot === null
      ? "API is up but the built UI bundle was not found (dist/ui or ui/dist). Run `npm run build:ui` to enable the visual dashboard."
      : undefined,
  };
}
