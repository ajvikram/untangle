/**
 * Zod schemas + inferred TypeScript types.
 * Source of truth: specs/01-common-types.md
 *
 * Runtime validation and compile-time types never drift because TS types
 * are derived via z.infer<>.
 */

import { z } from "zod";
import { workspaceRootSync } from "../util/workspace.js";

// ---------------------------------------------------------------------------
// ConcernKind
// ---------------------------------------------------------------------------
export const ConcernKindSchema = z.enum([
  "feature",
  "refactor",
  "fix",
  "test",
  "docs",
  "config",
  "deps",
  "style",
  "chore",
]);
export type ConcernKind = z.infer<typeof ConcernKindSchema>;

// ---------------------------------------------------------------------------
// Target — discriminated union
// ---------------------------------------------------------------------------
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("branch"),
    repo: z.string(),
    branch: z.string(),
    base: z.string(),
  }),
  z.object({
    kind: z.literal("diff"),
    content: z.string(),
    baseRef: z.string().optional(),
  }),
  z.object({
    kind: z.literal("pr"),
    repo: z.string(),
    number: z.number(),
  }),
  z.object({
    kind: z.literal("working"),
    repo: z.string(),
    mode: z.enum(["working", "staged", "head"]).optional(),
  }),
]);
export type Target = z.infer<typeof TargetSchema>;

/**
 * Forgive callers who omit `kind`, use convenience field names, or skip `repo`
 * (in which case we default to process.cwd() — typically the MCP host's
 * workspace folder). Returns a properly-discriminated Target or throws
 * UntangleError for truly unparseable input.
 *
 * Accepted shapes (repo optional in all — defaults to process.cwd()):
 *   - { kind: 'branch'|'diff'|'pr'|'working', ... }
 *   - { base, branch } | { base, head }    → kind:'branch'
 *   - { number }                            → kind:'pr'
 *   - { content }                           → kind:'diff'
 *   - { mode } | { } (empty)                → kind:'working'  (mode aliases: unstaged/cached/index)
 */
export function normalizeTarget(raw: unknown): Target {
  if (raw === null || typeof raw !== "object") {
    throw new UntangleErrorImpl(
      "BAD_INPUT",
      "target must be an object — pass at minimum { repo: '/path/to/repo' } or { kind: 'branch' | 'diff' | 'pr' | 'working' }",
      false,
      { received: raw },
    );
  }
  const t = raw as Record<string, unknown>;
  // workspaceRootSync is the cached MCP-roots / .git-walkup discovery — only
  // used when the caller didn't pass `repo` explicitly. Falls back to cwd.
  // (We don't await discoverWorkspaceRoot here because normalize must be sync.)
  const repo = typeof t.repo === "string" ? t.repo : workspaceRootSync();

  // Explicit kind.
  if (typeof t.kind === "string") {
    if (t.kind === "branch") {
      const branch = typeof t.branch === "string" ? t.branch : typeof t.head === "string" ? t.head : undefined;
      if (!branch || typeof t.base !== "string") {
        throw new UntangleErrorImpl(
          "BAD_INPUT",
          "kind:'branch' requires `base` and `branch` (or `head`)",
          false,
          { received: t },
        );
      }
      return { kind: "branch", repo, branch, base: t.base };
    }
    if (t.kind === "diff") {
      if (typeof t.content !== "string") {
        throw new UntangleErrorImpl("BAD_INPUT", "kind:'diff' requires `content`", false, { received: t });
      }
      return { kind: "diff", content: t.content, baseRef: typeof t.baseRef === "string" ? t.baseRef : undefined };
    }
    if (t.kind === "pr") {
      if (typeof t.number !== "number") {
        throw new UntangleErrorImpl("BAD_INPUT", "kind:'pr' requires `number`", false, { received: t });
      }
      return { kind: "pr", repo, number: t.number };
    }
    if (t.kind === "working") {
      return { kind: "working", repo, mode: resolveMode(t.mode) };
    }
    throw new UntangleErrorImpl(
      "BAD_INPUT",
      `kind:'${t.kind}' is not recognized. Use 'branch' | 'diff' | 'pr' | 'working'.`,
      false,
      { received: t },
    );
  }
  // Some callers use `type` instead of `kind`.
  if (typeof t.type === "string") {
    return normalizeTarget({ ...t, kind: t.type });
  }

  // Infer from shape.
  if (typeof t.content === "string") {
    return { kind: "diff", content: t.content, baseRef: typeof t.baseRef === "string" ? t.baseRef : undefined };
  }
  if (typeof t.number === "number") {
    return { kind: "pr", repo, number: t.number };
  }
  if (typeof t.base === "string") {
    const branch = typeof t.branch === "string" ? t.branch : typeof t.head === "string" ? t.head : "HEAD";
    return { kind: "branch", repo, branch, base: t.base };
  }
  // No discriminating field — default to working-tree against current HEAD.
  return { kind: "working", repo, mode: resolveMode(t.mode) };
}

