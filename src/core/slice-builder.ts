/**
 * Slice builder — propose_split's core planner.
 * Takes a ConcernGraph and produces topologically ordered Slices.
 *
 * Constitution §4: max 3 concerns per slice (hard cap).
 * Safety §S6: max 16 slices total.
 */

import { sha256 } from "../util/hash.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import type { Concern, ConcernGraph, HunkRef, Slice, ConcernKind } from "../schemas/types.js";

export interface SliceBuildOptions {
  maxConcernsPerSlice: number;
  maxLocPerSlice: number;
  stackStrategy: "gh-stack" | "sapling" | "graphite" | "flat";
  preserveOrder?: string[];
}

const HARD_CONCERN_CAP = 3;
const MAX_SLICES = 16;
const DEFAULT_MAX_SLICES = 8;

/**
 * Topological sort of concerns using Kahn's algorithm.
 * Returns concern IDs in dependency-first order.
 */
function topologicalSort(concerns: Concern[]): string[] {
  const idSet = new Set(concerns.map((c) => c.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const c of concerns) {
    inDegree.set(c.id, 0);
    adjacency.set(c.id, []);
  }
  for (const c of concerns) {
    for (const dep of c.dependsOn) {
      if (!idSet.has(dep)) continue;
      adjacency.get(dep)!.push(c.id);
      inDegree.set(c.id, (inDegree.get(c.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  // Sort lexicographically for determinism among peers
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    const neighbors = adjacency.get(node) ?? [];
    neighbors.sort();
    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return result;
}

/** Compute total LoC (newLines) for an array of hunks. */
function hunkLoC(hunks: HunkRef[]): number {
  return hunks.reduce((s, h) => s + h.newLines, 0);
}

/** Build kindMix for a set of concerns. */
function buildKindMix(concerns: Concern[]): Partial<Record<ConcernKind, number>> {
  const total = concerns.flatMap((c) => c.hunks).reduce((s, h) => s + h.newLines, 0);
  if (total === 0) return {};
  const mix: Partial<Record<ConcernKind, number>> = {};
  for (const c of concerns) {
    const loc = c.hunks.reduce((s, h) => s + h.newLines, 0);
    mix[c.kind] = (mix[c.kind] ?? 0) + loc / total;
  }
  return mix;
}



/**
 * Build slices from a concern graph.
 */
export function buildSlices(graph: ConcernGraph, opts: SliceBuildOptions): Slice[] {
  const { maxLocPerSlice, stackStrategy, preserveOrder } = opts;
  // Hard cap at 3 per spec §4
  const maxConcernsPerSlice = Math.min(opts.maxConcernsPerSlice, HARD_CONCERN_CAP);

  const concernMap = new Map(graph.concerns.map((c) => [c.id, c]));
  const sortedIds = topologicalSort(graph.concerns);

  // Validate preserveOrder
  if (preserveOrder) {
    for (const id of preserveOrder) {
      if (!concernMap.has(id)) {
        throw new UntangleErrorImpl(
          "UNKNOWN_CONCERN",
          `preserveOrder references unknown concern ID: ${id}`,
          false,
        );
      }
    }
  }

  // Build slices: greedily group concerns respecting DAG order, maxConcerns, maxLoC
  const sliceGroups: Concern[][] = [];
  const assigned = new Set<string>();

  // If preserveOrder is set, those concerns lead in their own slices
  if (preserveOrder) {
    for (const id of preserveOrder) {
      const c = concernMap.get(id)!;
      sliceGroups.push([c]);
      assigned.add(id);
    }
  }

  // Process remaining in topological order
  for (const id of sortedIds) {
    if (assigned.has(id)) continue;
    const c = concernMap.get(id)!;

    // Try to merge into the last slice group if this concern depends on it
    const lastGroup = sliceGroups.length > 0 ? sliceGroups[sliceGroups.length - 1]! : null;
    // Only merge when the concern has an explicit dependency on something in the
    // last group (not just "it fits"). Independent concerns get their own slices.
    const hasDependencyInLastGroup = lastGroup &&
      c.dependsOn.some((dep) => lastGroup.some((gc) => gc.id === dep));
    const canMerge = hasDependencyInLastGroup &&
      lastGroup.length < maxConcernsPerSlice &&
      hunkLoC([...lastGroup.flatMap((cc) => cc.hunks), ...c.hunks]) <= maxLocPerSlice;

    if (canMerge && lastGroup) {
      lastGroup.push(c);
    } else {
      sliceGroups.push([c]);
    }
    assigned.add(id);
  }

  // If we exceed the hard cap, merge trailing slices down to MAX_SLICES
  while (sliceGroups.length > MAX_SLICES) {
    const last = sliceGroups.pop()!;
    sliceGroups[sliceGroups.length - 1]!.push(...last);
  }

  // If we exceed the default soft cap (8), merge trailing slices into the last group
  while (sliceGroups.length > DEFAULT_MAX_SLICES) {
    const last = sliceGroups.pop()!;
    sliceGroups[sliceGroups.length - 1]!.push(...last);
  }

  // Convert groups to Slice objects
  const slices: Slice[] = sliceGroups.map((group) => {
    const hunks = group.flatMap((c) => c.hunks);
    const primarySummary = group[0]!.summary;
    const title = group.length === 1
      ? primarySummary
      : `${primarySummary} (+${group.length - 1} more)`;

    return {
      id: `s-${sha256(group.map((c) => c.id).sort().join("|"))}`,
      title: title.slice(0, 72),
      concernIds: group.map((c) => c.id),
      hunks,
      effortScore: 0, // computed below
      kindMix: buildKindMix(group),
    };
  });

  // Assign parent links for stacking strategies
  if (stackStrategy !== "flat") {
    for (let i = 1; i < slices.length; i++) {
      slices[i]!.parentSliceId = slices[i - 1]!.id;
    }
  }

  // Compute effort scores per slice (using simplified hunk-level scoring)
  for (const s of slices) {
    const loc = hunkLoC(s.hunks);
    const files = new Set(s.hunks.map((h) => h.filePath)).size;
    // Simple normalized effort (0..1 range)
    s.effortScore = Math.min(1, (loc / 400) * 0.6 + (files / 10) * 0.4);
    s.effortScore = Math.round(s.effortScore * 1000) / 1000;
  }

  return slices;
}
