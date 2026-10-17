import assert from "node:assert/strict";
import test from "node:test";
import { shouldResearchMessage } from "./message-routing.js";

test("greetings and lightweight chat do not trigger web research", () => {
  for (const message of [
    "Hi Muse",
    "How are you?",
    "What's your name?",
    "What can you do?",
    "Thanks!",
  ]) {
    assert.equal(shouldResearchMessage(message), false, message);
  }
});

test("substantive factual questions and explicit research requests use live research", () => {
  for (const message of [
    "Who invented the telephone?",
    "How does TypeScript type narrowing work?",
    "Tell me about the history of the printing press.",
    "Search the web for current Node.js LTS versions.",
  ]) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});

test("question follow-ups are researched when conversational context exists", () => {
  assert.equal(shouldResearchMessage("Why?", true), true);
  assert.equal(shouldResearchMessage("Why?", false), false);
});
