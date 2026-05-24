/**
 * Concern graph — DAG construction and validation.
 * specs/01-common-types.md (ConcernGraph)
 * specs/02-analyze-diff.md (DAG validation)
 */

import { canonicalHash } from "../util/hash.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import type { Concern, ConcernGraph, HunkRef } from "../schemas/types.js";

/**
 * Generate a stable, order-independent concern ID from a set of hunks.
 * ID = sha256(sorted(hunks.hash)), truncated to 12 hex chars.
 */
export function stableConcernId(hunks: HunkRef[]): string {
  const hashes = hunks.map((h) => h.hash);
  return canonicalHash(hashes);
}

/**
 * Validate that the dependency graph across concerns is a valid DAG (no cycles).
 * Throws UntangleError with code DAG_CYCLE if a cycle is detected.
 */
export function validateDag(concerns: Concern[]): void {
  const idSet = new Set(concerns.map((c) => c.id));
  // Kahn's algorithm for cycle detection
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const c of concerns) {
    if (!inDegree.has(c.id)) inDegree.set(c.id, 0);
    if (!adjacency.has(c.id)) adjacency.set(c.id, []);
    for (const dep of c.dependsOn) {
      if (!idSet.has(dep)) continue; // skip unknown deps
      if (!adjacency.has(dep)) adjacency.set(dep, []);
      adjacency.get(dep)!.push(c.id);
      inDegree.set(c.id, (inDegree.get(c.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited < concerns.length) {
    // Find one cycle for diagnostic purposes
    const remaining = concerns.filter((c) => (inDegree.get(c.id) ?? 0) > 0);
    const cycleIds = remaining.map((c) => c.id);
    throw new UntangleErrorImpl(
      "DAG_CYCLE",
      `Dependency cycle detected among concerns: ${cycleIds.join(", ")}`,
      false,
      { cycleIds },
    );
  }
}

/**
 * Build a ConcernGraph from classified concerns.
 */
export function buildConcernGraph(
  concerns: Concern[],
  languagesDetected: string[],
): ConcernGraph {
  validateDag(concerns);

  const allHunks = concerns.flatMap((c) => c.hunks);
  const uniqueFiles = new Set(allHunks.map((h) => h.filePath));
  const loc = allHunks.reduce((sum, h) => sum + h.newLines + h.oldLines, 0);

  const dag: Array<[string, string]> = [];
  for (const c of concerns) {
    for (const dep of c.dependsOn) {
      dag.push([c.id, dep]);
    }
  }

  return {
    concerns,
    dag,
    meta: {
      hunkCount: allHunks.length,
      fileCount: uniqueFiles.size,
      loc,
      languagesDetected,
    },
  };
}
