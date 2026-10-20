import assert from "node:assert/strict";
import test from "node:test";
import {
  imageSearchQuery,
  isAttributionFreeImage,
  parseCommonsImageSearchResults,
  parseOpenverseImageSearchResults,
  searchResearchImages,
} from "./research-images.js";

const OPENVERSE_RECORD = {
  title: "Honeybee pollinating a flower",
  thumbnail:
    "https://api.openverse.org/v1/images/550e8400-e29b-41d4-a716-446655440000/thumb/",
  foreign_landing_url: "https://www.flickr.com/photos/example/1",
  creator: "Example photographer",
  license: "by-sa",
  license_version: "4.0",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
  source: "flickr",
  mature: false,
};

test("image search queries retain the subject and remove request wording", () => {
  assert.equal(
    imageSearchQuery(
      "Show me pictures of monarch butterflies to support my research",
    ),
    "monarch butterflies",
  );
  assert.equal(
    imageSearchQuery("Can you show me images of monarch butterflies?"),
    "monarch butterflies",
  );
  assert.equal(
    imageSearchQuery("Please find a diagram of the water cycle."),
    "water cycle",
  );
  assert.equal(
    imageSearchQuery("Define pollination with additional img description."),
    "pollination",
  );
  assert.equal(
    imageSearchQuery("Explain pollination with a relevant image."),
    "pollination",
  );
  assert.equal(
    imageSearchQuery(
      "Define pollination; don't generate an image, attach existing images available online.",
    ),
    "pollination",
  );
  assert.equal(
    imageSearchQuery(
      "Define pollination; it is not necessary the image is generated, it should be attached from ones available online.",
    ),
    "pollination",
  );
  assert.equal(imageSearchQuery("Add an image to that."), "");
  assert.equal(imageSearchQuery("Attach a picture to its research."), "");
  assert.equal(
    imageSearchQuery("Attach an image to my previous findings."),
    "",
  );
  assert.equal(
    imageSearchQuery(
      "Read the supplied page at https://example.org/articles/pollination and attach an image.",
      "Honeybee pollination",
    ),
    "Honeybee pollination",
  );
  assert.equal(
    imageSearchQuery("Add an image to that.", "What is pollination?"),
    "pollination",
  );
  assert.equal(
    imageSearchQuery("Add an image of a cat.", "What is pollination?"),
    "cat",
  );
  assert.equal(
    imageSearchQuery("What is the history of Donald Trump?"),
    "Donald Trump",
  );
  assert.equal(
    imageSearchQuery(
      "What about his family?",
      "What is the history of Donald Trump?\nDonald Trump biography",
    ),
    "Donald Trump family",
  );
});

test("clean research image eligibility is limited to CC0 and public-domain licenses", () => {
  assert.equal(isAttributionFreeImage({ license: "CC0 1.0" }), true);
  assert.equal(
    isAttributionFreeImage({ license: "Public Domain Mark 1.0" }),
    true,
  );
  assert.equal(isAttributionFreeImage({ license: "Public domain" }), true);
  assert.equal(isAttributionFreeImage({ license: "CC BY 4.0" }), false);
  assert.equal(isAttributionFreeImage({ license: "CC BY-SA 4.0" }), false);
  assert.equal(isAttributionFreeImage({}), false);
});

test("Commons image results retain attribution and reject non-Commons hosts", () => {
  const results = parseCommonsImageSearchResults(
    JSON.stringify({
      query: {
        pages: [
          {
            title: "File:Monarch butterfly.jpg",
            imageinfo: [
              {
                thumburl:
                  "https://upload.wikimedia.org/wikipedia/commons/1/1a/Monarch.jpg",
                descriptionurl:
                  "https://commons.wikimedia.org/wiki/File:Monarch_butterfly.jpg",
                extmetadata: {
                  Artist: { value: "Photographer" },
                  LicenseShortName: { value: "CC BY-SA 4.0" },
                },
              },
            ],
          },
          {
            title: "File:External image.jpg",
            imageinfo: [
              {
                thumburl: "https://example.com/image.jpg",
                descriptionurl:
                  "https://commons.wikimedia.org/wiki/File:External_image.jpg",
              },
            ],
          },
        ],
      },
    }),
  );

  assert.deepEqual(results, [
    {
      title: "Monarch butterfly.jpg",
      imageUrl:
        "https://upload.wikimedia.org/wikipedia/commons/1/1a/Monarch.jpg",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Monarch_butterfly.jpg",
      creator: "Photographer",
      license: "CC BY-SA 4.0",
    },
  ]);
});

