import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponseFormatting } from "./response-formatting.js";

test("response formatting repairs stray punctuation and escaped line breaks", () => {
  assert.equal(
    normalizeResponseFormatting("First sentence.;\\nSecond sentence."),
    "First sentence.\nSecond sentence.",
  );
});

test("response formatting removes unexpected emoji and repairs mismatched curly quotes", () => {
  assert.equal(
    normalizeResponseFormatting("A claim 🚀. “Quoted wording\" remains."),
    "A claim. “Quoted wording” remains.",
  );
});

test("response formatting preserves quoted source text, code, URLs, and citations", () => {
  const raw =
    "A source says “Keep the .; and 🚀 exactly as printed.” " +
    "`const value = \".; 🚀\";` https://example.org/a.;b [SRC-abc123]";

  assert.equal(
    normalizeResponseFormatting(raw),
    raw,
  );
});

test("response formatting leaves block quotations untouched", () => {
  const quote = "> The quoted source says .; \\n 🚀";
  assert.equal(normalizeResponseFormatting(quote), quote);
});
