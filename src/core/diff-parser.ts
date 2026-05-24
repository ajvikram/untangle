/**
 * Unified diff parser — converts a raw unified diff string into HunkRef[].
 * No LLM, no tree-sitter — pure string parsing.
 */

import { sha256 } from "../util/hash.js";
import type { HunkRef } from "../schemas/types.js";

/** File-level parsed diff result (internal). */
export interface FileDiff {
  filePath: string;
  isBinary: boolean;
  isRename: boolean;
  hunks: HunkRef[];
}

/**
 * Parse a unified diff string into per-file diff results.
 */
export function parseDiff(raw: string): FileDiff[] {
  if (!raw || raw.trim().length === 0) return [];

  const results: FileDiff[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Start of a new file diff
    if (line.startsWith("diff --git")) {
      const fileDiff = parseFileDiff(lines, i);
      if (fileDiff) {
        results.push(fileDiff.file);
        i = fileDiff.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return results;
}

/** Extract all HunkRefs from parsed file diffs. */
export function extractHunks(raw: string): HunkRef[] {
  return parseDiff(raw).flatMap((f) => f.hunks);
}

/**
 * Extract the file path from a unified diff header.
 * Handles "a/path" and "b/path" prefixes.
 */
function extractFilePath(diffHeader: string): string {
  // Try to extract from "diff --git a/path b/path"
  const match = diffHeader.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (match) {
    // Prefer the "b" (new) path for renames
    return match[2]!;
  }
  return "unknown";
}

function isRename(lines: string[], startIdx: number, endIdx: number): boolean {
  for (let i = startIdx; i < endIdx && i < lines.length; i++) {
    if (lines[i]!.startsWith("rename from ") || lines[i]!.startsWith("rename to ")) {
      return true;
    }
  }
  return false;
}

function isBinary(lines: string[], startIdx: number, endIdx: number): boolean {
  for (let i = startIdx; i < endIdx && i < lines.length; i++) {
    if (lines[i]!.includes("Binary files") || lines[i]!.startsWith("GIT binary patch")) {
      return true;
    }
  }
  return false;
}

interface ParsedFileDiff {
  file: FileDiff;
  nextIndex: number;
}

function parseFileDiff(lines: string[], startIdx: number): ParsedFileDiff | null {
  const header = lines[startIdx]!;
  const filePath = extractFilePath(header);

  // Find end of this file's diff (next "diff --git" or EOF)
  let endIdx = startIdx + 1;
  while (endIdx < lines.length && !lines[endIdx]!.startsWith("diff --git")) {
    endIdx++;
  }

  const binary = isBinary(lines, startIdx, endIdx);
  const rename = isRename(lines, startIdx, endIdx);

  if (binary) {
    // Binary files get a single synthetic hunk
    const hunkText = lines.slice(startIdx, endIdx).join("\n");
    return {
      file: {
        filePath,
        isBinary: true,
        isRename: rename,
        hunks: [{
          filePath,
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          hash: sha256(hunkText),
        }],
      },
      nextIndex: endIdx,
    };
  }

  // Parse text hunks
  const hunks: HunkRef[] = [];
  let i = startIdx + 1;
  while (i < endIdx) {
    const l = lines[i]!;

    if (l.startsWith("@@")) {
      // Parse hunk header: @@ -old,count +new,count @@
      const hunkMatch = l.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        const oldStart = parseInt(hunkMatch[1]!, 10);
        const oldLines = parseInt(hunkMatch[2] ?? "1", 10);
        const newStart = parseInt(hunkMatch[3]!, 10);
        const newLines = parseInt(hunkMatch[4] ?? "1", 10);

        // Collect hunk body for hash
        const hunkBodyStart = i;
        i++;
        while (i < endIdx && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git")) {
          i++;
        }
        const hunkBody = lines.slice(hunkBodyStart, i).join("\n");

        hunks.push({
          filePath,
          oldStart,
          oldLines,
          newStart,
          newLines,
          hash: sha256(hunkBody),
        });
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return {
    file: {
      filePath,
      isBinary: false,
      isRename: rename,
      hunks,
    },
    nextIndex: endIdx,
  };
}

/**
 * Compute total lines of change (added + removed) from raw diff.
 */
export function computeLoC(raw: string): number {
  let loc = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) loc++;
    if (line.startsWith("-") && !line.startsWith("---")) loc++;
  }
  return loc;
}

/**
 * Extract unique file paths from a unified diff.
 */
export function extractFilePaths(raw: string): string[] {
  return [...new Set(parseDiff(raw).map((f) => f.filePath))];
}