test("Openverse images preserve source and linked license metadata", () => {
  const results = parseOpenverseImageSearchResults(
    JSON.stringify({
      results: [
        OPENVERSE_RECORD,
        null,
        "invalid record",
        { ...OPENVERSE_RECORD, title: 7 },
        { ...OPENVERSE_RECORD, thumbnail: "https://example.com/image.jpg" },
        { ...OPENVERSE_RECORD, license: "by-nc-sa" },
        {
          ...OPENVERSE_RECORD,
          license_url: "https://evilcreativecommons.org/licenses/by-sa/4.0/",
        },
        { ...OPENVERSE_RECORD, mature: true },
      ],
    }),
  );

  assert.deepEqual(results, [
    {
      title: "Honeybee pollinating a flower",
      imageUrl: OPENVERSE_RECORD.thumbnail,
      pageUrl: OPENVERSE_RECORD.foreign_landing_url,
      creator: "Example photographer",
      license: "CC BY-SA 4.0",
      licenseUrl: OPENVERSE_RECORD.license_url,
      source: "Flickr",
    },
  ]);
});

test("a context-only image follow-up searches the saved research topic without empty searches", async () => {
  const requestUrls = new Map<string, URL>();
  let requestCount = 0;
  const fetcher = async (input: Parameters<typeof fetch>[0]) => {
    requestCount += 1;
    const url = new URL(String(input));
    requestUrls.set(url.hostname, url);
    const payload =
      url.hostname === "api.openverse.org"
        ? { results: [] }
        : { query: { pages: [] } };
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  assert.deepEqual(
    await searchResearchImages("Add an image to that.", fetcher),
    [],
  );
  assert.equal(requestCount, 0);

  await searchResearchImages(
    "Add an image to that.",
    fetcher,
    "What is pollination?",
  );
  assert.equal(requestUrls.size, 2);
  assert.equal(
    requestUrls.get("commons.wikimedia.org")?.searchParams.get("gsrsearch"),
    "pollination",
  );
  assert.equal(
    requestUrls.get("api.openverse.org")?.searchParams.get("q"),
    "pollination",
  );
});

test("image search checks Openverse and Commons in parallel and returns vetted images", async () => {
  const requestUrls = new Map<string, URL>();
  const results = await searchResearchImages(
    "Can you show me pictures of monarch butterflies?",
    async (input) => {
      const url = new URL(String(input));
      requestUrls.set(url.hostname, url);
      const payload =
        url.hostname === "api.openverse.org"
          ? { results: [OPENVERSE_RECORD] }
          : {
              query: {
                pages: [
                  {
                    title: "File:Monarch butterfly.jpg",
                    imageinfo: [
                      {
                        thumburl:
                          "https://upload.wikimedia.org/wikipedia/commons/1/1a/Monarch.jpg",
                        descriptionurl:
                          "https://commons.wikimedia.org/wiki/File:Monarch_butterfly.jpg",
                      },
                    ],
                  },
                ],
              },
            };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  );

  assert.deepEqual([...requestUrls.keys()].sort(), [
    "api.openverse.org",
    "commons.wikimedia.org",
  ]);
  assert.equal(
    requestUrls.get("api.openverse.org")?.searchParams.get("q"),
    "monarch butterflies",
  );
  assert.equal(
    requestUrls.get("api.openverse.org")?.searchParams.get("license_type"),
    "commercial",
  );
  assert.equal(
    requestUrls.get("commons.wikimedia.org")?.searchParams.get("gsrsearch"),
    "monarch butterflies",
  );
  assert.equal(results.length, 2);
  assert.equal(results[0]?.source, "Flickr");
  assert.equal(results[1]?.title, "Monarch butterfly.jpg");
});

test("automatic clean-image search returns a CC0 match without waiting for Commons", async () => {
  let commonsStarted = false;
  let commonsFinished = false;
  let openverseRequest: URL | undefined;
  const results = await searchResearchImages(
    "What is the history of Donald Trump?",
    async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "commons.wikimedia.org") {
        commonsStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 75));
        commonsFinished = true;
        return new Response(JSON.stringify({ query: { pages: [] } }), {
          status: 200,
        });
      }
      openverseRequest = url;
      return new Response(
        JSON.stringify({
          results: [
            {
              ...OPENVERSE_RECORD,
              title: "Donald Trump speaking at a public event",
              license: "cc0",
              license_version: "1.0",
              license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
            },
          ],
        }),
        { status: 200 },
      );
    },
    "",
    1,
    true,
  );

  assert.equal(commonsStarted, true);
  assert.equal(commonsFinished, false);
  assert.equal(openverseRequest?.searchParams.get("license"), "cc0,pdm");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.license, "CC0 1.0");
  assert.equal(isAttributionFreeImage(results[0]!), true);
  assert.match(results[0]?.title ?? "", /Donald Trump/);
});

