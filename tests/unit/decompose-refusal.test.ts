/**
 * Regression: decompose used to fall through into apply_split with non-branch
 * targets and crash with "apply_split only supports branch targets". It must
 * now refuse upfront with a helpful BAD_INPUT/NOT_IMPLEMENTED message that
 * tells the caller how to proceed.
 */

import { describe, it, expect } from "vitest";
import { decompose } from "../../src/tools/decompose.js";

describe("decompose: refuses unactionable targets early", () => {
  it("rejects kind:'working' with a hint to commit + use kind:'branch'", async () => {
    await expect(
      decompose({ target: { kind: "working", repo: "/tmp/whatever" } }),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("Commit your changes first"),
    });
  });

  it("rejects kind:'diff' with a clear message", async () => {
    await expect(
      decompose({ target: { kind: "diff", content: "@@ -1 +1 @@\n-a\n+b\n" } }),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("kind:'branch'"),
    });
  });

  it("rejects kind:'pr' with NOT_IMPLEMENTED", async () => {
    await expect(
      decompose({ target: { kind: "pr", repo: "/r", number: 1 } }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("rejects { repo, mode:'unstaged' } (normalizes to working, then refuses)", async () => {
    await expect(
      decompose({ target: { repo: "/tmp/whatever", mode: "unstaged" } as never }),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("working-tree"),
    });
  });
});
