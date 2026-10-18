import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyContent,
  isReadableContentType,
  jsonToText,
  markdownToText,
  toReadableText,
  xmlToText,
} from "./text-converter.js";

test("content-type classification covers the formats Muse now reads", () => {
  assert.equal(classifyContent("text/html; charset=utf-8", "<html></html>"), "html");
  assert.equal(classifyContent("application/xhtml+xml", "<html></html>"), "html");
  assert.equal(classifyContent("application/json", "{}"), "json");
  assert.equal(classifyContent("application/ld+json", "{}"), "json");
  assert.equal(classifyContent("application/xml", "<a/>"), "xml");
  assert.equal(classifyContent("text/xml", "<a/>"), "xml");
  assert.equal(classifyContent("text/markdown", "# Hi"), "markdown");
  assert.equal(classifyContent("text/plain", "hi"), "text");

  // Unlabeled and generic binary payloads are sniffed, not discarded.
  assert.equal(classifyContent("", '{"a":1}'), "json");
  assert.equal(classifyContent("application/octet-stream", '<?xml version="1"?><a/>'), "xml");
  assert.equal(classifyContent("", "just plain words"), "text");
});

test("readable-type check accepts documentation formats and rejects binaries", () => {
  for (const type of [
    "text/html",
    "application/json",
    "application/rss+xml",
    "application/atom+xml",
    "text/markdown",
    "text/csv",
    "text/plain",
  ]) {
    assert.equal(isReadableContentType(type), true, type);
  }
  for (const type of ["image/png", "application/pdf", "video/mp4", "application/zip"]) {
    assert.equal(isReadableContentType(type), false, type);
  }
});

test("JSON flattening preserves path structure and readable values", () => {
  const text = jsonToText(
    JSON.stringify({
      name: "Photon",
      tagline: "Agents for iMessage",
      versions: ["1.0", "2.0"],
      nested: { pricing: { tier: "free" } },
    }),
    4_000,
  );

  assert.match(text, /name: Photon/);
  assert.match(text, /tagline: Agents for iMessage/);
  assert.match(text, /versions\[0\]: 1\.0/);
  assert.match(text, /nested\.pricing\.tier: free/);
});

test("JSON flattening replaces opaque blobs with a length marker", () => {
  const blob = "A".repeat(200);
  const text = jsonToText(JSON.stringify({ icon: blob }), 4_000);
  assert.match(text, /icon: \[200-character encoded value\]/);
  assert.doesNotMatch(text, /AAAA/);
});

test("JSON flattening degrades to empty text on malformed input", () => {
  assert.equal(jsonToText("{not json", 4_000), "");
  assert.equal(jsonToText("", 4_000), "");
});

test("JSON flattening respects the character budget", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`key${index}`, `value${index}`.padEnd(100, "x")]),
  );
  const text = jsonToText(JSON.stringify(wide), 300);
  assert.ok(text.length <= 300, `expected <= 300 chars, got ${text.length}`);
});

test("XML flattening keeps character data and drops markup", () => {
  const text = xmlToText(
    `<?xml version="1.0"?>
     <rss version="2.0"><channel>
       <title>Photon Blog</title>
       <item><title>Shipping v2</title><description>Big release</description></item>
     </channel></rss>`,
    4_000,
  );

  assert.match(text, /Photon Blog/);
  assert.match(text, /Shipping v2/);
  assert.match(text, /Big release/);
  assert.doesNotMatch(text, /<title>/);
});

test("XML flattening keeps CDATA text and rejects DTD entity declarations", () => {
  // CDATA text survives; the markup inside it is still stripped, since the
  // point of the converter is character data, not embedded tags.
  const cdata = xmlToText("<note><![CDATA[Raw <b>text</b> here]]></note>", 4_000);
  assert.match(cdata, /Raw/);
  assert.match(cdata, /text/);
  assert.match(cdata, /here/);
  assert.doesNotMatch(cdata, /<b>/);

  // XXE defence: a document with a DTD or entity declaration yields nothing.
  assert.equal(
    xmlToText('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>', 4_000),
    "",
  );
  assert.equal(xmlToText("<!ENTITY xxe SYSTEM 'http://evil'><a/>", 4_000), "");
});

test("Markdown conversion strips chrome, keeps code, and flattens links", () => {
  const text = markdownToText(
    `# Photon\n\n![hero](https://cdn.example.com/hero.png)\n\nPhoton is an **open-source** framework.\n\nSee the [docs](https://docs.photon.codes/).\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n- item one\n- item two\n`,
    4_000,
  );

  assert.match(text, /Photon/);
  assert.match(text, /open-source/);
  assert.match(text, /docs/);
  assert.doesNotMatch(text, /hero\.png/);
  assert.doesNotMatch(text, /https:\/\/docs\.photon\.codes/);
  assert.match(text, /const x = 1;/);
  assert.match(text, /- item one/);
});

test("toReadableText routes by content kind and clamps to the budget", () => {
  const json = toReadableText("json", '{"a":"b"}', 4_000);
  assert.match(json, /a: b/);

  const xml = toReadableText("xml", "<a>hello</a>", 4_000);
  assert.match(xml, /hello/);

  const md = toReadableText("markdown", "# Title\n\nBody", 4_000);
  assert.match(md, /Title/);
  assert.match(md, /Body/);

  assert.equal(toReadableText("unknown", "anything", 4_000), "");

  const huge = toReadableText("text", "x".repeat(10_000), 100);
  assert.equal(huge.length, 100);
});
