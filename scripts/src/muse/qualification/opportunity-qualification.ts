export type QualificationDecision =
  | "QUALIFIED"
  | "REJECTED"
  | "REVIEW";

export interface QualificationInput {
  title: string;
  description: string;
  sourceUrl?: string | null;
}

export interface QualificationResult {
  decision: QualificationDecision;
  reasons: string[];
  evidence: string[];
}

const EXCLUSION_SIGNALS: Array<[RegExp, string]> = [
  [/\btop\b.{0,100}\b(platforms?|programs?|grants?|accelerators?)\b/i, "Generic directory or roundup rather than a specific offer"],
  [/\bwhat\s+\d+\s+.*\b(tell|reveals?|shows?)\b/i, "Retrospective analysis rather than an actionable opportunity"],
  [/\b(waitlist|allowlist|token drop)\s+software\b|\bsoftware\s+for\s+(waitlists?|allowlists?)\b/i, "Software product rather than an opportunity to join"],
  [/\b(raises?\s+\$|raised\s+\$|series [a-f]\s+round|funding round|leads?\s+\$.*round|secures?\s+\$.*funding)\b/i, "Funding news rather than an application opportunity"],
  [/\b(top \d+|best \d+|curated directory|complete list|projects to watch)\b/i, "Generic directory or roundup rather than a specific offer"],
  [/\b(security analysis|security review|attack vector|flash loan attack|vulnerability analysis|exploit analysis|postmortem)\b/i, "Security analysis or incident coverage"],
  [/\b(price prediction|market analysis|technical analysis|weekly roundup|news roundup)\b/i, "General news or market commentary"],
  [/\b(opinion|editorial|explained|what is|how to|tutorial|guide to)\b/i, "Educational or editorial content without an offer"],
];

const OFFER_SIGNALS: Array<[RegExp, string]> = [
  [/\b(apply now|apply here|applications? (are )?open|apply for)\b/i, "Application call to action"],
  [/\b(submit (your|a) (project|application|proposal)|application form|submission form)\b/i, "Submission process"],
  [/\b(grant program|grants program|funding program|builder program|accelerator program)\b/i, "Named funding or builder program"],
  [/\b(prize pool|cash prize|bounty reward|grant funding|funding up to)\b/i, "Explicit reward or funding"],
  [/\b(register now|join the waitlist|sign up for early access|open for registration)\b/i, "Registration or waitlist call to action"],
  [/\b(hackathon|competition|contest|bounty|grant|airdrop|whitelist|waitlist)\b/i, "Opportunity-type signal"],
];

const ACTION_SIGNALS: Array<[RegExp, string]> = [
  [/\b(apply|application|submit|submission|register|registration|join|sign up|waitlist|eligibility|deadline|prize pool|reward|funding|grant|bounty)\b/i, "Actionable participation details"],
];

export function qualifyOpportunity(
  input: QualificationInput,
): QualificationResult {
  const title = input.title.trim();
  const description = input.description.trim();
  const text = `${title}\n${description}`.slice(0, 15000);



  if (!title || !description) {
    return {
      decision: "REVIEW",
      reasons: ["Missing title or description"],
      evidence: [],
    };
  }

  for (const [pattern, reason] of EXCLUSION_SIGNALS) {
    if (pattern.test(title) || pattern.test(description)) {
      return {
        decision: "REJECTED",
        reasons: [reason, "Exclusion signal found in title or description"],
        evidence: [title, description.slice(0, 300)],
      };
    }
  }

  // Potentially stale announcements require fresh evidence before qualification.
  const staleOrClosed =
    /\b(202[0-5]|expired|applications? have closed|applications? closed|past deadline|winners announced|results announced|retrospective)\b/i
      .test(text);

  if (staleOrClosed) {
    return {
      decision: "REVIEW",
      reasons: ["Potentially stale or retrospective opportunity; verify current status"],
      evidence: [title, description.slice(0, 300)],
    };
  }

  const offerEvidence = OFFER_SIGNALS
    .filter(([pattern]) => pattern.test(text))
    .map(([, label]) => label);

  const actionEvidence = ACTION_SIGNALS
    .filter(([pattern]) => pattern.test(text))
    .map(([, label]) => label);

  if (offerEvidence.length >= 2 && actionEvidence.length > 0) {
    return {
      decision: "QUALIFIED",
      reasons: ["Multiple offer signals and an actionable participation signal were found"],
      evidence: [...new Set([...offerEvidence, ...actionEvidence])],
    };
  }

  if (offerEvidence.length > 0 || actionEvidence.length > 0) {
    return {
      decision: "REVIEW",
      reasons: ["Possible opportunity, but evidence is insufficient to confirm an actionable offer"],
      evidence: [...new Set([...offerEvidence, ...actionEvidence])],
    };
  }

  return {
    decision: "REJECTED",
    reasons: ["No actionable offer or participation evidence found"],
    evidence: [],
  };
}
