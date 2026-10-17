import type { SourceVerification } from "./source-verification.js";

export type SourceAccessibility =
  | "REACHABLE"
  | "ACCESS_BLOCKED"
  | "INACCESSIBLE_OR_HTTP_ERROR"
  | "REDIRECT_BLOCKED"
  | "UNSAFE_URL";

export type OfferAssessment =
  | "EVIDENCE_FOUND_REQUIRES_CONFIRMATION"
  | "INSUFFICIENT_EVIDENCE";

export type EligibilityAssessment =
  | "CLUES_FOUND_REQUIRES_REVIEW"
  | "UNKNOWN";

export type DeadlineAssessment =
  | "CLUES_FOUND_REQUIRES_DATE_EXTRACTION"
  | "UNKNOWN";

export type RewardAssessment =
  | "CLAIMS_FOUND_UNCONFIRMED"
  | "UNKNOWN";

export interface EvidenceAssessment {
  sourceAccessibility: SourceAccessibility;
  offer: OfferAssessment;
  eligibility: EligibilityAssessment;
  deadline: DeadlineAssessment;
  rewards: RewardAssessment;
  limitations: string[];
}

/**
 * Derives cautious review labels from extracted page evidence.
 * This is not a legitimacy check, eligibility decision, or offer confirmation.
 */
export function assessVerificationEvidence(
  result: Pick<
    SourceVerification,
    | "status"
    | "httpStatus"
    | "applicationLinks"
    | "deadlineClues"
    | "eligibilityClues"
    | "rewardClues"
  >,
): EvidenceAssessment {
  const blocked =
    result.status === "HTTP_ERROR" &&
    [401, 403, 405, 429].includes(result.httpStatus ?? 0);

  const sourceAccessibility: SourceAccessibility =
    result.status === "SOURCE_REACHABLE"
      ? "REACHABLE"
      : blocked
        ? "ACCESS_BLOCKED"
        : result.status === "REDIRECT_NOT_FOLLOWED"
          ? "REDIRECT_BLOCKED"
          : result.status === "UNSAFE_URL"
            ? "UNSAFE_URL"
            : "INACCESSIBLE_OR_HTTP_ERROR";

  // A server-blocked page must not be treated as verified offer evidence.
  const offerEvidenceFound =
    !blocked &&
    (
      result.applicationLinks.length > 0 ||
      result.deadlineClues.length > 0 ||
      result.eligibilityClues.length > 0 ||
      result.rewardClues.length > 0
    );

  return {
    sourceAccessibility,
    offer: offerEvidenceFound
      ? "EVIDENCE_FOUND_REQUIRES_CONFIRMATION"
      : "INSUFFICIENT_EVIDENCE",
    eligibility: result.eligibilityClues.length > 0
      ? "CLUES_FOUND_REQUIRES_REVIEW"
      : "UNKNOWN",
    deadline: result.deadlineClues.length > 0
      ? "CLUES_FOUND_REQUIRES_DATE_EXTRACTION"
      : "UNKNOWN",
    rewards: result.rewardClues.length > 0
      ? "CLAIMS_FOUND_UNCONFIRMED"
      : "UNKNOWN",
    limitations: [
      "Extracted clues are not independently confirmed facts.",
      "Application links are not proof that applications are open.",
      "Eligibility requires checking the actual program rules.",
      "Deadline clues require extracting and validating a specific date.",
      "Reward claims do not establish guaranteed or currently available payouts.",
      ...(blocked
        ? ["The source blocked verification; extracted claims cannot establish an actionable offer."]
        : []),
    ],
  };
}
