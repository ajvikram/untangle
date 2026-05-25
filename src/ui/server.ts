/**
 * UI HTTP server.
 * - Binds to 127.0.0.1 on an ephemeral port.
 * - Every request requires a session token (Bearer or ?t=).
 * - Serves built static files from dist/ui when present, plus a JSON API and SSE stream.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, statSync, createReadStream, readFileSync } from "node:fs";
import { join, normalize, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateToken, checkToken } from "./auth.js";
import { startSseStream } from "./sse.js";
import { getStore } from "./state.js";
import { sendError, sendJson } from "./routes/util.js";
import {
  listProposals, getProposal, reproposeProposal, applyProposal,
} from "./routes/proposals.js";
import {
  listPrsRoute, viewPrRoute, diffPrRoute, checksPrRoute,
  reviewPrRoute, commentPrRoute, mergePrRoute, closePrRoute,
  reopenPrRoute, readyPrRoute, requestReviewersPrRoute, dismissReviewRoute,
} from "./routes/prs.js";
import {
  statusRoute, logRoute, branchRoute, diffRoute, showRoute,
  commitRoute, pushRoute, checkoutRoute,
} from "./routes/git.js";
import { logger } from "../util/logger.js";

export interface UiServer {
  server: Server;
  url: string;
  port: number;
  token: string;
  staticRoot: string | null;
  stop: () => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json; charset=utf-8",
};

function findStaticRoot(): string | null {
  // From compiled location dist/ui/server.js: ../../dist/ui-app
  // From source location  src/ui/server.ts:  ../../dist/ui-app
  const candidates = [
    resolve(__dirname, "../ui-app"),           // dist/ui/server.js → dist/ui-app/
    resolve(__dirname, "../../dist/ui-app"),   // dist/ui/server.js → <root>/dist/ui-app/
    resolve(__dirname, "../../../dist/ui-app"),
    resolve(process.cwd(), "dist/ui-app"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): boolean {
  // Resolve & normalize; reject traversal attempts
  const cleanPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(root, cleanPath === "/" || cleanPath === "" ? "index.html" : cleanPath);
  if (!filePath.startsWith(root)) {
    sendError(res, 403, "Forbidden");
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for non-asset paths
    const isAsset = /\.[a-z0-9]+$/i.test(pathname);
    if (isAsset) return false;
    filePath = join(root, "index.html");
    if (!existsSync(filePath)) return false;
  }
  const ext = extname(filePath).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function matchPath(pathname: string, pattern: string): RegExpMatchArray | null {
  // Convert simple :params and trailing * into regex
  const regex = "^" + pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, "(.*)")
    .replace(/:([a-zA-Z]+)/g, "([^/]+)") + "$";
  return pathname.match(new RegExp(regex));
}

export async function startUiServer(opts: { logUrl?: boolean } = {}): Promise<UiServer> {
  const token = generateToken();
  const staticRoot = findStaticRoot();
  const store = getStore();

  // Touch the singleton so its sessionId is stable from server start.
  void store.sessionId;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = url.pathname;

      // Public endpoints (no token): /healthz
      if (pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, sessionId: store.sessionId, startedAt: store.startedAt });
      }

      // Static assets and SPA shell are public — they're build output, not user data.
      // The token gates /api/* (and SSE) where all session data flows.
      const isApi = pathname.startsWith("/api/");
      if (isApi && !checkToken(req, token, url)) {
        return sendError(res, 401, "Missing or invalid session token");
      }

      // Session info
      if (pathname === "/api/session") {
        return sendJson(res, 200, {
          sessionId: store.sessionId,
          startedAt: store.startedAt,
        });
      }

      // SSE
      if (pathname === "/api/sse") {
        startSseStream(res);
        return;
      }

      // Activity feed
      if (pathname === "/api/activity") {
        const limit = url.searchParams.get("limit");
        return sendJson(res, 200, { activity: store.listActivity(limit ? Number(limit) : undefined) });
      }

      // -------------------------------------------------------------------
      // Proposals
      // -------------------------------------------------------------------
      if (pathname === "/api/proposals" && req.method === "GET") return listProposals(req, res);
      let m = matchPath(pathname, "/api/proposals/:id");
      if (m && req.method === "GET") return getProposal(req, res, m[1]!);
      m = matchPath(pathname, "/api/proposals/:id/repropose");
      if (m && req.method === "POST") return reproposeProposal(req, res, m[1]!);
      m = matchPath(pathname, "/api/proposals/:id/apply");
      if (m && req.method === "POST") return applyProposal(req, res, m[1]!);

      // -------------------------------------------------------------------
      // PRs
      // -------------------------------------------------------------------
      if (pathname === "/api/prs" && req.method === "GET") return listPrsRoute(req, res, url);
      m = matchPath(pathname, "/api/prs/:n");
      if (m && req.method === "GET") return viewPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/diff");
      if (m && req.method === "GET") return diffPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/checks");
      if (m && req.method === "GET") return checksPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/review");
      if (m && req.method === "POST") return reviewPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/comment");
      if (m && req.method === "POST") return commentPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/merge");
      if (m && req.method === "POST") return mergePrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/close");
      if (m && req.method === "POST") return closePrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/reopen");
      if (m && req.method === "POST") return reopenPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/ready");
      if (m && req.method === "POST") return readyPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/request-reviewers");
      if (m && req.method === "POST") return requestReviewersPrRoute(req, res, url, Number(m[1]));
      m = matchPath(pathname, "/api/prs/:n/dismiss-review");
      if (m && req.method === "POST") return dismissReviewRoute(req, res, url, Number(m[1]));

      // -------------------------------------------------------------------
      // Git
      // -------------------------------------------------------------------
      if (pathname === "/api/git/status" && req.method === "GET") return statusRoute(req, res, url);
      if (pathname === "/api/git/log"    && req.method === "GET") return logRoute(req, res, url);
      if (pathname === "/api/git/branch" && req.method === "GET") return branchRoute(req, res, url);
      if (pathname === "/api/git/diff"   && req.method === "GET") return diffRoute(req, res, url);
      m = matchPath(pathname, "/api/git/show/*");
      if (m && req.method === "GET") return showRoute(req, res, url, decodeURIComponent(m[1]!));
      if (pathname === "/api/git/commit"   && req.method === "POST") return commitRoute(req, res, url);
      if (pathname === "/api/git/push"     && req.method === "POST") return pushRoute(req, res, url);
      if (pathname === "/api/git/checkout" && req.method === "POST") return checkoutRoute(req, res, url);

      // -------------------------------------------------------------------
      // Static UI files (never serve SPA for /api/* — those should 404 explicitly)
      // -------------------------------------------------------------------
      if (staticRoot && !pathname.startsWith("/api/")) {
        if (serveStatic(req, res, staticRoot, pathname)) return;
      }

      // Token is valid but path is unknown
      return sendError(res, 404, `Not found: ${pathname}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("ui_request_error", { error: msg, url: req.url });
      try { sendError(res, 500, msg); } catch { /* response may already be sent */ }
    }
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectStart);
      resolveStart();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind UI server");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  if (opts.logUrl !== false) {
    // Print prominently to stderr so it appears in the MCP host logs
    process.stderr.write(`\n[untangle-ui] http://127.0.0.1:${port}/?t=${token}\n`);
  }
  logger.info("ui_server_started", { port, hasStatic: !!staticRoot });

  const stop = async (): Promise<void> => {
    await new Promise<void>((r) => server.close(() => r()));
    logger.info("ui_server_stopped", { port });
  };

  // Verify static root index loads cleanly at boot (no-op if missing — API still works)
  if (staticRoot) {
    try {
      const idx = readFileSync(join(staticRoot, "index.html"), "utf8");
      if (!idx.includes("<html")) logger.warn("ui_static_no_html", { path: staticRoot });
    } catch {
      // ignored
    }
  }

  return { server, url, port, token, staticRoot, stop };
}
