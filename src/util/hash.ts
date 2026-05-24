/**
 * Stable SHA-256 helpers for deterministic IDs.
 */

import { createHash } from "node:crypto";

/** SHA-256 hash of a string, truncated to `len` hex chars (default 12). */
export function sha256(input: string, len = 12): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, len);
}

/** Canonical hash of an array of strings — order-independent. */
export function canonicalHash(items: string[], len = 12): string {
  const sorted = [...items].sort();
  return sha256(sorted.join("|"), len);
}
