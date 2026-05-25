/**
 * Tool: score_review_effort — the Circuit Breaker.
 * Spec: specs/03-score-review-effort.md
 * §S5: No LLM client import. Pure static signals.
 * §S10: Asserts clean working tree for branch targets.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UntangleErrorImpl, normalizeTarget } from "../schemas/types.js";
import type { Target } from "../schemas/types.js";
import { computeLoC, extractFilePaths } from "../core/diff-parser.js";
import { HeuristicScorer, type RiskSignals } from "../core/risk-scorer.js";
import { logger } from "../util/logger.js";

const execFileP = promisify(execFile);

/** High-risk path patterns. */
const HIGH_RISK_PATTERNS = [
  /\bauth\b/i,
  /\bsecurity\b/i,
  /\bpayment/i,
  /\bschema\b/i,
  /\bmigration/i,
  /\bsecret/i,
  /\bcrypto\b/i,
  /\bpassword/i,
  /\btoken\b/i,
];

/** Config file extensions / paths. */
const CONFIG_PATTERNS = [
  /\.ya?ml$/i,
  /\.toml$/i,
  /\.json$/i,
  /\.ini$/i,
  /\.env$/i,
  /Dockerfile/i,
  /Makefile/i,
  /\.github\//i,
  /\bci\b\//i,
  /\binfra\b\//i,
];

export interface ScoreInput {
  target: Target;
  threshold?: number;
  policy?: "conservative" | "balanced" | "aggressive";
}

export interface ScoreOutput {
  schemaVersion: "1";
  score: number;
  shouldDecompose: boolean;
  reason: string;
  signals: RiskSignals;
  costMeta: {
    durationMs: number;
  };
}

/** Resolve a target to raw diff text. */
async function resolveDiff(target: Target): Promise<string> {
  if (target.kind === "diff") {
    return target.content;
  }
  if (target.kind === "branch") {
    // §S10: assert clean working tree for branch targets
    const cwd = target.repo;
    try {
      const { stdout: status } = await execFileP("git", ["status", "--porcelain"], { cwd });
      if (status.trim().length > 0) {
        throw new UntangleErrorImpl("GIT_DIRTY", "Working tree is not clean", false);
      }
    } catch (e: unknown) {
      if (e instanceof UntangleErrorImpl) throw e;
      throw new UntangleErrorImpl("GIT_ERROR", `Cannot check git status: ${e}`, false);
    }
    const { stdout } = await execFileP("git", ["diff", `${target.base}...${target.branch}`], { cwd });
    return stdout;
  }
  if (target.kind === "working") {
    const cwd = target.repo;
    const mode = target.mode ?? "head";
    const args = mode === "staged" ? ["diff", "--cached"]
              : mode === "working" ? ["diff"]
              : ["diff", "HEAD"];
    const { stdout } = await execFileP("git", args, { cwd });
    return stdout;
  }
  throw new UntangleErrorImpl(
    "NOT_IMPLEMENTED",
    "PR target not yet supported — pass the PR diff as { kind:'diff', content } instead.",
    false,
  );
}

export async function scoreReviewEffort(input: ScoreInput): Promise<ScoreOutput> {
  const start = performance.now();

  // Resolve policy → threshold
  let threshold = input.threshold ?? 0.5;
  if (input.policy === "conservative") threshold = 0.7;
  else if (input.policy === "aggressive") threshold = 0.3;

  const target = normalizeTarget(input.target);
  const raw = await resolveDiff(target);

  // Empty diff fast path
  if (!raw || raw.trim().length === 0) {
    return {
      schemaVersion: "1",
      score: 0,
      shouldDecompose: false,
      reason: "empty diff",
      signals: { patchSize: 0, filesTouched: 0, configEdits: 0, highRiskFiles: [], estimatedConcerns: 0 },
      costMeta: { durationMs: performance.now() - start },
    };
  }

  // Extract signals
  const filePaths = extractFilePaths(raw);
  const patchSize = computeLoC(raw);
  const filesTouched = filePaths.length;
  const configEdits = filePaths.filter((p) => CONFIG_PATTERNS.some((pat) => pat.test(p))).length;
  const highRiskFiles = filePaths.filter((p) => HIGH_RISK_PATTERNS.some((pat) => pat.test(p)));

  // Estimated concerns = unique top-level directories + 1 per high-risk file
  const topDirs = new Set(filePaths.map((p) => p.split("/")[0]));
  const estimatedConcerns = topDirs.size + highRiskFiles.length;

  const signals: RiskSignals = { patchSize, filesTouched, configEdits, highRiskFiles, estimatedConcerns };

  const scorer = new HeuristicScorer();
  const score = scorer.score(signals);
  const shouldDecompose = score >= threshold;

  const reason = shouldDecompose
    ? `score ${score} ≥ threshold ${threshold} — decomposition recommended`
    : `score ${score} < threshold ${threshold} — skip decomposition`;

  logger.info("score_review_effort", { score, shouldDecompose, signals });

  return {
    schemaVersion: "1",
    score,
    shouldDecompose,
    reason,
    signals,
    costMeta: { durationMs: performance.now() - start },
  };
}
