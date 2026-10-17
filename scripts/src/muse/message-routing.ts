const LIGHTWEIGHT_MESSAGES = [
  /^(?:hi|hello|hey|good morning|good afternoon|good evening)\b/i,
  /^(?:how are you|how's it going|what's up)\??$/i,
  /^(?:what(?:'s| is) your name|who are you|what can you do|can you help me(?: study)?)\??$/i,
  /^(?:thanks|thank you|thx|bye|goodbye)\b/i,
];

const EXPLICIT_RESEARCH_REQUEST =
  /\b(research|search the web|look up|find sources|cite sources|latest|current|today|recently|as of now)\b/i;
const INFORMATION_REQUEST =
  /^(?:who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|would|should|will)\b/i;
const EXPLANATION_REQUEST =
  /^(?:tell me about|explain|define|summari[sz]e|compare|investigate|look into)\b/i;
const CONTEXTUAL_FOLLOW_UP =
  /^(?:why|how so|what about(?: it| that)?|and then|then what|explain that simply|make that simpler|what does (?:this|that) mean|can you clarify that)\??$/i;
const CONTEXTUAL_RELATION_FOLLOW_UP =
  /\b(?:relate|related|connect|connection)\b.{0,100}\b(?:what you (?:just )?(?:researched|said|found)|previous (?:answer|research)|that topic)\b/i;

export function shouldResearchMessage(
  message: string,
  hasConversationHistory = false,
): boolean {
  const content = message.trim();
  if (!content || LIGHTWEIGHT_MESSAGES.some((pattern) => pattern.test(content))) {
    return false;
  }

  if (EXPLICIT_RESEARCH_REQUEST.test(content)) return true;
  if (hasConversationHistory && CONTEXTUAL_RELATION_FOLLOW_UP.test(content)) return false;
  if (CONTEXTUAL_FOLLOW_UP.test(content)) return false;
  if (EXPLANATION_REQUEST.test(content)) return true;
  if (INFORMATION_REQUEST.test(content)) return true;

  return hasConversationHistory && content.endsWith("?");
}
