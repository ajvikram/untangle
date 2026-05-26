/**
 * decompose target validation: unsupported target kinds must fail early with
 * clear messages. kind:'working' is now supported (auto-commits and proceeds).
 */

import { describe, it, expect } from "vitest";
import { decompose } from "../../src/tools/decompose.js";

describe("decompose: refuses unactionable targets early", () => {
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
});
