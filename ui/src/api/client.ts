/**
 * API client. Reads session token from the URL query param `t` (set by ui_open).
 * All requests carry the token; SSE adds it as a query param.
 */

const params = new URLSearchParams(window.location.search);
export const TOKEN = params.get("t") ?? "";

function authHeaders(): HeadersInit {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as { error?: string };
      detail = body.error ?? "";
    } catch { /* not JSON */ }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res.text() as unknown as Promise<T>;
}

export const api = {
  // session
  session: () => request<{ sessionId: string; startedAt: string }>("/api/session"),
  activity: (limit = 100) => request<{ activity: ActivityEntry[] }>(`/api/activity?limit=${limit}`),

  // proposals
  listProposals: () => request<{ proposals: ProposalRecord[] }>("/api/proposals"),
  getProposal: (id: string) => request<ProposalRecord>(`/api/proposals/${id}`),
  reproposeProposal: (id: string, body: ReproposeBody) =>
    request<{ ok: boolean; proposal: SplitProposal }>(`/api/proposals/${id}/repropose`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  applyProposal: (id: string, body: ApplyBody) =>
    request<{ ok: boolean; result: unknown }>(`/api/proposals/${id}/apply`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // PRs
  listPrs: (q: PrListQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return request<{ prs: PrSummary[] }>(`/api/prs${qs.toString() ? `?${qs}` : ""}`);
  },
  viewPr: (n: number, repo?: string) =>
    request<{ pr: PrDetails }>(`/api/prs/${n}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
  prDiff: (n: number, repo?: string) =>
    request<string>(`/api/prs/${n}/diff${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
  prChecks: (n: number, repo?: string) =>
    request<{ checks: CheckRun[]; summary: ChecksSummary }>(
      `/api/prs/${n}/checks${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
    ),
  prReview: (n: number, body: PrReviewBody, repo?: string) =>
    request(`/api/prs/${n}/review${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  prComment: (n: number, body: string, repo?: string) =>
    request(`/api/prs/${n}/comment${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  prMerge: (n: number, body: PrMergeBody, repo?: string) =>
    request(`/api/prs/${n}/merge${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  prClose: (n: number, dryRun = false, repo?: string) =>
    request(`/api/prs/${n}/close${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ dryRun }),
    }),
  prReopen: (n: number, repo?: string) =>
    request(`/api/prs/${n}/reopen${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, { method: "POST" }),
  prReady: (n: number, repo?: string) =>
    request(`/api/prs/${n}/ready${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, { method: "POST" }),
  prRequestReviewers: (n: number, body: { reviewers?: string[]; teamReviewers?: string[] }, repo?: string) =>
    request(`/api/prs/${n}/request-reviewers${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Git
  gitStatus: (repo?: string) => request<GitStatusOut>(`/api/git/status${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
  gitLog: (repo?: string, maxCount = 30) =>
    request<{ commits: GitCommit[] }>(`/api/git/log?maxCount=${maxCount}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`),
  gitBranch: (repo?: string, includeRemote = false) =>
    request<GitBranchOut>(
      `/api/git/branch${includeRemote ? "?remote=1" : ""}${repo ? `${includeRemote ? "&" : "?"}repo=${encodeURIComponent(repo)}` : ""}`,
    ),
  gitDiff: (q: { mode?: string; base?: string; head?: string; paths?: string; repo?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) qs.set(k, String(v));
    return request<string>(`/api/git/diff${qs.toString() ? `?${qs}` : ""}`);
  },
  gitCommit: (body: GitCommitBody, repo?: string) =>
    request(`/api/git/commit${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  gitPush: (body: GitPushBody, repo?: string) =>
    request(`/api/git/push${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  gitCheckout: (body: GitCheckoutBody, repo?: string) =>
    request(`/api/git/checkout${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function sseUrl(): string {
  return TOKEN ? `/api/sse?t=${encodeURIComponent(TOKEN)}` : "/api/sse";
}

// ---------------------------------------------------------------------------
// Types mirrored from server
// ---------------------------------------------------------------------------
export interface ActivityEntry {
  id: string;
  ts: string;
  kind: string;
  summary: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ConcernGraph {
  concerns: Concern[];
  dag: Array<[string, string]>;
  meta: { hunkCount: number; fileCount: number; loc: number; languagesDetected: string[] };
}

export interface Concern {
  id: string;
  kind: string;
  summary: string;
  hunks: HunkRef[];
  dependsOn: string[];
  confidence: number;
  riskHints: { touchesPublicAPI: boolean; touchesConfig: boolean; touchesSecurity: boolean };
}

export interface HunkRef {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hash: string;
}

export interface Slice {
  id: string;
  title: string;
  concernIds: string[];
  hunks: HunkRef[];
  parentSliceId?: string;
  effortScore: number;
  kindMix?: Record<string, number>;
}

export interface SplitProposal {
  slices: Slice[];
  stackStrategy: "gh-stack" | "sapling" | "graphite" | "flat";
  rejected: boolean;
  rejectionReason?: string;
  meta: { originalLoC: number; sliceCount: number; proposalId: string };
}

export interface ProposalRecord {
  id: string;
  ts: string;
  repo?: string;
  branch?: string;
  base?: string;
  graph?: ConcernGraph;
  proposal?: SplitProposal;
  applied?: {
    ts: string;
    branches: string[];
    prs: Array<{ url: string; sliceId: string }>;
    dryRun: boolean;
  };
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  url: string;
  updatedAt: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  link?: string;
}
export interface ChecksSummary { total: number; success: number; failure: number; pending: number }

export interface PrDetails extends PrSummary {
  body: string;
  createdAt: string;
  mergedAt: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  checks: CheckRun[];
}

export interface GitStatusOut {
  schemaVersion: "1";
  status: {
    branch: string;
    ahead: number;
    behind: number;
    staged: string[];
    modified: string[];
    untracked: string[];
    conflicted: string[];
    clean: boolean;
  };
}

export interface GitCommit {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body?: string;
}

export interface GitBranchOut {
  schemaVersion: "1";
  current: string;
  branches: Array<{ name: string; current: boolean; remote: boolean }>;
}

export interface PrListQuery {
  repo?: string;
  state?: "open" | "closed" | "merged" | "all";
  base?: string;
  head?: string;
  author?: string;
  limit?: number;
  search?: string;
}
export interface PrReviewBody { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }
export interface PrMergeBody {
  method?: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
  adminOverride?: boolean;
  auto?: boolean;
  matchSha?: string;
  body?: string;
  confirmProtectedBase?: boolean;
  dryRun?: boolean;
}

export interface ReproposeBody {
  maxConcernsPerSlice?: number;
  maxLocPerSlice?: number;
  stackStrategy?: "gh-stack" | "sapling" | "graphite" | "flat";
  preserveOrder?: string[];
}
export interface ApplyBody {
  target: { kind: "branch"; repo: string; branch: string; base: string } |
          { kind: "diff"; content: string; baseRef?: string } |
          { kind: "pr"; repo: string; number: number };
  dryRun?: boolean;
  draftPRs?: boolean;
  branchPrefix?: string;
}

export interface GitCommitBody { message: string; paths?: string[]; addAll?: boolean; trailers?: Record<string, string>; dryRun?: boolean }
export interface GitPushBody { remote?: string; branch?: string; protectRefs?: string[]; dryRun?: boolean }
export interface GitCheckoutBody { ref: string; createBranch?: boolean; from?: string; dryRun?: boolean }
