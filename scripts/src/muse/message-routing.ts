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
const INSPECTION_REQUEST =
  /\b(?:look (?:through|over|at)|check (?:out|through)|go through|take a look|browse through|read through|dig through)\b/i;
const INFORMATION_REQUEST =
  /^(?:who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|would|should|will)\b/i;
const EXPLANATION_REQUEST =
  /^(?:tell me about|explain|define|summari[sz]e|compare|investigate|look into)\b/i;

/**
 * Top-level domains Muse treats as website references when deciding whether a
 * message points at a page. A curated list keeps everyday prose — abbreviations
 * like "e.g.", filenames like "readme.md", version numbers like "1.2.3" — from
 * being mistaken for links.
 */
const COMMON_WEBSITE_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "dev", "ai", "app",
  "sh", "codes", "tech", "xyz", "co", "me", "ly", "fm", "info", "biz", "site",
  "online", "store", "blog", "cloud", "so", "gg", "tv", "cc", "page", "new",
  "systems", "network", "world", "news", "media", "digital", "studio",
  "agency", "company", "tools", "works", "team", "hub", "space", "life",
  "today", "pro", "chat", "app", "fun", "run", "build", "zone", "link",
]);
/** Second-level labels that precede a two-letter country-code TLD. */
const COMMON_CC_SECOND_LEVELS = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "sch", "ltd", "plc", "me",
  "gen", "firm", "ind", "web", "name",
]);

/**
 * True when the message references a website: an explicit URL, a `www.` host,
 * or a bare domain with a recognised top-level domain.
 *
 * "look through photon.codes for me", "check photon.codes", and
 * "https://photon.codes/pricing" all qualify, so a phrasing typo can never
 * leave a named link unread.
 */
export function containsWebTarget(message: string): boolean {
  if (/(?:https?:\/\/|www\.)[^\s"'<>]+/i.test(message)) return true;

  for (const match of message.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const labels = match[1].toLowerCase().split(".");
    const tld = labels[labels.length - 1] ?? "";
    if (labels.length === 2 && COMMON_WEBSITE_TLDS.has(tld)) return true;
    if (
      labels.length >= 3 &&
      (COMMON_WEBSITE_TLDS.has(tld) ||
        (tld.length === 2 && COMMON_CC_SECOND_LEVELS.has(labels[labels.length - 2] ?? "")))
    ) {
      return true;
    }
  }
  return false;
}
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
  if (containsWebTarget(content)) return true;
  if (INSPECTION_REQUEST.test(content)) return true;
  if (hasConversationHistory && CONTEXTUAL_RELATION_FOLLOW_UP.test(content)) return false;
  if (CONTEXTUAL_FOLLOW_UP.test(content)) return false;
  if (EXPLANATION_REQUEST.test(content)) return true;
  if (INFORMATION_REQUEST.test(content)) return true;

  return hasConversationHistory && content.endsWith("?");
}
