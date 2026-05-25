/**
 * Regression: { repo, base, head } and { repo, mode } shapes used to fail with
 * "PR target not yet supported". They must now normalize correctly.
 */

import { describe, it, expect } from "vitest";
import { normalizeTarget, UntangleErrorImpl } from "../../src/schemas/types.js";

describe("normalizeTarget", () => {
  it("passes through explicit kind:'branch'", () => {
    const out = normalizeTarget({ kind: "branch", repo: "/r", branch: "feat", base: "main" });
    expect(out).toEqual({ kind: "branch", repo: "/r", branch: "feat", base: "main" });
  });

  it("aliases `head` to `branch` when caller used the wrong field", () => {
    const out = normalizeTarget({ repo: "/r", base: "main", head: "dev" });
    expect(out).toEqual({ kind: "branch", repo: "/r", branch: "dev", base: "main" });
  });

  it("infers kind:'branch' from { repo, base, branch } (no kind)", () => {
    const out = normalizeTarget({ repo: "/r", base: "main", branch: "feat" });
    expect(out).toEqual({ kind: "branch", repo: "/r", branch: "feat", base: "main" });
  });

  it("infers kind:'pr' from { repo, number }", () => {
    expect(normalizeTarget({ repo: "/r", number: 42 })).toEqual({ kind: "pr", repo: "/r", number: 42 });
  });

  it("infers kind:'diff' from { content }", () => {
    expect(normalizeTarget({ content: "@@ -1 +1 @@" })).toMatchObject({ kind: "diff", content: "@@ -1 +1 @@" });
  });

  it("infers kind:'working' from { repo } alone (defaults mode:'head')", () => {
    expect(normalizeTarget({ repo: "/r" })).toEqual({ kind: "working", repo: "/r", mode: "head" });
  });

  it("infers kind:'working' from { repo, mode }", () => {
    expect(normalizeTarget({ repo: "/r", mode: "staged" })).toEqual({ kind: "working", repo: "/r", mode: "staged" });
  });

  it("accepts `type` as alias for `kind`", () => {
    expect(normalizeTarget({ type: "working", repo: "/r", mode: "working" }))
      .toEqual({ type: "working", kind: "working", repo: "/r", mode: "working" });
  });

  it("throws BAD_INPUT with a helpful hint for unrecognized shape", () => {
    try {
      normalizeTarget({ foo: "bar" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UntangleErrorImpl);
      const msg = (e as UntangleErrorImpl).message;
      expect(msg).toContain("kind:'branch'");
      expect(msg).toContain("Shortcuts");
    }
  });

  it("throws when target is null", () => {
    expect(() => normalizeTarget(null)).toThrow(UntangleErrorImpl);
  });
});
