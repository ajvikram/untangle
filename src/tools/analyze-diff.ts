/**
 * Tool: analyze_diff — parse diff into a ConcernGraph.
 * Spec: specs/02-analyze-diff.md
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDiff, computeLoC } from "../core/diff-parser.js";
import { buildConcernGraph, stableConcernId } from "../core/concern-graph.js";
import { getLlmClient } from "../llm/client.js";
import { formatHunksForClassification } from "../llm/prompts.js";
import { logger } from "../util/logger.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import type { Target, Concern, ConcernGraph, HunkRef, ConcernKind } from "../schemas/types.js";

const execFileP = promisify(execFile);

export interface AnalyzeDiffInput {
  target: Target;
  languages?: string[] | "auto";
  includeCommitMessages?: boolean;
  model?: string;
  maxHunksPerCall?: number;
}

export interface AnalyzeDiffOutput {
  schemaVersion: "1";
  graph: ConcernGraph;
  warnings: string[];
  costMeta: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
}

const VALID_KINDS = new Set<ConcernKind>([
  "feature", "refactor", "fix", "test", "docs", "config", "deps", "style", "chore",
]);

/** Resolve a target to raw diff text. */
async function resolveDiff(target: Target): Promise<{ raw: string; commitMessages?: string[] }> {
  if (target.kind === "diff") {
    return { raw: target.content };
  }
  if (target.kind === "branch") {
    const cwd = target.repo;
    // §S10: assert clean working tree
    const { stdout: status } = await execFileP("git", ["status", "--porcelain"], { cwd });
    if (status.trim().length > 0) {
      throw new UntangleErrorImpl("GIT_DIRTY", "Working tree is not clean", false);
    }
    const { stdout } = await execFileP("git", ["diff", `${target.base}...${target.branch}`], { cwd });
    // Gather commit messages
    let commitMessages: string[] = [];
    try {
      const { stdout: logOut } = await execFileP(
        "git", ["log", "--format=%s", `${target.base}..${target.branch}`], { cwd },
      );
      commitMessages = logOut.trim().split("\n").filter((l) => l.length > 0);
    } catch { /* ignore */ }
    return { raw: stdout, commitMessages };
  }
  throw new UntangleErrorImpl("NOT_IMPLEMENTED", "PR target not yet supported", false);
}

/** Detect languages from file extensions in the diff. */
function detectLanguages(hunks: HunkRef[]): string[] {
  const exts = new Set<string>();
  for (const h of hunks) {
    const ext = h.filePath.split(".").pop()?.toLowerCase();
    if (ext) exts.add(ext);
  }
  return [...exts];
}