function resolveMode(raw: unknown): "working" | "staged" | "head" {
  const m = typeof raw === "string" ? raw.toLowerCase() : "head";
  if (m === "unstaged" || m === "working") return "working";
  if (m === "cached" || m === "index" || m === "staged") return "staged";
  return "head";
}

// ---------------------------------------------------------------------------
// HunkRef
// ---------------------------------------------------------------------------
export const HunkRefSchema = z.object({
  filePath: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  hash: z.string(),
});
export type HunkRef = z.infer<typeof HunkRefSchema>;

// ---------------------------------------------------------------------------
// Concern
// ---------------------------------------------------------------------------
export const RiskHintsSchema = z.object({
  touchesPublicAPI: z.boolean(),
  touchesConfig: z.boolean(),
  touchesSecurity: z.boolean(),
});
export type RiskHints = z.infer<typeof RiskHintsSchema>;

export const ConcernSchema = z.object({
  id: z.string(),
  kind: ConcernKindSchema,
  summary: z.string(),
  hunks: z.array(HunkRefSchema),
  dependsOn: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  riskHints: RiskHintsSchema,
});
export type Concern = z.infer<typeof ConcernSchema>;

// ---------------------------------------------------------------------------
// ConcernGraph
// ---------------------------------------------------------------------------
export const ConcernGraphSchema = z.object({
  concerns: z.array(ConcernSchema),
  dag: z.array(z.tuple([z.string(), z.string()])),
  meta: z.object({
    hunkCount: z.number(),
    fileCount: z.number(),
    loc: z.number(),
    languagesDetected: z.array(z.string()),
  }),
});
export type ConcernGraph = z.infer<typeof ConcernGraphSchema>;

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------
export const SliceSchema = z.object({
  id: z.string(),
  title: z.string(),
  concernIds: z.array(z.string()),
  hunks: z.array(HunkRefSchema),
  parentSliceId: z.string().optional(),
  effortScore: z.number().min(0).max(1),
  kindMix: z.record(ConcernKindSchema, z.number()).optional(),
});
export type Slice = z.infer<typeof SliceSchema>;

// ---------------------------------------------------------------------------
// SplitProposal
// ---------------------------------------------------------------------------
export const SplitProposalSchema = z.object({
  slices: z.array(SliceSchema),
  stackStrategy: z.enum(["gh-stack", "sapling", "graphite", "flat"]),
  rejected: z.boolean(),
  rejectionReason: z.string().optional(),
  meta: z.object({
    originalLoC: z.number(),
    sliceCount: z.number(),
    proposalId: z.string(),
  }),
});
export type SplitProposal = z.infer<typeof SplitProposalSchema>;

// ---------------------------------------------------------------------------
// UntangleError
// ---------------------------------------------------------------------------
export const UntangleErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});
export type UntangleError = z.infer<typeof UntangleErrorSchema>;

// ---------------------------------------------------------------------------
// Error factory
// ---------------------------------------------------------------------------
export class UntangleErrorImpl extends Error implements UntangleError {
  readonly code: string;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, recoverable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "UntangleError";
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// RouteReviewers schemas
// ---------------------------------------------------------------------------
export const RouteReviewersPolicySchema = z.enum([
  "codeowners-strict",
  "blame-weighted",
  "expertise-graph"
]);
export type RouteReviewersPolicy = z.infer<typeof RouteReviewersPolicySchema>;

export const RouteReviewersInputSchema = z.object({
  proposal: SplitProposalSchema,
  repo: z.string(),
  policy: RouteReviewersPolicySchema.optional(),
  maxReviewersPerSlice: z.number().optional(),
  excludeUsers: z.array(z.string()).optional(),
});
export type RouteReviewersInput = z.infer<typeof RouteReviewersInputSchema>;

export const ReviewerSchema = z.object({
  login: z.string(),
  reason: z.string(),
  weight: z.number().min(0).max(1),
});
export type Reviewer = z.infer<typeof ReviewerSchema>;

export const SliceAssignmentSchema = z.object({
  sliceId: z.string(),
  reviewers: z.array(ReviewerSchema),
});
export type SliceAssignment = z.infer<typeof SliceAssignmentSchema>;

export const RouteReviewersOutputSchema = z.object({
  schemaVersion: z.literal("1"),
  assignments: z.array(SliceAssignmentSchema),
  unassigned: z.array(z.string()),
});
export type RouteReviewersOutput = z.infer<typeof RouteReviewersOutputSchema>;
