/**
 * Routes for git introspection and mutations.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getStore } from "../state.js";
import {
  gitStatus, gitDiff, gitLog, gitShow, gitBranch,
  gitCommit, gitPush, gitCheckout,
} from "../../tools/git-ops.js";
import { readJsonBody, sendJson, sendError, sendText } from "./util.js";

function repoFromUrl(url: URL): string | undefined {
  return url.searchParams.get("repo") ?? undefined;
}

export async function statusRoute(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    sendJson(res, 200, await gitStatus({ repo: repoFromUrl(url) }));
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export async function logRoute(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const maxCount = url.searchParams.get("maxCount");
    sendJson(res, 200, await gitLog({
      repo: repoFromUrl(url),
      maxCount: maxCount ? Number(maxCount) : undefined,
      range: url.searchParams.get("range") ?? undefined,
    }));
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export async function branchRoute(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    sendJson(res, 200, await gitBranch({
      repo: repoFromUrl(url),
      includeRemote: url.searchParams.get("remote") === "1",
    }));
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export async function diffRoute(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const mode = (url.searchParams.get("mode") as "working" | "staged" | "head" | "range" | null) ?? "head";
    const out = await gitDiff({
      repo: repoFromUrl(url),
      mode,
      base: url.searchParams.get("base") ?? undefined,
      head: url.searchParams.get("head") ?? undefined,
      paths: url.searchParams.get("paths")?.split(",").filter(Boolean),
    });
    sendText(res, 200, out.diff, "text/x-diff; charset=utf-8");
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export async function showRoute(_req: IncomingMessage, res: ServerResponse, url: URL, ref: string): Promise<void> {
  try {
    const out = await gitShow({
      repo: repoFromUrl(url),
      ref,
      stat: url.searchParams.get("stat") === "1",
      nameOnly: url.searchParams.get("nameOnly") === "1",
      format: (url.searchParams.get("format") as "full" | "patch" | null) ?? undefined,
    });
    sendText(res, 200, out.content, "text/x-diff; charset=utf-8");
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export async function commitRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJsonBody<{
    message: string;
    paths?: string[];
    addAll?: boolean;
    trailers?: Record<string, string>;
    dryRun?: boolean;
  }>(req);
  try {
    const out = await gitCommit({ repo: repoFromUrl(url), ...body });
    getStore().logActivity({
      kind: "git_commit",
      summary: body.dryRun ? `Dry-run commit: ${body.message}` : `Committed: ${body.message}`,
      details: { sha: out.sha, dryRun: out.dryRun },
    });
    sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getStore().logActivity({ kind: "git_commit", summary: `Commit failed`, error: msg });
    sendError(res, 500, msg);
  }
}

export async function pushRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJsonBody<{
    remote?: string;
    branch?: string;
    protectRefs?: string[];
    dryRun?: boolean;
  }>(req);
  try {
    const out = await gitPush({ repo: repoFromUrl(url), ...body });
    getStore().logActivity({
      kind: "git_push",
      summary: out.dryRun
        ? `Dry-run push ${out.branch} -> ${out.remote}`
        : `Pushed ${out.branch} -> ${out.remote}`,
      details: out as unknown as Record<string, unknown>,
    });
    sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getStore().logActivity({ kind: "git_push", summary: `Push failed`, error: msg });
    sendError(res, 500, msg);
  }
}

export async function checkoutRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJsonBody<{ ref: string; createBranch?: boolean; from?: string; dryRun?: boolean }>(req);
  try {
    const out = await gitCheckout({ repo: repoFromUrl(url), ...body });
    getStore().logActivity({
      kind: "git_checkout",
      summary: out.created ? `Created branch ${out.ref}` : `Checked out ${out.ref}`,
    });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}