export async function analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffOutput> {
  const start = performance.now();
  const maxHunksPerCall = input.maxHunksPerCall ?? 40;
  const includeCommitMessages = input.includeCommitMessages ?? true;
  const warnings: string[] = [];
  let totalLlmCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const { raw, commitMessages } = await resolveDiff(input.target);

  // Empty diff fast path
  if (!raw || raw.trim().length === 0) {
    return {
      schemaVersion: "1",
      graph: { concerns: [], dag: [], meta: { hunkCount: 0, fileCount: 0, loc: 0, languagesDetected: [] } },
      warnings: [],
      costMeta: { llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: performance.now() - start },
    };
  }

  // Check diff size limit
  const loc = computeLoC(raw);
  if (loc > 100_000) {
    throw new UntangleErrorImpl("DIFF_TOO_LARGE", `Diff has ${loc} LoC, exceeding 100k limit`, false);
  }

  // Parse diff into structured hunks
  const fileDiffs = parseDiff(raw);
  const textHunks: HunkRef[] = [];
  const binaryFiles: string[] = [];
  const binaryHunks: HunkRef[] = [];

  for (const fd of fileDiffs) {
    if (fd.isBinary) {
      binaryFiles.push(fd.filePath);
      binaryHunks.push(...fd.hunks);
      warnings.push(`binary file skipped: ${fd.filePath}`);
    } else {
      textHunks.push(...fd.hunks);
    }
  }

  const allHunks = [...textHunks, ...binaryHunks];

  if (allHunks.length === 0) {
    const langs = detectLanguages(allHunks);
    return {
      schemaVersion: "1",
      graph: { concerns: [], dag: [], meta: { hunkCount: 0, fileCount: 0, loc: 0, languagesDetected: langs } },
      warnings,
      costMeta: { llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: performance.now() - start },
    };
  }

  const languages = (input.languages && input.languages !== "auto")
    ? input.languages
    : detectLanguages(allHunks);

  // Prepare hunk previews for LLM classification (text hunks only)
  const hunkPreviews = textHunks.map((h, i) => {
    // Extract a preview from the raw diff for context
    const lines = raw.split("\n");
    let preview = "";
    for (let li = 0; li < lines.length; li++) {
      if (lines[li]!.includes(h.filePath) && lines[li]!.startsWith("diff ")) {
        // Grab next few context lines
        preview = lines.slice(li, Math.min(li + 8, lines.length)).join("\n");
        break;
      }
    }
    return {
      index: i,
      filePath: h.filePath,
      addedLines: h.newLines,
      removedLines: h.oldLines,
      preview: preview.slice(0, 200),
    };
  });

  // Batch hunks for LLM classification
  const llm = getLlmClient();
  const allClassified: Array<{
    summary: string;
    kind: ConcernKind;
    hunkIndices: number[];
    dependsOn: number[];
    confidence: number;
    risk: { touchesPublicAPI: boolean; touchesConfig: boolean; touchesSecurity: boolean };
  }> = [];

  for (let batchStart = 0; batchStart < hunkPreviews.length; batchStart += maxHunksPerCall) {
    const batch = hunkPreviews.slice(batchStart, batchStart + maxHunksPerCall);

    const prompt = formatHunksForClassification(
      batch,
      includeCommitMessages
        ? (commitMessages && commitMessages.length > 0 ? commitMessages : ["update"])
        : undefined,
    );

    let response;
    try {
      response = await llm.chat(prompt, { model: input.model, jsonMode: true });
      totalLlmCalls++;
      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
    } catch (err) {
      // Retry once per spec
      try {
        response = await llm.chat(prompt, { model: input.model, jsonMode: true });
        totalLlmCalls++;
        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;
      } catch (retryErr) {
        warnings.push(`LLM call failed for batch starting at hunk ${batchStart}`);
        continue;
      }
    }

    // Parse LLM response
    const jsonText = response.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    try {
      const parsed = JSON.parse(jsonText) as {
        concerns: Array<{
          summary: string;
          kind: string;
          hunkIndices: number[];
          dependsOn?: number[];
          confidence?: number;
          risk?: { touchesPublicAPI?: boolean; touchesConfig?: boolean; touchesSecurity?: boolean };
        }>;
      };

      for (const c of parsed.concerns) {
        // Remap local batch indices to global indices
        const globalIndices = c.hunkIndices.map((i) => i + batchStart);
        const kind = VALID_KINDS.has(c.kind as ConcernKind) ? (c.kind as ConcernKind) : "chore";
        allClassified.push({
          summary: c.summary,
          kind,
          hunkIndices: globalIndices,
          dependsOn: (c.dependsOn ?? []).map((d) => d + allClassified.length - parsed.concerns.indexOf(c)),
          confidence: c.confidence ?? 0.8,
          risk: {
            touchesPublicAPI: c.risk?.touchesPublicAPI ?? false,
            touchesConfig: c.risk?.touchesConfig ?? false,
            touchesSecurity: c.risk?.touchesSecurity ?? false,
          },
        });
      }
    } catch {
      warnings.push(`Failed to parse LLM response for batch at hunk ${batchStart}`);
    }
  }

  // Add binary files as chore concerns
  if (binaryFiles.length > 0) {
    const binaryHunkIndices = allHunks
      .map((h, i) => binaryFiles.includes(h.filePath) ? i : -1)
      .filter((i) => i >= 0);
    if (binaryHunkIndices.length > 0) {
      allClassified.push({
        summary: "update binary files",
        kind: "chore",
        hunkIndices: binaryHunkIndices,
        dependsOn: [],
        confidence: 1.0,
        risk: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
      });
    }
  }

  // If LLM returned nothing or failed, apply deterministic heuristic grouping based on directories and file extensions
  if (allClassified.length === 0) {
    const groups: Map<string, { kind: ConcernKind; hunks: number[]; files: Set<string> }> = new Map();

    for (let i = 0; i < hunkPreviews.length; i++) {
      const p = hunkPreviews[i]!;
      const filePath = p.filePath;
      const lowerPath = filePath.toLowerCase();

      let kind: ConcernKind = "feature";
      let groupKey = "source";

      if (lowerPath.includes("test") || lowerPath.includes("spec") || lowerPath.includes("__tests__")) {
        kind = "test";
        groupKey = "tests";
      } else if (
        lowerPath.endsWith("json") ||
        lowerPath.endsWith("yaml") ||
        lowerPath.endsWith("yml") ||
        lowerPath.endsWith("toml") ||
        lowerPath.includes("config")
      ) {
        kind = "config";
        groupKey = "config";
      } else if (lowerPath.endsWith(".md")) {
        kind = "docs";
        groupKey = "docs";
      } else {
        // Group by directory structure (first folder name or root)
        const parts = filePath.split("/");
        if (parts.length > 1 && parts[0] !== "src") {
          groupKey = `dir-${parts[0]}`;
        } else if (parts.length > 2 && parts[0] === "src") {
          groupKey = `src-${parts[1]}`;
        } else {
          groupKey = "core";
        }
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, { kind, hunks: [], files: new Set() });
      }
      const g = groups.get(groupKey)!;
      g.hunks.push(i);
      g.files.add(filePath);
    }

    // Convert groups into concerns
    for (const [name, g] of groups.entries()) {
      allClassified.push({
        summary: `Decompose ${name} changes (${Array.from(g.files).join(", ")})`,
        kind: g.kind,
        hunkIndices: g.hunks,
        dependsOn: [],
        confidence: 0.9,
        risk: { touchesPublicAPI: false, touchesConfig: g.kind === "config", touchesSecurity: false }
      });
    }
  }

  // Ensure every hunk is assigned
  const assignedHunks = new Set(allClassified.flatMap((c) => c.hunkIndices));
  const unassigned = allHunks.map((_, i) => i).filter((i) => !assignedHunks.has(i));
  if (unassigned.length > 0) {
    // Assign unassigned hunks to the first concern as fallback
    allClassified[0]!.hunkIndices.push(...unassigned);
  }

  // Build Concern objects with stable IDs
  const concerns: Concern[] = allClassified.map((c, _idx) => {
    const hunks = c.hunkIndices.map((i) => allHunks[i]!);
    return {
      id: stableConcernId(hunks),
      kind: c.kind,
      summary: c.summary,
      hunks,
      dependsOn: [],
      confidence: c.confidence,
      riskHints: c.risk,
    };
  });

  // Resolve inter-concern dependencies based on LLM predictions AND file-level overlap
  for (let i = 0; i < concerns.length; i++) {
    const mappedDeps = new Set<string>();
    // 1. LLM predicted dependencies
    for (const depIdx of allClassified[i]!.dependsOn) {
      if (depIdx >= 0 && depIdx < concerns.length && depIdx !== i) {
        mappedDeps.add(concerns[depIdx]!.id);
      }
    }
    // 2. File-level overlap dependencies
    const myFiles = new Set(concerns[i]!.hunks.map((h) => h.filePath));
    for (let j = 0; j < concerns.length; j++) {
      if (j === i) continue;
      const theirFiles = new Set(concerns[j]!.hunks.map((h) => h.filePath));
      const overlaps = [...myFiles].some((f) => theirFiles.has(f));
      if (overlaps) {
        mappedDeps.add(concerns[j]!.id);
      }
    }
    concerns[i]!.dependsOn = [...mappedDeps];
  }

  // Validate DAG — this throws on cycles
  const graph = buildConcernGraph(concerns, languages);

  logger.info("analyze_diff", {
    concerns: concerns.length,
    hunks: allHunks.length,
    llmCalls: totalLlmCalls,
  });

  return {
    schemaVersion: "1",
    graph,
    warnings,
    costMeta: {
      llmCalls: totalLlmCalls,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      durationMs: performance.now() - start,
    },
  };
}
