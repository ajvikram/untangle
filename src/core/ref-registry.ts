/**
 * Ref registry — tracks git refs created in the current call.
 * §S1: never delete unmerged work we didn't create.
 */

import { UntangleErrorImpl } from "../schemas/types.js";

export class RefRegistry {
  private readonly created = new Set<string>();

  /** Register a ref as created in this invocation. */
  add(ref: string): void {
    this.created.add(ref);
  }

  /** Check if a ref was created by us. */
  has(ref: string): boolean {
    return this.created.has(ref);
  }

  /** List all refs we created. */
  list(): string[] {
    return [...this.created];
  }

  /**
   * Delete a ref — only if we created it.
   * Throws REF_NOT_OWNED otherwise (§S1).
   */
  async delete(ref: string): Promise<void> {
    if (!this.created.has(ref)) {
      throw new UntangleErrorImpl(
        "REF_NOT_OWNED",
        `Cannot delete ref '${ref}' — not created in this invocation`,
        false,
        { ref },
      );
    }
    this.created.delete(ref);
  }

  /** Clear registry (used after successful completion). */
  clear(): void {
    this.created.clear();
  }
}
