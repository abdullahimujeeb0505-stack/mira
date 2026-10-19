import assert from "node:assert/strict";
import test from "node:test";
import { extractLinks, fetchSameHostRedirects } from "./source-verification.js";

const base = new URL("https://example.org/story");

test("source verification rejects DNS answers in private ranges before fetching", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    fetchSameHostRedirects(new URL("https://example.org/"), {
      resolveHost: async () => [{ address: "10.0.0.7" }],
      fetchImplementation: async () => {
        fetchCalls += 1;
        return new Response("should not be fetched");
      },
    }),
    /non-public address/,
  );
  assert.equal(fetchCalls, 0);
});

test("source verification re-checks DNS for each same-host redirect", async () => {
  let hostChecks = 0;
  let fetchCalls = 0;
  const fetched = await fetchSameHostRedirects(new URL("https://example.org/start"), {
    resolveHost: async (hostname) => {
      hostChecks += 1;
      assert.equal(hostname, "example.org");
      return [{ address: "93.184.216.34" }];
    },
    fetchImplementation: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response(null, { status: 302, headers: { Location: "/final" } })
        : new Response("readable", { status: 200 });
    },
  });

  assert.equal(hostChecks, 2);
  assert.equal(fetchCalls, 2);
  assert.equal(fetched.finalUrl.href, "https://example.org/final");
  assert.equal(fetched.response.status, 200);
});

test("keeps a clearly labelled external application form", () => {
  const links = extractLinks(
    '<main><a href="https://forms.example/apply">Apply now</a></main>',
    base,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.url, "https://forms.example/apply");
});

test("keeps an application-like path with a generic label", () => {
  const links = extractLinks(
    '<main><a href="https://program.example/grants/apply">Learn more</a></main>',
    base,
  );
  assert.equal(links.length, 1);
});

test("rejects login, tag, category, search and editorial destinations", () => {
  const links = extractLinks(
    '<main>' +
      '<a href="https://example.org/login">Apply now</a>' +
      '<a href="https://example.org/tag/grants">Grant opportunities</a>' +
      '<a href="https://example.org/category/hackathons">Join hackathon</a>' +
      '<a href="https://example.org/search?q=grant">Apply</a>' +
      '<a href="https://news.example/news/grant-program">Register now</a>' +
      '</main>',
    base,
  );
  assert.deepEqual(links, []);
});

test("rejects unrelated links that only contain keywords in their URL", () => {
  const links = extractLinks(
    '<main><a href="https://example.org/story-about-grants">Read more</a></main>',
    base,
  );
  assert.deepEqual(links, []);
});

test("deduplicates tracking variants and removes fragments", () => {
  const links = extractLinks(
    '<main>' +
      '<a href="/apply?utm_source=x#form">Apply now</a>' +
      '<a href="/apply?utm_source=y">Apply now</a>' +
      '</main>',
    base,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.url, "https://example.org/apply");
});

test("rejects unsafe link protocols", () => {
  const links = extractLinks(
    '<main><a href="javascript:alert(1)">Apply now</a></main>',
    base,
  );
  assert.deepEqual(links, []);
});


test("rejects LinkedIn signup and engagement links", () => {
  const html = `
    <a href="https://www.linkedin.com/signup/cold-join?trk=public_post_social-actions-reactions">81</a>
    <a href="https://www.linkedin.com/signup/cold-join?trk=public_post_comments">52 Comments</a>
    <a href="https://example.org/apply">Apply</a>
  `;
  const links = extractLinks(html, base);
  assert.equal(links.some((link) => link.url.includes("linkedin.com/signup")), false);
  assert.equal(links.some((link) => /comments|reactions/i.test(link.text)), false);
});
