/**
 * LLM prompt templates for concern classification and PR summarization.
 */

import type { ConcernKind } from "../schemas/types.js";

/**
 * Format hunks into a compact representation for LLM classification.
 */
export function formatHunksForClassification(
  hunks: Array<{ index: number; filePath: string; addedLines: number; removedLines: number; preview: string }>,
  commitMessages?: string[],
): string {
  let prompt = `Classify the following code change hunks into concerns.

Each concern is a single, atomic unit of intent (feature, refactor, fix, test, docs, config, deps, style, chore).
Group hunks that serve the same purpose into the same concern.

Return ONLY valid JSON (no markdown fences):
{
  "concerns": [
    {
      "summary": "imperative one-line description",
      "kind": "feature|refactor|fix|test|docs|config|deps|style|chore",
      "hunkIndices": [0, 2],
      "dependsOn": [],
      "confidence": 0.9,
      "risk": { "touchesPublicAPI": false, "touchesConfig": false, "touchesSecurity": false }
    }
  ]
}

Rules:
- Every hunk index must appear in exactly one concern.
- "dependsOn" references other concerns by their 0-based index in the output array.
- "summary" is imperative (e.g. "add", "rename", "remove").

HUNKS:
`;

  for (const h of hunks) {
    prompt += `\n[${h.index}] ${h.filePath} (+${h.addedLines}/-${h.removedLines})\n${h.preview}\n`;
  }

  if (commitMessages && commitMessages.length > 0) {
    prompt += `\nCOMMIT MESSAGES:\n${commitMessages.join("\n")}\n`;
  }

  return prompt;
}

/**
 * Format a slice for PR body generation.
 */
export function formatSliceForSummary(opts: {
  title: string;
  concerns: Array<{ kind: ConcernKind; summary: string }>;
  filesPaths: string[];
  kindMix: Partial<Record<ConcernKind, number>>;
  effortScore: number;
  parentSliceTitle?: string;
  style: "concise" | "detailed";
}): string {
  let prompt = `Generate a PR title and body for the following code change slice.

Requirements:
- title: imperative voice, ≤72 characters, no "this PR" language, no gerunds ("adding" → "add")
- body sections: ## Summary, ## Changes, ## Notes for reviewers
${opts.parentSliceTitle ? `- Include "Builds on: ${opts.parentSliceTitle}" in the summary.` : ""}
- style: ${opts.style}

SLICE: ${opts.title}
CONCERNS:
`;

  for (const c of opts.concerns) {
    prompt += `- [${c.kind}] ${c.summary}\n`;
  }

  prompt += `\nFILES: ${opts.filesPaths.join(", ")}`;
  prompt += `\nEFFORT: ${opts.effortScore}`;

  prompt += `\n\nReturn ONLY valid JSON:
{
  "title": "imperative title ≤72 chars",
  "body": "markdown body with ## Summary, ## Changes, ## Notes for reviewers"
}`;

  return prompt;
}
