import assert from "node:assert/strict";
import test from "node:test";
import { containsWebTarget, isCreatorQuestion, isIdentityQuestion, shouldResearchMessage } from "./message-routing.js";

test("greetings and lightweight chat do not trigger web research", () => {
  for (const message of [
    "Hi Muse",
    "How are you?",
    "How are you doing today 😊😘",
    "How are you right now?",
    "Are you okay?",
    "Are you okay today?",
    "Are you doing okay?",
    "Are you all right?",
    "Are you free today?",
    "Are you available right now?",
    "Can we talk today?",
    "What's your name?",
    "What can you do?",
    "Thanks!",
  ]) {
    assert.equal(shouldResearchMessage(message), false, message);
  }
});

test("casual well-being checks stay narrow and substantive Are questions still use research", () => {
  assert.equal(shouldResearchMessage("Are you okay?"), false);
  assert.equal(shouldResearchMessage("Are you okay with this medication?"), true);
  assert.equal(shouldResearchMessage("Are you okay to confirm these claims?"), true);
});

test("time-sensitive lookups research while casual mentions of today or current do not", () => {
  for (const message of [
    "I had a long day today.",
    "I'm working on the current draft.",
    "I want to talk about recent events.",
  ]) {
    assert.equal(shouldResearchMessage(message), false, message);
  }
  for (const message of [
    "What is the current exchange rate?",
    "Current Bitcoin price today",
    "The latest Node.js version",
  ]) {
    assert.equal(shouldResearchMessage(message), true, message);
  }
});

test("identity and capability questions stay conversational across phrasing and order", () => {
  for (const message of [
    "What are you man?",
    "Who created you?",
    "Who created you, my guy?",
    "Who made Muse?",
    "Who is your developer?",
    "Who are you today?",
    "Who are you right now?",
    "What is your current role?",
    "What are your current capabilities?",
    "How can you help me today?",
    "Who are you, and what's your purpose?",
    "What's your purpose and who are you?",
    "What is your role?",
    "Tell me about yourself.",
    "What are you for?",
    "What are your capabilities",
    "What can't you research?",
    "What can’t you research?",
    "What can you research?",
    "What can't you reserch5",
    "Can you generate pics?",
    "Can you generate a picture of a cat?",
    "Are you sure you are a research agent?",
    "No, I'm asking you that: are you sure you are a research agent?",
    "How can you help me?",
  ]) {
    assert.equal(shouldResearchMessage(message), false, message);
  }
  assert.equal(isIdentityQuestion("What are your capabilities"), true);
  assert.equal(isCreatorQuestion("Who created you?"), true);
  assert.equal(isCreatorQuestion("Who created you, my guy?"), true);
  assert.equal(isIdentityQuestion("Who made Muse?"), true);
  assert.equal(
    isIdentityQuestion("No, I'm asking you that: are you sure you are a research agent?"),
    true,
  );
});

test("substantive factual questions and explicit research requests use live research", () => {
  for (const message of [
    "Who invented the telephone?",
    "Who created the telephone?",
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
    "Rewrite your answer as a simple explanation for a beginner. Keep the important facts, remove unnecessary research diagnostics, and retain appropriate citations.",
  ]) {
    assert.equal(shouldResearchMessage(message, true), false, message);
  }
  assert.equal(shouldResearchMessage("Search the web: why?", true), true);
  assert.equal(shouldResearchMessage("What about the security impact?", true), true);
  assert.equal(shouldResearchMessage("Rewrite your answer with the latest research.", true), true);
});

test("short confirmation challenges stay conversational and can reuse prior research", () => {
  for (const message of [
    "Are you sure?",
    "Are you sure ?",
    "Are you certain about that?",
    "Can you confirm that?",
    "Confirm?",
  ]) {
    assert.equal(shouldResearchMessage(message, true), false, message);
    assert.equal(shouldResearchMessage(message, false), false, message);
  }
  assert.equal(shouldResearchMessage("Can you confirm the current exchange rate?", true), true);
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
