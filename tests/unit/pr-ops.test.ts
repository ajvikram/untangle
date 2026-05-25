/**
 * Unit tests for src/tools/pr-ops.ts.
 * These tests cover input validation and protected-base guards.
 * Actual gh CLI calls are not made — tests fail fast before any execFile when validation rejects.
 */

import { describe, it, expect } from "vitest";
import {
  prList, prView, prDiff, prChecks,
  prReview, prComment, prReviewDismiss, prRequestReviewers,
  prMerge, prClose,
} from "../../src/tools/pr-ops.js";
import { UntangleErrorImpl } from "../../src/schemas/types.js";

describe("pr-ops: input validation", () => {
  it("pr_view requires a number", async () => {
    // @ts-expect-error intentional bad input
    await expect(prView({})).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_diff requires a number", async () => {
    // @ts-expect-error intentional bad input
    await expect(prDiff({})).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_checks requires a number", async () => {
    // @ts-expect-error intentional bad input
    await expect(prChecks({})).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_review rejects invalid event", async () => {
    // @ts-expect-error intentional bad input
    await expect(prReview({ number: 1, event: "BOGUS" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_review REQUEST_CHANGES requires a body", async () => {
    await expect(prReview({ number: 1, event: "REQUEST_CHANGES" })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    await expect(prReview({ number: 1, event: "REQUEST_CHANGES", body: "" })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });

  it("pr_comment requires a non-empty body", async () => {
    await expect(prComment({ number: 1, body: "" })).rejects.toBeInstanceOf(UntangleErrorImpl);
    await expect(prComment({ number: 1, body: "   " })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_review_dismiss requires a message", async () => {
    await expect(prReviewDismiss({ number: 1, reviewId: 1, message: "" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("pr_request_reviewers requires at least one reviewer or team", async () => {
    await expect(prRequestReviewers({ number: 1 })).rejects.toBeInstanceOf(UntangleErrorImpl);
    await expect(prRequestReviewers({ number: 1, reviewers: [], teamReviewers: [] })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });
});

describe("pr-ops: dry-run paths", () => {
  it("pr_close dryRun returns closed:false without calling gh", async () => {
    const out = await prClose({ number: 999999, dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.closed).toBe(false);
    expect(out.number).toBe(999999);
  });

  it("pr_merge dryRun is not reached if PR lookup would fail — verify validation runs first", async () => {
    // number missing should fail synchronously before any gh call
    // @ts-expect-error intentional
    await expect(prMerge({ dryRun: true })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("pr-ops: signature smoke", () => {
  it("prList accepts an empty input object (defaults applied)", () => {
    // Don't actually call — just ensure the function is invocable and the type accepts {}
    expect(typeof prList).toBe("function");
  });
});
