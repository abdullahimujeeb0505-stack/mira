import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMuseReadiness,
  inspectMuseReadiness,
} from "./preflight.mjs";

const validEnv = {
  SESSION_SECRET: "configured-session-secret",
  MUSE_CHAT_ACCESS_TOKEN: "a".repeat(32),
  GROK_API_CODING_KEY: "configured-provider-key",
};

test("reports readiness for Groq without exposing configured values", () => {
  const report = inspectMuseReadiness(validEnv, true);
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /PASS: GROK_API_CODING_KEY/);
  assert.doesNotMatch(output, /configured-session-secret|configured-provider-key/);
});

test("selects AgentRouter's key without requiring the Groq key", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "agentrouter",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(report.checks.some(({ name, ready }) => name === "AGENTROUTER_API_KEY" && ready));
  assert.ok(!report.checks.some(({ name }) => name === "GROK_API_CODING_KEY"));
});

test("uses Groq when the provider setting is blank, matching server selection", () => {
  const report = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "  " },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "GROK_API_CODING_KEY" && ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "MUSE_LLM_PROVIDER"));
});

test("reports missing secrets and unavailable tsx by name without printing values", () => {
  const report = inspectMuseReadiness(
    {
      SESSION_SECRET: "",
      MUSE_CHAT_ACCESS_TOKEN: "short",
      GROK_API_CODING_KEY: "",
    },
    false,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, false);
  assert.match(output, /BLOCKED: SESSION_SECRET/);
  assert.match(output, /BLOCKED: MUSE_CHAT_ACCESS_TOKEN/);
  assert.match(output, /BLOCKED: GROK_API_CODING_KEY/);
  assert.match(output, /BLOCKED: tsx/);
  assert.doesNotMatch(output, /short/);
});

test("rejects unsupported provider names without echoing the configured value", () => {
  const report = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "private-provider-value" },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, false);
  assert.match(output, /BLOCKED: MUSE_LLM_PROVIDER/);
  assert.doesNotMatch(output, /private-provider-value/);
});

test("counts access-token strength in UTF-8 bytes", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CHAT_ACCESS_TOKEN: "🔒".repeat(8),
    },
    true,
  );

  assert.equal(
    report.checks.find(({ name }) => name === "MUSE_CHAT_ACCESS_TOKEN").ready,
    true,
  );
});
