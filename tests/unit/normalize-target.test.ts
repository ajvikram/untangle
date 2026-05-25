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

  it("accepts 'unstaged' as alias for mode:'working'", () => {
    expect(normalizeTarget({ repo: "/r", mode: "unstaged" })).toEqual({ kind: "working", repo: "/r", mode: "working" });
  });

  it("accepts 'cached'/'index' as alias for mode:'staged'", () => {
    expect(normalizeTarget({ repo: "/r", mode: "cached" })).toEqual({ kind: "working", repo: "/r", mode: "staged" });
    expect(normalizeTarget({ repo: "/r", mode: "index" })).toEqual({ kind: "working", repo: "/r", mode: "staged" });
  });

  it("accepts `type` as alias for `kind`", () => {
    expect(normalizeTarget({ type: "working", repo: "/r", mode: "working" }))
      .toEqual({ kind: "working", repo: "/r", mode: "working" });
  });

  it("defaults missing `repo` to process.cwd() (no throw)", () => {
    const out = normalizeTarget({ base: "main", branch: "dev" });
    expect(out.kind).toBe("branch");
    expect(out).toMatchObject({ kind: "branch", branch: "dev", base: "main" });
    // repo is process.cwd() — just assert it's a non-empty string
    expect((out as { repo: string }).repo).toBeTruthy();
  });

  it("falls back to kind:'working' for under-specified objects rather than throwing", () => {
    const out = normalizeTarget({ foo: "bar" });
    expect(out.kind).toBe("working");
    expect((out as { repo: string }).repo).toBeTruthy();
  });

  it("throws BAD_INPUT for kind:'branch' missing base/branch", () => {
    expect(() => normalizeTarget({ kind: "branch", repo: "/r" }))
      .toThrow(UntangleErrorImpl);
  });

  it("throws BAD_INPUT for kind:'diff' missing content", () => {
    expect(() => normalizeTarget({ kind: "diff" })).toThrow(UntangleErrorImpl);
  });

  it("throws BAD_INPUT for unknown kind", () => {
    expect(() => normalizeTarget({ kind: "wibble", repo: "/r" })).toThrow(UntangleErrorImpl);
  });

  it("throws when target is null", () => {
    expect(() => normalizeTarget(null)).toThrow(UntangleErrorImpl);
  });
});
