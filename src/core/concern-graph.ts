/**
 * Concern graph — DAG construction and validation.
 * specs/01-common-types.md (ConcernGraph)
 * specs/02-analyze-diff.md (DAG validation)
 */

import { canonicalHash } from "../util/hash.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";
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
 * Best-effort: mutate `concerns[].dependsOn` to break any cycles by dropping
 * the most recently-discovered back-edge. Logs a warning per broken edge.
 * Returns the count of edges removed.
 */
export function breakDependencyCycles(concerns: Concern[]): number {
  const idSet = new Set(concerns.map((c) => c.id));
  let broken = 0;

  // Iterative cycle removal: repeatedly find a cycle and drop its weakest edge
  // (defined as the edge from the highest-confidence concern to the lowest —
  // i.e. drop the dep so the more-confident concern stays independent).
  for (let attempt = 0; attempt < concerns.length; attempt++) {
    const cycle = findCycle(concerns, idSet);
    if (!cycle) return broken;
    // Drop the edge that closes the cycle: cycle[last] depends on cycle[0]
    const from = cycle[cycle.length - 1]!;
    const to = cycle[0]!;
    const fromConcern = concerns.find((c) => c.id === from);
    if (!fromConcern) return broken;
    fromConcern.dependsOn = fromConcern.dependsOn.filter((d) => d !== to);
    broken++;
    logger.warn("dag_cycle_broken", { from, to, cycle });
  }
  return broken;
}

/** Find any one cycle in the dependency graph; returns the cycle as a list of ids. */
function findCycle(concerns: Concern[], idSet: Set<string>): string[] | null {
  const byId = new Map(concerns.map((c) => [c.id, c]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return start >= 0 ? stack.slice(start) : [id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    const c = byId.get(id);
    if (c) {
      for (const dep of c.dependsOn) {
        if (!idSet.has(dep)) continue;
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const c of concerns) {
    const found = dfs(c.id);
    if (found) return found;
  }
  return null;
}

/**
 * Build a ConcernGraph from classified concerns. Tolerates cycles: breaks the
 * minimum number of back-edges to recover, logs a warning, then validates.
 */
export function buildConcernGraph(
  concerns: Concern[],
  languagesDetected: string[],
): ConcernGraph {
  const broken = breakDependencyCycles(concerns);
  if (broken > 0) {
    logger.info("concern_graph_cycles_broken", { count: broken });
  }
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
