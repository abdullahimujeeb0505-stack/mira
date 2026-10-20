import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResponseFormatting,
  requestsEmoji,
  requestsImages,
  requestsSources,
} from "./response-formatting.js";

test("emoji are preserved when explicitly requested", () => {
  assert.equal(requestsEmoji("Use emojis in your reply."), true);
  assert.equal(requestsEmoji("Reply with 🚀, please."), true);
  assert.equal(requestsEmoji("I dislike emojis."), false);
  assert.equal(requestsEmoji("I hate replies with emojis."), false);
  assert.equal(requestsEmoji("Answer with emojis."), true);
  assert.equal(
    normalizeResponseFormatting("Sure 🚀!", [], { preserveEmoji: true }),
    "Sure 🚀!",
  );
});

test("explicit image requests are detected without treating casual mentions as requests", () => {
  assert.equal(requestsImages("Show me illustrations of photosynthesis."), true);
  assert.equal(requestsImages("Could I see a picture of a butterfly?"), true);
  assert.equal(requestsImages("Explain photosynthesis without pictures."), false);
  assert.equal(requestsImages("What is the history of Donald Trump? No image, please."), false);
  assert.equal(
    requestsImages("Define pollination with additional img description."),
    true,
  );
  assert.equal(requestsImages("Explain pollination with a relevant image."), true);
  assert.equal(
    requestsImages("Don't generate an image; attach existing images available online."),
    true,
  );
  assert.equal(
    requestsImages(
      "Define pollination; it is not necessary the image is generated, it should be attached from ones available online.",
    ),
    true,
  );
  assert.equal(requestsImages("Don't generate an image."), false);
  assert.equal(requestsImages("Describe the attached image."), false);
  assert.equal(requestsImages("I like looking at pictures."), false);
});

test("source links are shown only for explicit source requests", () => {
  assert.equal(requestsSources("Show me the sources"), true);
  assert.equal(requestsSources("What sources support this answer?"), true);
  assert.equal(requestsSources("Include raw source URLs"), true);
  assert.equal(requestsSources("What are the main energy sources?"), false);
});

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

test("response formatting converts Markdown tables to labeled bullets", () => {
  const formatted = normalizeResponseFormatting([
    "| Milestone | Detail |",
    "| --- | --- |",
    "| First<br>step | **Second**<br/>step |",
    "| Code | `<br>` remains literal |",
    "",
    "<br/>",
  ].join("\n"));

  assert.match(formatted, /- \*\*Milestone:\*\* First step; \*\*Detail:\*\* \*\*Second\*\* step/);
  assert.match(formatted, /- \*\*Milestone:\*\* Code; \*\*Detail:\*\* `<br>` remains literal/);
  assert.match(formatted, /\n<br\/>$/);
  assert.doesNotMatch(formatted, /^\s*\|/m);
});

test("response formatting links retrieved source URLs and preserves URLs in code and quotes", () => {
  const source = {
    title: "Official guide",
    url: "https://example.org/guide",
  };
  assert.equal(
    normalizeResponseFormatting(
      "Read https://example.org/guide. `https://example.org/guide` “https://example.org/guide”",
      [source],
    ),
    "Read [Official guide](https://example.org/guide). `https://example.org/guide` “https://example.org/guide”",
  );
  assert.equal(
    normalizeResponseFormatting(
      "Read https://example.org/guide.",
      [source],
      { preserveSourceUrls: true },
    ),
    "Read https://example.org/guide.",
  );
});
