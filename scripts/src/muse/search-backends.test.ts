import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSearchBackends,
  DEFAULT_SEARCH_BACKENDS,
  DuckDuckGoHtmlBackend,
  DuckDuckGoLiteBackend,
  parseDuckDuckGoLiteResults,
  parseDuckDuckGoSearchResults,
  RetryableSearchError,
  SearchBlockedError,
  searchWithBackends,
  type SearchBackend,
  type SearchHit,
} from "./search-backends.js";

const DDG_HTML_RESULTS = `
<html><body>
<div class="serp">Fake serp header</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fphoton.codes%2F&amp;rut=x">Photon | Agents to iMessage</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fphoton.codes%2F">An open-source framework...</a>
</div>
<div class="result">
  <a class="result__a" href="https://github.com/photon-hq/spectrum-ts">GitHub - photon-hq/spectrum-ts</a>
</div>
<div class="result">
  <a class="result__a" href="https://docs.photon.codes/getting-started">Getting Started</a>
</div>
</body></html>
`;

const DDG_LITE_RESULTS = `
<html><body>
<table>
  <tr><td>1.</td><td><a class="result-link" href="https://photon.codes/">Photon | Bring your agents</a></td></tr>
  <tr><td colspan="2">An open-source framework that connects agents.</td></tr>
  <tr><td>2.</td><td><a class="result-link" href="https://docs.photon.codes/">Docs</a></td></tr>
  <tr><td colspan="2">Documentation for the Photon platform.</td></tr>
</table>
</body></html>
`;

test("DuckDuckGo HTML results unwrap redirect URLs and drop unsafe targets", () => {
  const hits = parseDuckDuckGoSearchResults(DDG_HTML_RESULTS);

  assert.equal(hits.length, 3);
  assert.equal(hits[0]?.title, "Photon | Agents to iMessage");
  assert.equal(hits[0]?.url, "https://photon.codes/");
  assert.equal(hits[1]?.url, "https://github.com/photon-hq/spectrum-ts");

  // A javascript: or data: target in the result markup is discarded.
  const hostile = DDG_HTML_RESULTS.replace(
    "https://docs.photon.codes/getting-started",
    "javascript:alert(1)",
  );
  const filtered = parseDuckDuckGoSearchResults(hostile);
  assert.equal(filtered.length, 2);
});

test("DuckDuckGo HTML bot challenges raise SearchBlockedError rather than returning zero hits", () => {
  const challenge =
    '<html><body><div id="anomaly-modal">Please complete the challenge to confirm this search.</div></body></html>';

  assert.throws(
    () => parseDuckDuckGoSearchResults(challenge, 202),
    SearchBlockedError,
  );
  assert.throws(
    () => parseDuckDuckGoSearchResults(challenge, 200),
    SearchBlockedError,
  );
  // Entity-encoded challenge text still trips the check.
  assert.throws(
    () =>
      parseDuckDuckGoSearchResults(
        "<html><body>bots use DuckDuckGo too &#8212; challenge</body></html>",
        200,
      ),
    SearchBlockedError,
  );
});

test("DuckDuckGo Lite parses its table layout and falls back to external anchors", () => {
  const hits = parseDuckDuckGoLiteResults(DDG_LITE_RESULTS);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.url, "https://photon.codes/");
  assert.match(hits[0]?.title ?? "", /Photon \| Bring your agents/);

  // Same layout without the result class: the external-anchor pass still finds
  // real results and never mistakes search-engine chrome for them.
  const bare = `
    <table>
      <tr><td><a href="https://photon.codes/platform/imessage">iMessage API</a></td></tr>
      <tr><td><a href="https://duckduckgo.com/privacy">Privacy</a></td></tr>
      <tr><td><a href="https://lite.duckduckgo.com/lite/?q=next">Next</a></td></tr>
    </table>`;
  const fallbackHits = parseDuckDuckGoLiteResults(bare);
  assert.equal(fallbackHits.length, 1);
  assert.equal(fallbackHits[0]?.url, "https://photon.codes/platform/imessage");
});

test("DuckDuckGo Lite detects challenges too", () => {
  assert.throws(
    () => parseDuckDuckGoLiteResults("<html><body>unusual traffic</body></html>", 200),
    SearchBlockedError,
  );
});

