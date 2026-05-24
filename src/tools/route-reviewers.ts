/**
 * Tool: route_reviewers — map stacked slices to suggested reviewers.
 * Spec: specs/07-route-reviewers.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { logger } from "../util/logger.js";
import { withTimeout } from "../util/timeout.js";
import type { RouteReviewersInput, RouteReviewersOutput, Reviewer, SliceAssignment } from "../schemas/types.js";

// Helper to run a command in a directory
function execAsync(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Simple pattern matcher matching CODEOWNERS style rules
export function matchPathPattern(filePath: string, pattern: string): boolean {
  // Normalize paths
  const cleanFile = filePath.replace(/\\/g, "/").replace(/^\//, "");
  let cleanPattern = pattern.trim().replace(/\\/g, "/");

  if (!cleanPattern || cleanPattern.startsWith("#")) {
    return false;
  }

  // If pattern starts with / it matches from root, otherwise matches anywhere
  const matchFromRoot = cleanPattern.startsWith("/");
  if (matchFromRoot) {
    cleanPattern = cleanPattern.slice(1);
  }

  // Convert glob to regex
  let regexStr = cleanPattern
    .replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&") // escape regex chars
    .replace(/\\\*\\\*/g, ".*")                 // ** -> match any path depth
    .replace(/\\\*/g, "[^/]*");                 // * -> match within directory

  if (matchFromRoot) {
    regexStr = "^" + regexStr;
  } else {
    regexStr = "(^|/)" + regexStr;
  }

  if (cleanPattern.endsWith("/")) {
    regexStr += ".*";
  } else {
    regexStr += "($|/)";
  }

  try {
    const regex = new RegExp(regexStr);
    return regex.test(cleanFile);
  } catch {
    return false;
  }
}

// Parse CODEOWNERS contents
export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // Match pattern followed by owners
    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).map(o => o.replace(/^@/, ""));
    if (pattern && owners.length > 0) {
      rules.push({ pattern, owners });
    }
  }
  return rules;
}

// Locate and load CODEOWNERS
function loadCodeownersRules(repoPath: string): CodeownersRule[] {
  const searchPaths = [
    path.join(repoPath, "CODEOWNERS"),
    path.join(repoPath, ".github", "CODEOWNERS"),
    path.join(repoPath, "docs", "CODEOWNERS"),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8");
        return parseCodeowners(content);
      } catch (err: any) {
        logger.warn("codeowners_load_failed", { path: p, error: err.message });
      }
    }
  }
  return [];
}

// Retrieve blame author email/username for a file range
async function blameHunk(
  repoPath: string,
  filePath: string,
  startLine: number,
  lineCount: number
): Promise<string[]> {
  if (lineCount <= 0) {
    // Pure insertion — blame surrounding lines in the file
    // Check if file exists in the directory
    const fullPath = path.join(repoPath, filePath);
    if (!fs.existsSync(fullPath)) {
      return [];
    }
    const fromLine = Math.max(1, startLine - 5);
    const toLine = startLine + 5;
    try {
      const output = await execAsync(`git blame -p -L ${fromLine},${toLine} -- "${filePath}"`, repoPath);
      return parseBlameOutput(output);
    } catch {
      return [];
    }
  }

  try {
    const output = await execAsync(`git blame -p -L ${startLine},${startLine + lineCount - 1} -- "${filePath}"`, repoPath);
    return parseBlameOutput(output);
  } catch {
    // Try blame without range limits if it fails (e.g. file changed line counts)
    try {
      const output = await execAsync(`git blame -p -- "${filePath}"`, repoPath);
      return parseBlameOutput(output);
    } catch {
      return [];
    }
  }
}

function parseBlameOutput(output: string): string[] {
  const authors: string[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("author-mail ")) {
      const mail = line.substring("author-mail ".length).trim();
      // Extract username prefix from <username@domain>
      const match = mail.match(/<([^@\s>]+)/);
      if (match && match[1]) {
        authors.push(match[1].toLowerCase());
      }
    } else if (line.startsWith("author ")) {
      const name = line.substring("author ".length).trim();
      if (name && name !== "Not Committed Yet") {
        authors.push(name.replace(/\s+/g, "-").toLowerCase());
      }
    }
  }
  return authors;
}

