import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSourceUrl } from "./canonical-source-url.js";

test("removes tracking parameters and fragments", () => {
  assert.equal(
    canonicalSourceUrl(
      "https://Example.com/hackers/?utm_source=x&ref=abc#program",
    ),
    "https://example.com/hackers",
  );
});

test("normalizes host casing, default ports, and trailing slashes", () => {
  assert.equal(
    canonicalSourceUrl("HTTPS://EXAMPLE.COM:443/program///"),
    "https://example.com/program",
  );
});

test("sorts retained query parameters consistently", () => {
  assert.equal(
    canonicalSourceUrl("https://example.com/apply?z=2&a=1"),
    canonicalSourceUrl("https://example.com/apply?a=1&z=2"),
  );
});

test("preserves meaningful query parameters", () => {
  assert.notEqual(
    canonicalSourceUrl("https://example.com/apply?campaign=one"),
    canonicalSourceUrl("https://example.com/apply?campaign=two"),
  );
});

test("rejects invalid and non-HTTP URLs", () => {
  assert.equal(canonicalSourceUrl("not a URL"), null);
  assert.equal(canonicalSourceUrl("javascript:alert(1)"), null);
  assert.equal(canonicalSourceUrl("https://user:pass@example.com"), null);
});

test("does not merge distinct paths", () => {
  assert.notEqual(
    canonicalSourceUrl("https://example.com/grants"),
    canonicalSourceUrl("https://example.com/bounties"),
  );
});
