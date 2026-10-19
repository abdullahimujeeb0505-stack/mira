import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMuseReadiness,
  inspectMuseReadiness,
} from "./preflight.mjs";

const validEnv = {
  SESSION_SECRET: "configured-session-secret",
  GROK_API_CODING_KEY: "configured-provider-key",
};

test("reports readiness for Groq without exposing configured values", () => {
  const report = inspectMuseReadiness(validEnv, true);
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /PASS: GROK_API_CODING_KEY/);
  assert.doesNotMatch(output, /MUSE_CHAT_ACCESS_TOKEN/);
  assert.doesNotMatch(output, /configured-session-secret|configured-provider-key/);
});

test("task-aware defaults validate separate Groq chat and Gemini research providers", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GEMINI_API_KEY: "configured-gemini-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(report.checks.some(({ name, ready }) => name === "chat LLM provider (groq)" && ready));
  assert.ok(report.checks.some(({ name, ready }) => name === "research LLM provider (gemini)" && ready));
  assert.deepEqual(report.warnings, []);
});

test("task-aware preflight reports a usable runtime fallback instead of a false block", () => {
  const report = inspectMuseReadiness(validEnv, true);
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /WARNING: The research task will fall back from gemini to groq/);
  assert.match(output, /Gemini Google Search grounding is unavailable without GEMINI_API_KEY/);
});

test("task-specific provider overrides are checked independently", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CHAT_LLM_PROVIDER: "agentrouter",
      MUSE_RESEARCH_LLM_PROVIDER: "gemini",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
      GEMINI_API_KEY: "configured-gemini-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(report.checks.some(({ name, ready }) => name === "AGENTROUTER_API_KEY" && ready));
  assert.ok(report.checks.some(({ name, ready }) => name === "GEMINI_API_KEY" && ready));
  assert.ok(!report.checks.some(({ name }) => name.includes("GROQ")));
});

test("preflight blocks when neither task provider nor its configured fallback is usable", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
      GEMINI_API_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, false);
  assert.ok(report.checks.some(({ name, ready }) => name === "chat LLM provider (groq)" && !ready));
  assert.ok(report.checks.some(({ name, ready }) => name === "research LLM provider (gemini)" && !ready));
});

test("prefers the canonical Groq credential when both variables are available", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
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
      GROK_API_CODING_KEY: "",
    },
    false,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, false);
  assert.match(output, /BLOCKED: SESSION_SECRET/);
  assert.match(output, /BLOCKED: GROQ_API_KEY or GROK_API_CODING_KEY/);
  assert.match(output, /BLOCKED: tsx/);
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
