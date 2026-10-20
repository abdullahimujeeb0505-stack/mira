import assert from "node:assert/strict";
import test from "node:test";
import {
  imageSearchQuery,
  parseCommonsImageSearchResults,
  searchResearchImages,
} from "./research-images.js";

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

test("image search calls Commons with the cleaned query and returns vetted images", async () => {
  let requestUrl: URL | undefined;
  const results = await searchResearchImages(
    "Can you show me pictures of monarch butterflies?",
    async (input) => {
      requestUrl = new URL(String(input));
      return new Response(
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
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    },
  );

  assert.equal(requestUrl?.hostname, "commons.wikimedia.org");
  assert.equal(
    requestUrl?.searchParams.get("gsrsearch"),
    "monarch butterflies",
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Monarch butterfly.jpg");
});