test("clean image search filters attributed results and searches public-domain Commons files", async () => {
  const requests: URL[] = [];
  const results = await searchResearchImages(
    "Monarch butterflies",
    async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.hostname === "api.openverse.org") {
        return new Response(JSON.stringify({ results: [OPENVERSE_RECORD] }), {
          status: 200,
        });
      }
      const search = url.searchParams.get("gsrsearch") ?? "";
      const pages = search.includes("haswbstatement:P275=Q6938433")
        ? [
            {
              title: "File:Monarch butterfly CC0.jpg",
              imageinfo: [
                {
                  thumburl:
                    "https://upload.wikimedia.org/wikipedia/commons/1/1a/Monarch_CC0.jpg",
                  descriptionurl:
                    "https://commons.wikimedia.org/wiki/File:Monarch_CC0.jpg",
                  extmetadata: {
                    LicenseShortName: { value: "CC0 1.0" },
                  },
                },
              ],
            },
          ]
        : [];
      return new Response(JSON.stringify({ query: { pages } }), {
        status: 200,
      });
    },
    "",
    1,
    true,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Monarch butterfly CC0.jpg");
  assert.equal(isAttributionFreeImage(results[0]!), true);
  assert.equal(
    requests
      .find((url) => url.hostname === "api.openverse.org")
      ?.searchParams.get("license"),
    "cc0,pdm",
  );
  assert.ok(
    requests.some((url) =>
      url.searchParams
        .get("gsrsearch")
        ?.includes("haswbstatement:P275=Q6938433"),
    ),
  );
  assert.ok(
    requests.some((url) =>
      url.searchParams
        .get("gsrsearch")
        ?.includes("haswbstatement:P6216=Q19652"),
    ),
  );
});

test("Openverse results remain available when Commons is unavailable", async () => {
  const results = await searchResearchImages(
    "Show me a picture of pollination",
    async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "commons.wikimedia.org") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ results: [OPENVERSE_RECORD] }), {
        status: 200,
      });
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.source, "Flickr");
});

test("Commons results remain available when Openverse is rate-limited", async () => {
  const results = await searchResearchImages(
    "Show me a picture of pollination",
    async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.openverse.org") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: "File:Pollination.jpg",
                imageinfo: [
                  {
                    thumburl:
                      "https://upload.wikimedia.org/wikipedia/commons/1/1a/Pollination.jpg",
                    descriptionurl:
                      "https://commons.wikimedia.org/wiki/File:Pollination.jpg",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    },
    "",
    1,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Pollination.jpg");
  assert.equal(results[0]?.source, undefined);
});
