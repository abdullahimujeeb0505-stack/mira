import assert from "node:assert/strict";
import test from "node:test";
import { inferOpportunityType } from "./opportunity-type-inference.js";

test("recognizes Immunefi-style bounty opportunities", () => {
  assert.equal(
    inferOpportunityType(
      "Immunefi - cybersecurity's most rewarding frontier",
      "Explore bug bounties, review code, and submit vulnerabilities for rewards.",
    ),
    "BOUNTY",
  );
  assert.equal(
    inferOpportunityType("Web3 Bounty Program", "Write a report and earn rewards."),
    "BOUNTY",
  );
});

test("classifies common opportunity mechanisms", () => {
  assert.equal(inferOpportunityType("Ecosystem Grants", "Funding for builders"), "GRANT");
  assert.equal(inferOpportunityType("Global Student Hackathon", "$69K prize pool"), "COMPETITION");
  assert.equal(inferOpportunityType("Token Airdrop", "Token distribution"), "AIRDROP");
  assert.equal(inferOpportunityType("Community Quest Campaign", "Complete tasks for rewards"), "CAMPAIGN");
  assert.equal(inferOpportunityType("Write for Us", "Submit an article for payment"), "CONTENT");
  assert.equal(inferOpportunityType("Unknown community update", "General project news"), "OTHER");
});

test("does not classify a generic security article as a bounty", () => {
  assert.equal(
    inferOpportunityType("Web3 Security Analysis", "An educational article about smart contract audits."),
    "OTHER",
  );
});
