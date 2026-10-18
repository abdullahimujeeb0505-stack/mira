const LIGHTWEIGHT_MESSAGES = [
  /^(?:hi|hello|hey|good morning|good afternoon|good evening)\b/i,
  /^(?:how are you|how's it going|what's up)\??$/i,
  /^(?:what(?:'s| is) your name|who are you|what can you do|can you help me(?: study)?)\??$/i,
  /^(?:thanks|thank you|thx|bye|goodbye)\b/i,
];

const IDENTITY_PROMPT =
  String.raw`(?:who are you|what are you|what (?:kind|type) of (?:agent|assistant|bot|AI|model) are you|tell me (?:who|what) you are|tell me about yourself|describe yourself|introduce yourself)`;
const PURPOSE_PROMPT =
  String.raw`(?:what(?:'s|s| is) your (?:purpose|role|job|function)|why do you exist|what do you do|what can you do|what can you help (?:me )?with|how can you help(?: me)?|what are you for)`;
const INTENT_CONNECTOR =
  String.raw`(?:\s*(?:[,;.!?]\s*(?:(?:and|also|plus)\s+)?|\s+(?:and|also|plus)\s+))`;
const IDENTITY_REQUEST = new RegExp(
  String.raw`^(?:(?:hey|hi|yo)[,! ]+)?(?:${IDENTITY_PROMPT}(?:${INTENT_CONNECTOR}${PURPOSE_PROMPT})?|${PURPOSE_PROMPT}(?:${INTENT_CONNECTOR}${IDENTITY_PROMPT})?)(?:\s+(?:man|dude|bro|please|exactly))*[?.!]*$`,
  "i",
);

const EXPLICIT_RESEARCH_REQUEST =
  /\b(research|search the web|look up|find sources|cite sources|latest|current|today|recently|as of now)\b/i;
const INFORMATION_REQUEST =
  /^(?:who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|would|should|will)\b/i;
const EXPLANATION_REQUEST =
  /^(?:tell me about|explain|define|summari[sz]e|compare|investigate|look into)\b/i;
const CONTEXTUAL_FOLLOW_UP =
  /^(?:why|how so|what about(?: it| that)?|and then|then what|explain that simply|make that simpler|what does (?:this|that|it) mean(?: in practice)?|can you clarify that)\??$/i;
const CONTEXTUAL_RELATION_FOLLOW_UP =
  /\b(?:relate|related|connect|connection)\b.{0,100}\b(?:what you (?:just )?(?:researched|said|found)|previous (?:answer|research)|that topic)\b/i;

export function isIdentityQuestion(message: string): boolean {
  return IDENTITY_REQUEST.test(
    message.normalize("NFKC").replace(/[’‘]/g, "'").trim(),
  );
}

export function shouldResearchMessage(
  message: string,
  hasConversationHistory = false,
): boolean {
  const content = message.trim();
  if (
    !content ||
    isIdentityQuestion(content) ||
    LIGHTWEIGHT_MESSAGES.some((pattern) => pattern.test(content))
  ) {
    return false;
  }

  if (EXPLICIT_RESEARCH_REQUEST.test(content)) return true;
  if (hasConversationHistory && CONTEXTUAL_RELATION_FOLLOW_UP.test(content)) return false;
  if (CONTEXTUAL_FOLLOW_UP.test(content)) return false;
  if (EXPLANATION_REQUEST.test(content)) return true;
  if (INFORMATION_REQUEST.test(content)) return true;

  return hasConversationHistory && content.endsWith("?");
}
