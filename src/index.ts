/**
 * Programmatic API exports for untangle.
 */

// Schemas & types
export type {
  Target, ConcernKind, HunkRef, Concern, ConcernGraph,
  Slice, SplitProposal, UntangleError,
} from "./schemas/types.js";
export { UntangleErrorImpl } from "./schemas/types.js";

// Core
export { parseDiff, extractHunks, computeLoC, extractFilePaths } from "./core/diff-parser.js";
export { buildConcernGraph, stableConcernId, validateDag } from "./core/concern-graph.js";
export { HeuristicScorer } from "./core/risk-scorer.js";
export { buildSlices } from "./core/slice-builder.js";
export { RefRegistry } from "./core/ref-registry.js";
export { GitWrapper } from "./core/git.js";

// Tools
export { scoreReviewEffort } from "./tools/score-review-effort.js";
export { analyzeDiff } from "./tools/analyze-diff.js";
export { proposeSplit } from "./tools/propose-split.js";
export { applySplit } from "./tools/apply-split.js";
export { summarizeSlice } from "./tools/summarize-slice.js";

// Utilities
export { sha256, canonicalHash } from "./util/hash.js";
export { withTimeout } from "./util/timeout.js";
export { logger } from "./util/logger.js";
export { redactSensitive } from "./llm/redactor.js";
