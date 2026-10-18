import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSameSiteLinks,
  isSameSite,
  readLink,
  registrableDomain,
} from "./link-reader.js";

function jsonResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, "content-length": String(Buffer.byteLength(body)) },
  });
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

const PUBLIC_DNS = async () => [{ address: "203.0.113.10" }];
const PRIVATE_DNS = async () => [{ address: "10.0.0.5" }];

const PHOTON_HTML = `<!doctype html>
<html><head>
  <title>Photon | Bring your agents to iMessage</title>
  <meta property="og:site_name" content="Photon">
  <meta name="description" content="Photon is an open-source framework connecting agents to messaging apps.">
  <link rel="canonical" href="https://photon.codes/">
</head>
<body>
  <nav>Home | Pricing | Blog</nav>
  <header>Photon</header>
  <main>
    <h1>Bring Agents to the Interfaces Millions Already Use.</h1>
    <p>${"An open-source framework that connects your agents to iMessage, WhatsApp, Discord, Slack, Telegram, and other interfaces people use every day. ".repeat(3)}</p>
    <a href="/platform/imessage">iMessage</a>
    <a href="/platform/whatsapp">WhatsApp</a>
    <a href="https://docs.photon.codes/">Docs</a>
    <a href="https://github.com/photon-hq/spectrum-ts">GitHub</a>
  </main>
  <footer>Copyright</footer>
</body></html>`;

test("readLink turns a user-supplied URL into readable evidence", async () => {
  let requested: string | undefined;
  const result = await readLink("https://photon.codes", {
    fetchImplementation: async (url) => {
      requested = String(url);
      return htmlResponse(PHOTON_HTML);
    },
    resolveHost: PUBLIC_DNS,
  });

  assert.equal(requested, "https://photon.codes/");
  assert.ok(result.source, "expected a readable source");
  assert.equal(result.source.url, "https://photon.codes/");
  assert.equal(result.source.canonicalUrl, "https://photon.codes/");
  assert.equal(result.source.publisher, "Photon");
  assert.equal(result.source.isUserProvided, true);
  assert.match(result.source.content, /An open-source framework/);
  // Boilerplate is gone from the body text.
  assert.doesNotMatch(result.source.content, /^Copyright/);
});

test("readLink discovers and classifies same-site crawl targets", async () => {
  const result = await readLink("https://photon.codes", {
    fetchImplementation: async () => htmlResponse(PHOTON_HTML),
    resolveHost: PUBLIC_DNS,
  });

  assert.ok(result.links.includes("https://docs.photon.codes/"));
  assert.ok(result.links.includes("https://github.com/photon-hq/spectrum-ts"));
  // Same registrable domain only: docs.photon.codes is in, github.com is out.
  assert.ok(result.sameSiteLinks.includes("https://photon.codes/platform/imessage"));
  assert.ok(result.sameSiteLinks.includes("https://docs.photon.codes/"));
  assert.ok(!result.sameSiteLinks.some((link) => link.includes("github.com")));
});

test("readLink reads JSON payloads that the old allowlist discarded", async () => {
  const result = await readLink("https://api.photon.codes/docs", {
    fetchImplementation: async () =>
      jsonResponse(
        JSON.stringify({
          name: "Photon",
          transport: "imessage",
          endpoints: { send: "/v1/projects/:id/messages" },
        }),
        "application/json",
      ),
    resolveHost: PUBLIC_DNS,
  });

  assert.ok(result.source, "expected JSON evidence");
  assert.equal(result.source.extractionStatus, "converted");
  assert.match(result.source.content, /name: Photon/);
  assert.match(result.source.content, /transport: imessage/);
});

test("readLink reads XML and Markdown payloads", async () => {
  // Realistic feed entries: long enough to clear the readability floor.
  const xml = await readLink("https://photon.codes/feed.xml", {
    fetchImplementation: async () =>
      jsonResponse(
        `<?xml version="1.0"?><feed><title>Photon Blog</title>
         <entry><title>Shipping Spectrum v2</title>
         <summary>Spectrum v2 adds multi-channel delivery, WhatsApp support, and a rebuilt event stream.</summary></entry></feed>`,
        "application/xml",
      ),
    resolveHost: PUBLIC_DNS,
  });
  assert.ok(xml.source, "expected XML evidence");
  assert.match(xml.source.content, /Photon Blog/);
  assert.match(xml.source.content, /Spectrum v2 adds multi-channel delivery/);

  const md = await readLink("https://docs.photon.codes/guide.md", {
    fetchImplementation: async () =>
      jsonResponse(
        "# Getting Started\n\nInstall the SDK from npm, create a project, and connect your first agent to iMessage in a few minutes.",
        "text/markdown",
      ),
    resolveHost: PUBLIC_DNS,
  });
  assert.ok(md.source, "expected Markdown evidence");
  assert.match(md.source.content, /Getting Started/);
  assert.match(md.source.content, /Install the SDK from npm/);
});