test("default search uses only DuckDuckGo HTML and Lite", () => {
  const defaults = createDefaultSearchBackends();
  assert.deepEqual(
    defaults.map(({ id }) => id),
    ["duckduckgo-html", "duckduckgo-lite"],
  );
  assert.equal(defaults, DEFAULT_SEARCH_BACKENDS);
});

test("a backend chain returns hits from the first working backend", async () => {
  const calls: string[] = [];
  const working: SearchBackend = {
    id: "working",
    label: "Working",
    async search(query) {
      calls.push(query);
      return [{ title: "Result", url: "https://example.org/" }];
    },
  };

  const outcome = await searchWithBackends("photon codes", [working]);
  assert.equal(outcome.backendId, "working");
  assert.equal(outcome.hits.length, 1);
  assert.deepEqual(calls, ["photon codes"]);
});

test("a blocked backend falls through to the next one", async () => {
  const blocked: SearchBackend = {
    id: "blocked",
    label: "Blocked",
    async search() {
      throw new SearchBlockedError("blocked", "bot challenge");
    },
  };
  const fallback: SearchBackend = {
    id: "fallback",
    label: "Fallback",
    async search(): Promise<SearchHit[]> {
      return [{ title: "From fallback", url: "https://example.org/fallback" }];
    },
  };

  const outcome = await searchWithBackends("query", [blocked, fallback]);
  assert.equal(outcome.backendId, "fallback");
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0] ?? "", /blocked access/);
});

test("a transient search failure retries once before accepting results", async () => {
  let attempts = 0;
  const transientThenWorking: SearchBackend = {
    id: "transient-then-working",
    label: "Transient then working",
    async search(): Promise<SearchHit[]> {
      attempts += 1;
      if (attempts === 1) throw new RetryableSearchError("HTTP 503");
      return [{ title: "Recovered result", url: "https://example.org/recovered" }];
    },
  };

  const outcome = await searchWithBackends("query", [transientThenWorking]);
  assert.equal(attempts, 2);
  assert.equal(outcome.backendId, "transient-then-working");
  assert.equal(outcome.hits[0]?.title, "Recovered result");
});

test("a persistent transient error falls through to the next search backend", async () => {
  let failedAttempts = 0;
  const unreliable: SearchBackend = {
    id: "unreliable",
    label: "Unreliable",
    async search(): Promise<SearchHit[]> {
      failedAttempts += 1;
      throw new RetryableSearchError("HTTP 503");
    },
  };
  const fallback: SearchBackend = {
    id: "fallback",
    label: "Fallback",
    async search(): Promise<SearchHit[]> {
      return [{ title: "Fallback result", url: "https://example.org/fallback" }];
    },
  };

  const outcome = await searchWithBackends("query", [unreliable, fallback]);
  assert.equal(failedAttempts, 2);
  assert.equal(outcome.backendId, "fallback");
  assert.equal(outcome.hits[0]?.title, "Fallback result");
  assert.match(outcome.failures[0] ?? "", /HTTP 503/);
});

test("an all-blocked chain reports block, not empty success", async () => {
  const blocked: SearchBackend = {
    id: "blocked",
    label: "Blocked",
    async search() {
      throw new SearchBlockedError("blocked", "bot challenge");
    },
  };

  const outcome = await searchWithBackends("query", [blocked]);
  assert.equal(outcome.backendId, null);
  assert.equal(outcome.hits.length, 0);
  assert.equal(outcome.blocked, true);
});

test("a backend error is recorded and does not stop the chain", async () => {
  const broken: SearchBackend = {
    id: "broken",
    label: "Broken",
    async search() {
      throw new Error("connection reset");
    },
  };
  const fallback: SearchBackend = {
    id: "fallback",
    label: "Fallback",
    async search(): Promise<SearchHit[]> {
      return [{ title: "Ok", url: "https://example.org/" }];
    },
  };

  const outcome = await searchWithBackends("query", [broken, fallback]);
  assert.equal(outcome.backendId, "fallback");
  assert.equal(outcome.blocked, false);
  assert.match(outcome.failures[0] ?? "", /connection reset/);
});

test("default backend order is HTML first, Lite second", () => {
  assert.equal(DEFAULT_SEARCH_BACKENDS.length, 2);
  assert.ok(DEFAULT_SEARCH_BACKENDS[0] instanceof DuckDuckGoHtmlBackend);
  assert.ok(DEFAULT_SEARCH_BACKENDS[1] instanceof DuckDuckGoLiteBackend);
});
