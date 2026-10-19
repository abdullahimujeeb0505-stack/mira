import assert from "node:assert/strict";
import test from "node:test";
import { formatMuseReadiness, inspectMuseReadiness } from "./preflight.mjs";

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
  assert.doesNotMatch(
    output,
    /configured-session-secret|configured-provider-key/,
  );
});

test("defaults both tasks to Groq and checks a configured Gemini runtime fallback", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GEMINI_API_KEY: "configured-gemini-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM provider (groq)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM fallback (gemini)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM fallback (gemini)" && ready,
    ),
  );
  assert.deepEqual(report.warnings, []);
});

test("Groq remains ready without Gemini but preflight reports missing runtime fallback", () => {
  const report = inspectMuseReadiness(validEnv, true);
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(
    output,
    /WARNING: The chat task has no configured gemini runtime fallback/,
  );
  assert.match(
    output,
    /WARNING: The research task has no configured gemini runtime fallback/,
  );
  assert.match(
    output,
    /Gemini Google Search grounding is unavailable without GEMINI_API_KEY/,
  );
});

test("task-specific provider overrides remain primary and keep independent fallbacks", () => {
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
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (agentrouter)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM provider (gemini)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM fallback (gemini)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM fallback (groq)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "AGENTROUTER_API_KEY" && ready,
    ),
  );
  assert.ok(
    report.checks.some(({ name, ready }) => name === "GEMINI_API_KEY" && ready),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "GROK_API_CODING_KEY" && ready,
    ),
  );
});

test("preflight blocks when neither Groq primary nor Gemini fallback is configured", () => {
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
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && !ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM provider (groq)" && !ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "GEMINI_API_KEY" && !ready,
    ),
  );
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
  assert.ok(
    report.checks.some(({ name, ready }) => name === "GROQ_API_KEY" && ready),
  );
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
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "AGENTROUTER_API_KEY" && ready,
    ),
  );
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
  assert.ok(
    report.checks.some(({ name, ready }) => name === "GEMINI_API_KEY" && ready),
  );
  assert.ok(!report.checks.some(({ name }) => name === "GROK_API_CODING_KEY"));
});

test("uses the Groq fallback when the explicit Gemini primary is not configured", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
    },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(
    output,
    /WARNING: The chat task will use groq because the configured primary gemini is unavailable/,
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && ready,
    ),
  );
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

test("blocks an unconfigured OpenRouter primary when its Groq fallback is unavailable", () => {
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
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "OPENROUTER_API_KEY" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "OPENROUTER_MODEL" && !ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) =>
        name === "GROQ_API_KEY or GROK_API_CODING_KEY" && !ready,
    ),
  );
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
  const taskOverrideReport = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CHAT_LLM_PROVIDER: "agentrouter",
      MUSE_RESEARCH_LLM_PROVIDER: "private-provider-value",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
    },
    true,
  );
  const output = `${formatMuseReadiness(report)}\n${formatMuseReadiness(taskOverrideReport)}`;

  assert.equal(report.ready, false);
  assert.equal(taskOverrideReport.ready, false);
  assert.match(output, /BLOCKED: MUSE_LLM_PROVIDER/);
  assert.doesNotMatch(output, /private-provider-value/);
});
