import test from "node:test";
import assert from "node:assert/strict";
import { qualifyOpportunity } from "./opportunity-qualification.js";

test("rejects a security analysis article", () => {
  const result = qualifyOpportunity({
    title: "Flash Loan Attack Vector Analysis: HTX",
    description: "A technical analysis of potential vulnerabilities.",
  });
  assert.equal(result.decision, "REJECTED");
});

test("qualifies an explicit hackathon offer", () => {
  const result = qualifyOpportunity({
    title: "Web3 Builder Hackathon: Applications Open",
    description: "Apply now. Submit your project before the deadline. The hackathon has a prize pool for selected builders.",
  });
  assert.equal(result.decision, "QUALIFIED");
});

test("sends ambiguous grant mentions to review", () => {
  const result = qualifyOpportunity({
    title: "Protocol update mentions a grant",
    description: "The project discussed its ecosystem grant in a recent update.",
  });
  assert.equal(result.decision, "REVIEW");
});

test("rejects unrelated general news", () => {
  const result = qualifyOpportunity({
    title: "Crypto market weekly roundup",
    description: "A summary of market movements and token prices.",
  });
  assert.equal(result.decision, "REJECTED");
});

test("does not qualify an opportunity based on one keyword alone", () => {
  const result = qualifyOpportunity({
    title: "A new grant was announced",
    description: "The article discusses the grant but gives no application process.",
  });
  assert.notEqual(result.decision, "QUALIFIED");
});


test("rejects funding-round news rather than treating it as an opportunity", () => {
  const result = qualifyOpportunity({
    title: "Immunefi raises $24M in funding",
    description: "The security platform raised $24M in a funding round.",
  });
  assert.equal(result.decision, "REJECTED");
});

test("rejects generic opportunity directories", () => {
  const result = qualifyOpportunity({
    title: "Top 50 Web3 Grants: Complete List",
    description: "A curated directory of grants and funding programs.",
  });
  assert.equal(result.decision, "REJECTED");
});

test("detects funding-news exclusions in the description", () => {
  const result = qualifyOpportunity({
    title: "Immunefi ecosystem update",
    description: "The company raised $24M in a funding round.",
  });
  assert.equal(result.decision, "REJECTED");
});


test("rejects generic accelerator and bounty platform directories", () => {
  for (const title of [
    "Top Platforms Hosting Web3 Bug Bounty Programs - Hashlock",
    "Top Web3 Accelerator Programs for Crypto Startups - Hashlock",
  ]) {
    assert.equal(qualifyOpportunity({
      title,
      description: "A list of platforms and programs to explore.",
    }).decision, "REJECTED", title);
  }
});

test("rejects retrospective startup application analysis", () => {
  assert.equal(qualifyOpportunity({
    title: "What 600 Startup Applications Tell About Blockchain & AI in 2024",
    description: "An analysis of historical startup applications.",
  }).decision, "REJECTED");
});

test("rejects waitlist software products as opportunities", () => {
  assert.equal(qualifyOpportunity({
    title: "Crypto Waitlist Software — Token Drop & NFT Allowlist Waitlist",
    description: "Software for creating a token waitlist.",
  }).decision, "REJECTED");
});


test("routes stale announcements to review", () => {
  const result = qualifyOpportunity({
    title: "Web3 Builder Hackathon 2024: Applications Open",
    description: "Apply now. Submit your project before the deadline. The hackathon has a prize pool.",
  });
  assert.equal(result.decision, "REVIEW");
});

test("keeps a current-year actionable hackathon qualified", () => {
  const result = qualifyOpportunity({
    title: "Web3 Builder Hackathon 2026: Applications Open",
    description: "Apply now. Submit your project before the deadline. The hackathon has a prize pool for selected builders.",
  });
  assert.equal(result.decision, "QUALIFIED");
});


test("preserves retrospective exclusions before stale review", () => {
  const result = qualifyOpportunity({
    title: "What 600 Startup Applications Tell About Blockchain & AI in 2024",
    description: "An analysis of historical startup applications.",
  });
  assert.equal(result.decision, "REJECTED");
});
