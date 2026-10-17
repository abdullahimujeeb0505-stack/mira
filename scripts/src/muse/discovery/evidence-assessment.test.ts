import assert from "node:assert/strict";
import test from "node:test";
import { assessVerificationEvidence } from "./evidence-assessment.js";
import type { SourceVerification } from "./source-verification.js";

function verification(
  overrides: Partial<SourceVerification> = {},
): SourceVerification {
  return {
    discoveryId: "test-discovery",
    url: "https://example.org/opportunity",
    checkedAt: "2026-10-16T00:00:00.000Z",
    status: "SOURCE_REACHABLE",
    httpStatus: 200,
    pageTitle: "Example opportunity",
    pageTextExcerpt: "",
    applicationLinks: [],
    deadlineClues: [],
    eligibilityClues: [],
    rewardClues: [],
    warnings: [],
    ...overrides,
  };
}

test("reachable source does not imply a confirmed offer", () => {
  const result = assessVerificationEvidence(verification());
  assert.equal(result.sourceAccessibility, "REACHABLE");
  assert.equal(result.offer, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.eligibility, "UNKNOWN");
  assert.equal(result.deadline, "UNKNOWN");
  assert.equal(result.rewards, "UNKNOWN");
});

test("application links indicate evidence to review, not confirmation", () => {
  const result = assessVerificationEvidence(verification({
    applicationLinks: [{ text: "Apply", url: "https://example.org/apply" }],
  }));
  assert.equal(result.offer, "EVIDENCE_FOUND_REQUIRES_CONFIRMATION");
  assert.equal(result.eligibility, "UNKNOWN");
});

test("deadline, eligibility, and reward clues remain separate", () => {
  const result = assessVerificationEvidence(verification({
    deadlineClues: ["Applications close November 5"],
    eligibilityClues: ["Open to university students"],
    rewardClues: ["Up to $5,000 in prizes"],
  }));
  assert.equal(result.deadline, "CLUES_FOUND_REQUIRES_DATE_EXTRACTION");
  assert.equal(result.eligibility, "CLUES_FOUND_REQUIRES_REVIEW");
  assert.equal(result.rewards, "CLAIMS_FOUND_UNCONFIRMED");
  assert.equal(result.offer, "EVIDENCE_FOUND_REQUIRES_CONFIRMATION");
});

test("inaccessible sources cannot be labelled reachable", () => {
  for (const [status, expected] of [
    ["INACCESSIBLE", "INACCESSIBLE_OR_HTTP_ERROR"],
    ["HTTP_ERROR", "INACCESSIBLE_OR_HTTP_ERROR"],
    ["REDIRECT_NOT_FOLLOWED", "REDIRECT_BLOCKED"],
    ["UNSAFE_URL", "UNSAFE_URL"],
  ] as const) {
    const result = assessVerificationEvidence(verification({ status }));
    assert.equal(result.sourceAccessibility, expected);
  }
});

test("evidence assessments always disclose their limitations", () => {
  const result = assessVerificationEvidence(verification());
  assert.ok(result.limitations.length >= 4);
});

test("HTTP 403 and 405 are classified as access blocked", () => {
  for (const httpStatus of [403, 405]) {
    const result = assessVerificationEvidence({
      status: "HTTP_ERROR",
      httpStatus,
      applicationLinks: [],
      deadlineClues: ["Applications close soon"],
      eligibilityClues: [],
      rewardClues: ["$10,000 prize pool"],
    });

    assert.equal(result.sourceAccessibility, "ACCESS_BLOCKED");
    assert.equal(result.offer, "INSUFFICIENT_EVIDENCE");
    assert.ok(
      result.limitations.some((item) => item.includes("blocked verification")),
    );
  }
});
