import assert from "node:assert/strict";
import test from "node:test";
import { containsWebTarget, shouldResearchMessage } from "./message-routing.js";

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

test("a message naming a website triggers research regardless of phrasing", () => {
  for (const message of [
    "look through photon.codes for me",
    "Look throught photon.codes up for me",
    "check out photon.codes",
    "photon.codes",
    "please read https://photon.codes/pricing",
    "What about docs.photon.codes?",
    "Compare photon.codes and github.com/photon-hq",
  ]) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});

test("inspection phrasing without a link still routes to research", () => {
  for (const message of [
    "look through the docs for me",
    "check out the latest pricing",
    "go through that page and summarize it",
  ]) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});

test("everyday prose with abbreviations and filenames is not mistaken for a link", () => {
  for (const message of [
    "e.g. can you help me think this through",
    "readme.md should explain it",
    "I upgraded from 1.2.3 to 2.0.0",
    "My email is someone@example",
  ]) {
    assert.equal(containsWebTarget(message), false, message);
    assert.equal(shouldResearchMessage(message), false, message);
  }
});

test("web-target detection accepts real domains and rejects unsafe schemes", () => {
  assert.equal(containsWebTarget("look at photon.codes"), true);
  assert.equal(containsWebTarget("visit www.example.org"), true);
  assert.equal(containsWebTarget("see example.co.uk"), true);
  assert.equal(containsWebTarget("read http://127.0.0.1/admin"), true);
  assert.equal(containsWebTarget("no links in this sentence"), false);
  assert.equal(containsWebTarget("javascript:alert(1)"), false);
});

test("questions about the assistant itself are chat, not research", () => {
  for (
    const message of [
      "What AI model is this",
      "What AI model is this?",
      "Which agent is this",
      "What model is this",
      "Which model are you",
      "What kind of AI are you",
      "Is this a real person",
      "Are you a bot",
      "what llm powers you",
      "What model runs this",
    ]
  ) {
    assert.equal(shouldResearchMessage(message, true), false, message);
    assert.equal(shouldResearchMessage(message, false), false, message);
  }
});

test("ordinary what/which questions still route to research", () => {
  for (
    const message of [
      "What's the history of Trump",
      "What model of car does Toyota make in Nigeria",
      "Which team won the 2018 World Cup",
      "What is photosynthesis",
    ]
  ) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});
