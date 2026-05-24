/**
 * Tool: summarize_slice — generate PR title + body.
 * Spec: specs/06-summarize-slice.md
 */

import { getLlmClient } from "../llm/client.js";
import { formatSliceForSummary } from "../llm/prompts.js";
import { logger } from "../util/logger.js";
import type { ConcernGraph, Slice, ConcernKind } from "../schemas/types.js";

export interface SummarizeSliceInput {
  slice: Slice;
  graph: ConcernGraph;
  specSource?: "openspec" | "spec-kit" | "none";
  specPath?: string;
  style?: "concise" | "detailed";
  model?: string;
}

export interface SummarizeSliceOutput {
  schemaVersion: "1";
  title: string;
  body: string;
  specDeltaRefs: string[];
  costMeta: { llmCalls: number; inputTokens: number; outputTokens: number; durationMs: number };
}

/** Truncate title at word boundary to ≤72 chars. */
function truncateTitle(title: string): string {
  if (title.length <= 72) return title;
  const cut = title.lastIndexOf(" ", 72);
  return (cut > 10 ? title.slice(0, cut) : title.slice(0, 72)).trimEnd();
}

/** Deterministic fallback summary (no LLM needed). */
function fallbackSummary(slice: Slice, graph: ConcernGraph, parentTitle?: string): SummarizeSliceOutput {
  const concerns = slice.concernIds
    .map((id) => graph.concerns.find((c) => c.id === id))
    .filter(Boolean) as Array<{ kind: ConcernKind; summary: string }>;

  const primary = concerns[0];
  const title = truncateTitle(primary ? primary.summary : slice.title);
  const files = [...new Set(slice.hunks.map((h) => h.filePath))];

  let body = "## Summary\n\n";
  if (parentTitle) body += `Builds on: ${parentTitle}\n\n`;
  body += concerns.map((c) => `- **${c.kind}**: ${c.summary}`).join("\n");
  body += "\n\n## Changes\n\n";
  body += files.map((f) => `- \`${f}\``).join("\n");
  body += "\n\n## Notes for reviewers\n\n";
  body += `Effort score: ${slice.effortScore}\n`;

  return {
    schemaVersion: "1", title, body, specDeltaRefs: [],
    costMeta: { llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

export async function summarizeSlice(input: SummarizeSliceInput): Promise<SummarizeSliceOutput> {
  const start = performance.now();
  const { slice, graph, specSource: _specSource = "none", style = "concise" } = input;

  const concerns = slice.concernIds
    .map((id) => graph.concerns.find((c) => c.id === id))
    .filter(Boolean) as Array<{ kind: ConcernKind; summary: string }>;

  const parentTitle = slice.parentSliceId ? `slice ${slice.parentSliceId}` : undefined;
  const files = [...new Set(slice.hunks.map((h) => h.filePath))];

  // Try LLM-powered summary
  const llm = getLlmClient();
  const prompt = formatSliceForSummary({
    title: slice.title,
    concerns,
    filesPaths: files,
    kindMix: slice.kindMix ?? {},
    effortScore: slice.effortScore,
    parentSliceTitle: parentTitle,
    style,
  });

  let title: string;
  let body: string;
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await llm.chat(prompt, { model: input.model, jsonMode: true });
    llmCalls++;
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;

    const jsonText = response.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(jsonText) as { title?: string; body?: string };

    title = truncateTitle(parsed.title ?? slice.title);
    body = parsed.body ?? "";

    // Ensure required sections exist
    if (!body.includes("## Summary")) body = `## Summary\n\n${body}`;
    if (!body.includes("## Changes")) body += "\n\n## Changes\n\n" + files.map((f) => `- \`${f}\``).join("\n");

    // Inject parent reference if stacked
    if (parentTitle && !body.toLowerCase().includes("builds on")) {
      body = body.replace("## Summary\n", `## Summary\n\nBuilds on: ${parentTitle}\n`);
    }
  } catch {
    // Fallback to deterministic summary
    const fb = fallbackSummary(slice, graph, parentTitle);
    title = fb.title;
    body = fb.body;
  }

  // Spec delta refs
  const specDeltaRefs: string[] = [];
  // Only populated when specSource != "none" — punt for now

  logger.info("summarize_slice", { sliceId: slice.id, titleLen: title.length, llmCalls });

  return {
    schemaVersion: "1", title, body, specDeltaRefs,
    costMeta: { llmCalls, inputTokens, outputTokens, durationMs: performance.now() - start },
  };
}
