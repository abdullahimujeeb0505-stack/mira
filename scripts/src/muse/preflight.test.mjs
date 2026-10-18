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
  const report = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "groq" },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /PASS: GROK_API_CODING_KEY/);
  assert.doesNotMatch(output, /configured-session-secret|configured-provider-key/);
});

test("prefers the canonical Groq credential when both variables are available", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "groq",
      GROQ_API_KEY: "canonical-provider-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(report.checks.some(({ name, ready }) => name === "GROQ_API_KEY" && ready));
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

test("selects Gemini's key without requiring Groq credentials", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "configured-gemini-key",
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(report.checks.some(({ name, ready }) => name === "GEMINI_API_KEY" && ready));
  assert.ok(!report.checks.some(({ name }) => name === "GROK_API_CODING_KEY"));
});

test("Gemini selection blocks until GEMINI_API_KEY is set", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, false);
  assert.ok(report.checks.some(({ name, ready }) => name === "GEMINI_API_KEY" && !ready));
});

test("uses Gemini when the provider setting is blank, matching server selection", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "  ",
      GEMINI_API_KEY: "configured-gemini-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "GEMINI_API_KEY" && ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "MUSE_LLM_PROVIDER"));
});

test("requires the selected OpenRouter key and model without requiring Groq credentials", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "configured-openrouter-key",
      OPENROUTER_MODEL: "",
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, false);
  assert.ok(report.checks.some(({ name, ready }) => name === "OPENROUTER_API_KEY" && ready));
  assert.ok(report.checks.some(({ name, ready }) => name === "OPENROUTER_MODEL" && !ready));
  assert.ok(!report.checks.some(({ name }) => name.includes("GROQ")));
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
  assert.match(output, /BLOCKED: GEMINI_API_KEY/);
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
