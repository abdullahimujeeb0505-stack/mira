import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY,
  IMAGE_GENERATION_SUCCESS_REPLY,
  IMAGE_GENERATION_UNAVAILABLE_REPLY,
  IMAGE_GENERATION_USAGE_REPLY,
  parseImageGenerationCommand,
  runImageGenerationCommand,
} from "./image-generation-command.js";

const image = {
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png" as const,
};

test("image-generation commands parse explicit natural and slash-command forms", () => {
  assert.deepEqual(parseImageGenerationCommand("generate image: a red fox"), {
    kind: "generate",
    prompt: "a red fox",
  });
  assert.deepEqual(
    parseImageGenerationCommand("Could you create a picture of a blue bird?"),
    { kind: "generate", prompt: "a blue bird?" },
  );
  assert.deepEqual(
    parseImageGenerationCommand(
      "Please make me an illustration of a city at dusk",
    ),
    { kind: "generate", prompt: "a city at dusk" },
  );
  assert.deepEqual(parseImageGenerationCommand("/imagine: a quiet lake"), {
    kind: "generate",
    prompt: "a quiet lake",
  });
  assert.deepEqual(parseImageGenerationCommand("/image a paper-cut flower"), {
    kind: "generate",
    prompt: "a paper-cut flower",
  });
});

test("image-generation parsing leaves ordinary conversation on the chat path", () => {
  assert.equal(
    parseImageGenerationCommand("How does image generation work?"),
    undefined,
  );
  assert.equal(
    parseImageGenerationCommand("Draw a conclusion from these results."),
    undefined,
  );
  assert.equal(
    parseImageGenerationCommand("The generate image button is missing."),
    undefined,
  );
});

test("image-generation commands distinguish missing and oversized prompts", () => {
  assert.deepEqual(parseImageGenerationCommand("generate image"), {
    kind: "missing-prompt",
  });
  assert.deepEqual(parseImageGenerationCommand("/image:   "), {
    kind: "missing-prompt",
  });
  assert.deepEqual(parseImageGenerationCommand("generate image of"), {
    kind: "missing-prompt",
  });
  assert.deepEqual(parseImageGenerationCommand("generate image of:"), {
    kind: "missing-prompt",
  });
  assert.deepEqual(
    parseImageGenerationCommand(`generate image: ${"x".repeat(1_001)}`),
    { kind: "prompt-too-long" },
  );
  assert.deepEqual(
    parseImageGenerationCommand(`generate image: ${"x".repeat(1_000)}`),
    { kind: "generate", prompt: "x".repeat(1_000) },
  );
});

test("image-generation command runner skips the provider when the prompt is invalid", async () => {
  let calls = 0;
  const generateImage = async () => {
    calls += 1;
    return image;
  };

  assert.deepEqual(
    await runImageGenerationCommand(
      { kind: "missing-prompt" },
      generateImage,
      () => {},
    ),
    { text: IMAGE_GENERATION_USAGE_REPLY },
  );
  assert.deepEqual(
    await runImageGenerationCommand(
      { kind: "prompt-too-long" },
      generateImage,
      () => {},
    ),
    { text: IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY },
  );
  assert.equal(calls, 0);
});

test("image-generation command runner invokes only the supplied image provider", async () => {
  const prompts: string[] = [];
  const response = await runImageGenerationCommand(
    { kind: "generate", prompt: "a fox reading a book" },
    async (prompt) => {
      prompts.push(prompt);
      return image;
    },
    () => {},
  );

  assert.deepEqual(prompts, ["a fox reading a book"]);
  assert.deepEqual(response, {
    text: IMAGE_GENERATION_SUCCESS_REPLY,
    image,
  });
});

test("image-generation failures are reported without exposing details to the user", async () => {
  const failures: string[] = [];
  const response = await runImageGenerationCommand(
    { kind: "generate", prompt: "a cat" },
    async () => {
      throw new Error("private Cloudflare token");
    },
    (failure) => failures.push(failure),
  );

  assert.deepEqual(response, { text: IMAGE_GENERATION_UNAVAILABLE_REPLY });
  assert.deepEqual(failures, [
    "Muse could not generate an image for an incoming iMessage.",
  ]);
  assert.doesNotMatch(failures.join(" "), /private Cloudflare token/);
});

test("image-generation commands report missing Cloudflare configuration safely", async () => {
  const failures: string[] = [];
  const response = await runImageGenerationCommand(
    { kind: "generate", prompt: "a cat" },
    undefined,
    (failure) => failures.push(failure),
  );

  assert.deepEqual(response, { text: IMAGE_GENERATION_UNAVAILABLE_REPLY });
  assert.deepEqual(failures, [
    "Muse image generation is unavailable because Cloudflare Workers AI is not configured.",
  ]);
});
