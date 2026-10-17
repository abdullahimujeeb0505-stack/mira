import type { OpportunityType } from "../opportunities/opportunity-types.js";

/**
 * Classifies the primary opportunity mechanism.
 * Classification does not prove legitimacy, availability, or eligibility.
 */
export function inferOpportunityType(
  title: string,
  description: string,
): OpportunityType {
  const text = `${title} ${description}`.toLowerCase();

  if (/\b(bug bounty|bug bounties|bounty program|bounty hunter|bounties|bounty)\b/.test(text)) return "BOUNTY";
  if (/\b(grant|funding|grants|ecosystem funding)\b/.test(text)) return "GRANT";
  if (/\b(hackathon|competition|prize pool|contest)\b/.test(text)) return "COMPETITION";
  if (/\b(airdrop|token reward|token distribution)\b/.test(text)) return "AIRDROP";
  if (/\b(whitelist|waitlist|allowlist)\b/.test(text)) return "WL";
  if (/\b(campaign|quest|rewards campaign)\b/.test(text)) return "CAMPAIGN";
  if (/\b(free mint)\b/.test(text)) return "FREE_MINT";
  if (/\b(launchpad|product launch|accelerator|launch)\b/.test(text)) return "PRODUCT_LAUNCH";
  if (/\b(write for us|writing contest|content campaign|content bounty|article contest)\b/.test(text)) return "CONTENT";

  return "OTHER";
}
