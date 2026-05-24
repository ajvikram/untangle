/**
 * Tool: propose_split — plan a stack of slices from a ConcernGraph.
 * Spec: specs/04-propose-split.md
 */

import { buildSlices, type SliceBuildOptions } from "../core/slice-builder.js";
import { canonicalHash } from "../util/hash.js";
import { logger } from "../util/logger.js";
import type { ConcernGraph, SplitProposal } from "../schemas/types.js";

export interface ProposeSplitInput {
  graph: ConcernGraph;
  maxConcernsPerSlice?: number;
  maxLocPerSlice?: number;
  stackStrategy?: "gh-stack" | "sapling" | "graphite" | "flat";
  preserveOrder?: string[];
  riskScore?: number;
  riskThreshold?: number;
}

export async function proposeSplit(input: ProposeSplitInput): Promise<{ schemaVersion: "1"; proposal: SplitProposal }> {
  const {
    graph, maxConcernsPerSlice = 3, maxLocPerSlice = 400,
    stackStrategy = "flat", preserveOrder, riskScore, riskThreshold = 0.5,
  } = input;

  if (riskScore !== undefined && riskScore < riskThreshold) {
    return {
      schemaVersion: "1",
      proposal: {
        slices: [], stackStrategy, rejected: true,
        rejectionReason: `Risk score ${riskScore} < threshold ${riskThreshold}`,
        meta: { originalLoC: graph.meta.loc, sliceCount: 0, proposalId: canonicalHash([]) },
      },
    };
  }

  const opts: SliceBuildOptions = { maxConcernsPerSlice, maxLocPerSlice, stackStrategy, preserveOrder };
  const slices = buildSlices(graph, opts);
  const proposalId = canonicalHash(slices.map((s) => s.id).sort());

  logger.info("propose_split", { sliceCount: slices.length, stackStrategy, proposalId });

  return {
    schemaVersion: "1",
    proposal: {
      slices, stackStrategy, rejected: false,
      meta: { originalLoC: graph.meta.loc, sliceCount: slices.length, proposalId },
    },
  };
}
