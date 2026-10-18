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

test("identity and capability questions stay conversational across phrasing and order", () => {
  for (const message of [
    "What are you man?",
    "Who are you, and what's your purpose?",
    "What's your purpose and who are you?",
    "What is your role?",
    "Tell me about yourself.",
    "What are you for?",
    "How can you help me?",
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
    "What can you do with Python?",
  ]) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});

test("contextual follow-ups use conversation context instead of repeating research", () => {
  for (const message of [
    "Why?",
    "How so?",
    "What about that?",
    "And then?",
    "Explain that simply",
    "What does this mean?",
    "Why was TypeScript created, and how does that relate to what you just researched?",
  ]) {
    assert.equal(shouldResearchMessage(message, true), false, message);
  }
  assert.equal(shouldResearchMessage("Search the web: why?", true), true);
  assert.equal(shouldResearchMessage("What about the security impact?", true), true);
});