export async function routeReviewers(input: RouteReviewersInput): Promise<RouteReviewersOutput> {
  const { proposal, repo, policy = "blame-weighted", maxReviewersPerSlice = 2, excludeUsers = [] } = input;
  const repoPath = path.resolve(repo);

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repo}`);
  }

  const codeownersRules = loadCodeownersRules(repoPath);
  const normalizedExclude = excludeUsers.map(u => u.replace(/^@/, "").toLowerCase());

  const assignments: SliceAssignment[] = [];
  const unassigned: string[] = [];

  for (const slice of proposal.slices) {
    // 1. Gather all files in this slice
    const files = Array.from(new Set(slice.hunks.map(h => h.filePath)));

    // 2. CODEOWNERS score
    const codeownersMatches = new Map<string, number>(); // owner -> matches count
    for (const file of files) {
      // Find the last matching rule
      let matchingRule: CodeownersRule | null = null;
      for (let i = codeownersRules.length - 1; i >= 0; i--) {
        if (matchPathPattern(file, codeownersRules[i].pattern)) {
          matchingRule = codeownersRules[i];
          break;
        }
      }
      if (matchingRule) {
        for (const owner of matchingRule.owners) {
          const normOwner = owner.toLowerCase();
          if (!normalizedExclude.includes(normOwner)) {
            codeownersMatches.set(normOwner, (codeownersMatches.get(normOwner) || 0) + 1);
          }
        }
      }
    }

    // 3. Git Blame score
    const blameCounts = new Map<string, number>();
    let totalBlameLines = 0;
    
    // Blame in parallel with timeout safety
    await withTimeout(
      Promise.all(
        slice.hunks.map(async (hunk) => {
          const authors = await blameHunk(repoPath, hunk.filePath, hunk.oldStart, hunk.oldLines);
          for (const author of authors) {
            if (!normalizedExclude.includes(author)) {
              blameCounts.set(author, (blameCounts.get(author) || 0) + 1);
              totalBlameLines++;
            }
          }
        })
      ),
      15000 // 15s cap for blame computation
    ).catch((err) => {
      logger.warn("blame_timeout", { sliceId: slice.id, error: err.message });
    });

    // 4. Combine scores
    const candidates = new Map<string, { codeownersScore: number; blameScore: number }>();
    
    // Fill codeowners scores (fraction of files in the slice owned)
    for (const [owner, count] of codeownersMatches.entries()) {
      candidates.set(owner, { codeownersScore: count / files.length, blameScore: 0 });
    }

    // Fill blame scores (fraction of blamed lines owned)
    for (const [author, count] of blameCounts.entries()) {
      const existing = candidates.get(author) || { codeownersScore: 0, blameScore: 0 };
      existing.blameScore = totalBlameLines > 0 ? count / totalBlameLines : 0;
      candidates.set(author, existing);
    }

    // Compute final weights
    const reviewers: Reviewer[] = [];
    for (const [name, score] of candidates.entries()) {
      let weight = 0;
      let reason = "";

      if (policy === "codeowners-strict") {
        if (score.codeownersScore > 0) {
          weight = score.codeownersScore;
          reason = `CODEOWNERS owner of ${Math.round(score.codeownersScore * files.length)}/${files.length} files`;
        }
      } else {
        // blame-weighted or expertise-graph fallback
        const coPart = 0.6 * score.codeownersScore;
        const blamePart = 0.4 * score.blameScore;
        weight = coPart + blamePart;

        const reasons: string[] = [];
        if (score.codeownersScore > 0) {
          reasons.push(`owns ${Math.round(score.codeownersScore * files.length)}/${files.length} files via CODEOWNERS`);
        }
        if (score.blameScore > 0) {
          reasons.push(`wrote ${Math.round(score.blameScore * 100)}% of modified lines`);
        }
        reason = reasons.join(" and ");
      }

      if (weight > 0) {
        reviewers.push({
          login: name,
          reason,
          weight: Math.min(1, Math.max(0, parseFloat(weight.toFixed(3)))),
        });
      }
    }

    // Sort by weight descending
    reviewers.sort((a, b) => b.weight - a.weight);

    // Slice suggestions to maxReviewersPerSlice
    const finalReviewers = reviewers.slice(0, maxReviewersPerSlice);

    if (finalReviewers.length > 0) {
      assignments.push({
        sliceId: slice.id,
        reviewers: finalReviewers,
      });
    } else {
      unassigned.push(slice.id);
    }
  }

  return {
    schemaVersion: "1",
    assignments,
    unassigned,
  };
}
