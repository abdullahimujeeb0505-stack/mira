import type { NewMemory } from "./memory-types.js";
import { containsCredentialMaterial } from "./memory-safety.js";

const MEMORY_SIGNALS: ReadonlyArray<{
  category: NewMemory["category"];
  pattern: RegExp;
}> = [
  {
    category: "ACTIVE",
    pattern:
      /\b(?:i(?:'m| am) (?:currently )?(?:working on|building)|my current (?:project|goal)|i plan to (?:build|launch|start)|i am launching)\b/i,
  },
  {
    category: "WATCHING",
    pattern:
      /\b(?:i(?:'m| am) (?:watching|tracking)|keep an eye on|(?:watch|monitor|track) (?:the )?[a-z0-9$.-]+|i want to follow)\b/i,
  },
  {
    category: "HISTORY",
    pattern:
      /\b(?:i (?:finished|completed|launched|shipped|published|graduated)|we (?:launched|shipped|completed)|my previous (?:project|role|job))\b/i,
  },
  {
    category: "CONTENT",
    pattern:
      /\b(?:i (?:create|publish|post|write) (?:content|videos?|articles?|posts?|threads?)|my (?:newsletter|blog|podcast|content series|youtube channel)|i have a newsletter|my audience is)\b/i,
  },
  {
    category: "USER",
    pattern:
      /\b(?:my (?:name|role|pronouns|timezone|location|language|preference|preferences|favorite|favourite|pet|dog|cat|company|team)\b.{0,24}\b(?:is|are)|i (?:prefer|like|love|dislike|hate|use|work as|live in)|call me|i(?:'m| am) (?:a|an)\b)/i,
  },
  {
    category: "USER",
    pattern: /\b(?:please )?remember (?:that )?(?:i|my|we|our)\b/i,
  },
];

export function detectMemoryCandidate(message: string): NewMemory | undefined {
  const content = message.trim();
  if (!content || containsCredentialMaterial(content)) return undefined;
  if (/\b(?:forget|delete|remove|don't remember|do not remember)\b/i.test(content)) {
    return undefined;
  }

  const signal = MEMORY_SIGNALS.find(({ pattern }) => pattern.test(content));
  return signal ? { category: signal.category, content } : undefined;
}