test("readLink reports distinct reasons for blocked, empty, and unreadable pages", async () => {
  const forbidden = await readLink("https://photon.codes", {
    fetchImplementation: async () => htmlResponse("nope", 403),
    resolveHost: PUBLIC_DNS,
  });
  assert.equal(forbidden.source, null);
  assert.match(forbidden.failure?.reason ?? "", /HTTP 403/);

  const thin = await readLink("https://photon.codes", {
    fetchImplementation: async () =>
      htmlResponse("<html><body><div id='root'></div></body></html>"),
    resolveHost: PUBLIC_DNS,
  });
  assert.equal(thin.source, null);
  assert.match(thin.failure?.reason ?? "", /JavaScript/);

  const binary = await readLink("https://photon.codes/hero.png", {
    fetchImplementation: async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }),
    resolveHost: PUBLIC_DNS,
  });
  assert.equal(binary.source, null);
  assert.match(binary.failure?.reason ?? "", /image\/png/);
});

test("readLink rescues thin pages with their own og:description", async () => {
  // A generated marketing shell: body extracts short, but the description is
  // the real summary. The old code returned null here and Muse said it had no
  // sources for a page the user could plainly read.
  const result = await readLink("https://photon.codes", {
    fetchImplementation: async () =>
      htmlResponse(`<html><head>
        <title>Photon</title>
        <meta property="og:description" content="Photon connects AI agents to iMessage, WhatsApp, and other messaging surfaces people already use every day.">
      </head><body><div class="framer-123"><p>Photon</p></div></body></html>`),
    resolveHost: PUBLIC_DNS,
  });

  assert.ok(result.source, "expected the description fallback to rescue this page");
  assert.match(result.source.content, /connects AI agents to iMessage/);
});

test("readLink follows redirects and records the final URL", async () => {
  let hops = 0;
  const result = await readLink("https://photon.codes", {
    fetchImplementation: async (url) => {
      hops += 1;
      if (String(url) === "https://photon.codes/") {
        return new Response("", {
          status: 301,
          headers: { Location: "https://photon.codes/home" },
        });
      }
      return htmlResponse(PHOTON_HTML);
    },
    resolveHost: PUBLIC_DNS,
  });

  assert.equal(hops, 2);
  assert.ok(result.source);
  assert.equal(result.source.url, "https://photon.codes/home");
});

test("readLink refuses private and reserved destinations", async () => {
  const literal = await readLink("http://127.0.0.1/admin", {
    fetchImplementation: async () => htmlResponse(PHOTON_HTML),
    resolveHost: PRIVATE_DNS,
  });
  assert.equal(literal.source, null);
  assert.match(literal.failure?.reason ?? "", /safe public HTTP/);

  const metadata = await readLink("http://169.254.169.254/latest/meta-data/", {
    fetchImplementation: async () => htmlResponse(PHOTON_HTML),
    resolveHost: PUBLIC_DNS,
  });
  assert.equal(metadata.source, null);

  // A public-looking hostname that resolves private is refused at the fetch.
  const resolved = await readLink("https://internal.example.com/", {
    fetchImplementation: async () => htmlResponse(PHOTON_HTML),
    resolveHost: PRIVATE_DNS,
  });
  assert.equal(resolved.source, null);
  assert.match(resolved.failure?.reason ?? "", /private or reserved|non-public/);
});

test("readLink caps oversized responses instead of buffering them", async () => {
  const huge = "x".repeat(5_000);
  const result = await readLink("https://photon.codes/huge.json", {
    fetchImplementation: async () => jsonResponse(huge, "application/json"),
    resolveHost: PUBLIC_DNS,
    maxBytes: 1_000,
  });

  assert.equal(result.source, null);
  assert.match(result.failure?.reason ?? "", /larger than|size limit/);
});

test("same-site grouping understands registrable domains", () => {
  assert.equal(registrableDomain("photon.codes"), "photon.codes");
  assert.equal(registrableDomain("docs.photon.codes"), "photon.codes");
  assert.equal(registrableDomain("www.photon.codes"), "photon.codes");
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("127.0.0.1"), null);

  assert.equal(isSameSite("docs.photon.codes", "photon.codes"), true);
  assert.equal(isSameSite("photon.codes", "github.com"), false);
});

test("crawl target collection drops assets and respects the limit", () => {
  const links = [
    "https://photon.codes/platform/imessage",
    "https://photon.codes/platform/whatsapp",
    "https://docs.photon.codes/guide",
    "https://photon.codes/hero.png",
    "https://photon.codes/static/media/logo.svg",
    "https://photon.codes/files/manual.pdf",
    "https://github.com/photon-hq/spectrum-ts",
  ];

  const kept = collectSameSiteLinks(links, "https://photon.codes/");
  assert.deepEqual(kept, [
    "https://photon.codes/platform/imessage",
    "https://photon.codes/platform/whatsapp",
    "https://docs.photon.codes/guide",
  ]);

  const limited = collectSameSiteLinks(links, "https://photon.codes/", 2);
  assert.equal(limited.length, 2);
});
