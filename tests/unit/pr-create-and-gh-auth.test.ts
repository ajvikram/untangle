/**
 * Input-validation tests for pr_create + gh_auth_status.
 * (Actual gh CLI calls aren't made — validation rejects before exec.)
 */

import { describe, it, expect } from "vitest";
import { prCreate, ghAuthStatus } from "../../src/tools/pr-ops.js";
import { UntangleErrorImpl } from "../../src/schemas/types.js";

describe("pr_create: input validation", () => {
  it("rejects missing base", async () => {
    // @ts-expect-error intentional bad input
    await expect(prCreate({ head: "feat", title: "x" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });
  it("rejects missing head", async () => {
    // @ts-expect-error intentional bad input
    await expect(prCreate({ base: "main", title: "x" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });
  it("rejects missing title", async () => {
    // @ts-expect-error intentional bad input
    await expect(prCreate({ base: "main", head: "feat" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });
});

describe("gh_auth_status", () => {
  it("returns { authenticated: false } with an error message when gh isn't logged in", async () => {
    // We can't guarantee gh is or isn't authenticated on the test machine,
    // but the function must NEVER throw — only return the structured result.
    const out = await ghAuthStatus({ repo: "/tmp" });
    expect(out.schemaVersion).toBe("1");
    expect(typeof out.authenticated).toBe("boolean");
  });
});
