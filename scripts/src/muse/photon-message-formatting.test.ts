import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadResearchImage,
  extractIMessageImageReferences,
  formatIMessageText,
} from "./photon-message-formatting.js";
import type { ResolveHost } from "./safe-fetch.js";

const WIKIMEDIA_IMAGE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/a/aa/ronaldo%20cropped.jpg?utm_source=test";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]);
const resolvePublicHost: ResolveHost = async () => [
  { address: "93.184.216.34" },
];

test("iMessage replies turn headings, emphasis, lists, and links into plain text", () => {
  const text = formatIMessageText([
    "### Career Milestones",
    "- **Sporting CP:** *5 goals*",
    "* First team",
    "See [the official record](https://example.org/record).",
    "`const answer = 42;`",
    "```ts",
    "const second = 7;",
    "```",
  ].join("\n"));

  assert.equal(
    text,
    [
      "Career Milestones",
      "• Sporting CP: 5 goals",
      "• First team",
      "See the official record (https://example.org/record).",
      "const answer = 42;",
      "const second = 7;",
    ].join("\n"),
  );
  assert.doesNotMatch(text, /[#*`\[\]]/);
});

test("research image Markdown is separated from plain text for iMessage attachments", () => {
  const result = extractIMessageImageReferences(
    `![Cristiano Ronaldo](${WIKIMEDIA_IMAGE_URL})\n\n### Career\n\nHe scored **many goals**.`,
  );

  assert.deepEqual(result.images, [
    {
      alt: "Cristiano Ronaldo",
      url: WIKIMEDIA_IMAGE_URL,
    },
  ]);
  assert.equal(result.text, "### Career\n\nHe scored **many goals**.");
});

test("unsupported Markdown images become plain labels, not raw syntax", () => {
  const result = extractIMessageImageReferences(
    "![External photo](https://images.example.org/photo.jpg)",
  );

  assert.deepEqual(result.images, []);
  assert.equal(result.text, "Image: External photo");
  assert.doesNotMatch(result.text, /!\[|\]\(/);
});

test("image examples inside code are not turned into attachments", () => {
  const result = extractIMessageImageReferences(
    [
      "```md",
      "![example](https://upload.wikimedia.org/wikipedia/commons/a/aa/example.jpg)",
      "```",
      "",
      `![actual image](${WIKIMEDIA_IMAGE_URL})`,
    ].join("\n"),
  );

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.alt, "actual image");
  assert.match(result.text, /```md\n!\[example\]/);
});

test("research images download only from allowed hosts with a checked image type", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const image = await downloadResearchImage(WIKIMEDIA_IMAGE_URL, {
    resolveHost: resolvePublicHost,
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(PNG_BYTES, {
        headers: { "content-type": "image/png" },
      });
    },
  });

  assert.equal(requestedUrl, WIKIMEDIA_IMAGE_URL);
  assert.equal(requestInit?.redirect, "error");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(image.bytes, PNG_BYTES);
});

test("research image downloader rejects unsupported hosts before making a request", async () => {
  let requestCount = 0;
  await assert.rejects(
    downloadResearchImage("https://images.example.org/photo.png", {
      resolveHost: resolvePublicHost,
      fetchImplementation: async () => {
        requestCount += 1;
        return new Response(PNG_BYTES, {
          headers: { "content-type": "image/png" },
        });
      },
    }),
    /not supported/,
  );
  assert.equal(requestCount, 0);
});

test("research image downloader rejects bytes that do not match the declared type", async () => {
  await assert.rejects(
    downloadResearchImage(WIKIMEDIA_IMAGE_URL, {
      resolveHost: resolvePublicHost,
      fetchImplementation: async () =>
        new Response("not an image", {
          headers: { "content-type": "image/png" },
        }),
    }),
    /did not match its content type/,
  );
});

test("research image downloader enforces a response size limit", async () => {
  const oversized = Buffer.alloc(4 * 1_024 * 1_024 + 1);
  await assert.rejects(
    downloadResearchImage(WIKIMEDIA_IMAGE_URL, {
      resolveHost: resolvePublicHost,
      fetchImplementation: async () =>
        new Response(oversized, {
          headers: { "content-type": "image/png" },
        }),
    }),
    /size limit/,
  );
});
