const LIGHTWEIGHT_MESSAGES = [
  /^(?:hi|hello|hey|good morning|good afternoon|good evening)[,!\.\s…\p{Extended_Pictographic}\uFE0F]*$/iu,
  /^(?:how are you(?: doing)?(?: today| right now)?|how's it going|what's up)[\s.!?…\p{Extended_Pictographic}\uFE0F]*$/iu,
  /^are you (?:doing )?(?:ok(?:ay)?|alright|all right|well)(?: today| right now)?[\s.!?…\p{Extended_Pictographic}\uFE0F]*$/iu,
  /^(?:are you (?:free|available|busy|around)(?: today| right now)?|can we talk(?: today| right now)?)[\s.!?…\p{Extended_Pictographic}\uFE0F]*$/iu,
  /^(?:what(?:'s| is) your name|who are you|what can you do|can you help me(?: study)?)\??$/i,
  /^(?:thanks|thank you|thx|bye|goodbye)\b/i,
];

const CREATOR_PROMPT =
  String.raw`(?:who (?:made|created|built|developed|programmed|trained) (?:you|muse)|who is your (?:creator|maker|developer|author))`;
const IDENTITY_PROMPT =
  String.raw`(?:who are you|what are you|what (?:kind|type) of (?:agent|assistant|bot|AI|model) are you|tell me (?:who|what) you are|tell me about yourself|describe yourself|introduce yourself)`;
const PURPOSE_PROMPT =
  String.raw`(?:what(?:'s|s| is) your (?:current\s+)?(?:purpose|role|job|function)|what are your (?:current\s+)?capabilities|why do you exist|what do you do|what can you do|what can you help (?:me )?with|how can you help(?: me)?|what are you for)`;
const IDENTITY_CHALLENGE_PROMPT = String.raw`(?:(?:no[,! ]+)?i(?:'m| am) asking(?: you)?(?: that)?[,;:]?\s+)?(?:are you (?:sure|certain) (?:that )?you are (?:a|an) (?:research\s+)?(?:agent|assistant|bot|ai|model)|are you (?:really|actually) (?:a|an) (?:research\s+)?(?:agent|assistant|bot|ai|model))`;
/** "What AI model is this", "Which agent is this", "Is this a real person" —
 *  questions about the assistant itself, not research topics. */
const SELF_MODEL_PROMPT =
  String.raw`(?:(?:what|which)(?:\s+(?:kind|type)\s+of)?\s+(?:ai\s+|llm\s+|language\s+model\s+)?(?:model|agent|assistant|bot|ai|llm)(?:\s+model)?\s+(?:is|are)\s+(?:this|that|it|you)(?:\s+(?:one|right now|here))?|what\s+(?:model|ai|llm)(?:\s+model)?\s+(?:powers?|drives?|runs?)\s+(?:you|this|that)|(?:is|are)\s+(?:this|that|you)\s+(?:an?\s+)?(?:ai|bot|agent|model|human|person|real(?:\s+(?:person|human|agent|ai))?))`;
const INTENT_CONNECTOR =
  String.raw`(?:\s*(?:[,;.!?]\s*(?:(?:and|also|plus)\s+)?|\s+(?:and|also|plus)\s+))`;
const IDENTITY_SUFFIX =
  String.raw`(?:[\s,]+(?:man|dude|bro|my\s+guy|buddy|mate|please|exactly|today|currently|right\s+now|at\s+the\s+moment))*[?.!]*$`;
const IDENTITY_REQUEST = new RegExp(
  String.raw`^(?:(?:hey|hi|yo)[,! ]+)?(?:${CREATOR_PROMPT}|${IDENTITY_PROMPT}(?:${INTENT_CONNECTOR}${PURPOSE_PROMPT})?|${PURPOSE_PROMPT}(?:${INTENT_CONNECTOR}${IDENTITY_PROMPT})?|${SELF_MODEL_PROMPT}|${IDENTITY_CHALLENGE_PROMPT})${IDENTITY_SUFFIX}`,
  "i",
);
const CREATOR_REQUEST = new RegExp(
  String.raw`^(?:(?:hey|hi|yo)[,! ]+)?${CREATOR_PROMPT}${IDENTITY_SUFFIX}`,
  "i",
);

const EXPLICIT_RESEARCH_REQUEST =
  /(?:^\s*(?:please\s+)?(?:research|search)\b|\b(?:please|can you|could you|would you|will you|should|must|need to|want to|want you to|let's|do(?: some)?|help me)\s+(?:also\s+)?research\b|\b(?:search the web|search online|look up|find sources|cite sources)\b)/i;
const CURRENT_INFORMATION_MARKER =
  /\b(?:latest|newest|current(?:ly)?|today|recent(?:ly)?|as of now|right now)\b/i;
const DYNAMIC_LOOKUP_FRAGMENT =
  /^(?:the\s+)?(?:latest|newest|current|recent|today(?:['’]s)?|as of now)\b.{0,160}\b(?:price|net[\s-]*worth|version|release|news|weather|forecast|exchange rate|market(?: cap)?|stock|status|population|inflation|score|results|schedule|deadline|valuation|update|research|developments|guidance|guidelines|laws|regulations)\b/i;
const DYNAMIC_LOOKUP_ACTION =
  /\b(?:find|show|get|check|look up|tell me|give me|need|want|update|rewrite|revise|refresh)\b/i;
const DYNAMIC_LOOKUP_SUBJECT =
  /\b(?:price|net[\s-]*worth|version|release|news|weather|forecast|exchange rate|market(?: cap)?|stock|status|population|inflation|score|results|schedule|deadline|valuation|research|developments|guidance|guidelines|laws|regulations)\b/i;
const INSPECTION_REQUEST =
  /\b(?:look (?:through|over|at)|check (?:out|through)|go through|take a look|browse through|read through|dig through)\b/i;
const SUBJECTIVE_CONVERSATION_REQUEST =
  /^(?:what do you think(?: about)?|what(?:'s| is) your (?:take|opinion)(?: on)?|in your opinion|do you (?:agree|think)|can you brainstorm|let['’]s brainstorm|help me brainstorm|brainstorm\b|what would you do|can we talk|i need to talk|i want to talk|tell me a joke|make me laugh|help me (?:think through|come up with))\b/i;
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
  /^(?:why|how so|what about(?: it| that)?|and then|then what|explain that simply|make that simpler|what does (?:this|that|it) mean(?: in practice)?|can you clarify that)\s*[?.!]*$/i;
const CONTEXTUAL_CONFIRMATION =
  /^(?:are you (?:sure|certain)(?: about (?:that|this))?|can you confirm(?: that)?|please confirm(?: that)?|confirm(?: that)?)\s*[?.!]*$/i;
const CONTEXTUAL_EDIT_FOLLOW_UP =
  /^(?:rewrite|rephrase|summari[sz]e|simplify|shorten|condense|remove|keep|retain|clean up|format)\b.{0,500}\b(?:your|my|the|that|this|above|previous|earlier)\s+(?:answer|response|report|findings|results|research|sources?)\b/i;
const ASSISTANT_CAPABILITY_QUESTION =
  /^(?:what (?:can(?:not|'t)?|cannot|can not) you (?:rese(?:a)?rch|search|browse|access|read)\d*(?:\s+on (?:the )?(?:web|internet))?|can (?:you|this agent) (?:generate|create|draw|make)\s+(?:an?\s+)?(?:pictures?|pics?|images?|artwork)\b(?:\s+.*)?)\s*[?.!]*$/i;
const CONTEXTUAL_RELATION_FOLLOW_UP =
  /\b(?:relate|related|connect|connection)\b.{0,100}\b(?:what you (?:just )?(?:researched|said|found)|previous (?:answer|research)|that topic)\b/i;

export function isIdentityQuestion(message: string): boolean {
  return IDENTITY_REQUEST.test(
    message.normalize("NFKC").replace(/[’‘]/g, "'").trim(),
  );
}

export function isCreatorQuestion(message: string): boolean {
  return CREATOR_REQUEST.test(
    message.normalize("NFKC").replace(/[’‘]/g, "'").trim(),
  );
}

export function isContextualConfirmation(message: string): boolean {
  return CONTEXTUAL_CONFIRMATION.test(message.trim());
}

export function shouldResearchMessage(
  message: string,
  hasConversationHistory = false,
  hasImageAttachment = false,
): boolean {
  const content = message.trim();
  const normalizedContent = content.normalize("NFKC").replace(/[’‘]/g, "'");
  if (
    !content ||
    isIdentityQuestion(content) ||
    LIGHTWEIGHT_MESSAGES.some((pattern) => pattern.test(content))
  ) {
    return false;
  }

  if (ASSISTANT_CAPABILITY_QUESTION.test(normalizedContent)) return false;
  if (EXPLICIT_RESEARCH_REQUEST.test(content)) return true;
  if (
    CURRENT_INFORMATION_MARKER.test(content) &&
    (INFORMATION_REQUEST.test(content) ||
      EXPLANATION_REQUEST.test(content) ||
      content.endsWith("?") ||
      DYNAMIC_LOOKUP_FRAGMENT.test(content) ||
      (DYNAMIC_LOOKUP_ACTION.test(content) && DYNAMIC_LOOKUP_SUBJECT.test(content)))
  ) {
    return true;
  }
  if (containsWebTarget(content)) return true;
  if (hasImageAttachment) return false;
  if (INSPECTION_REQUEST.test(content)) return true;
  if (
    SUBJECTIVE_CONVERSATION_REQUEST.test(normalizedContent) &&
    !CURRENT_INFORMATION_MARKER.test(content)
  ) {
    return false;
  }
  if (hasConversationHistory && CONTEXTUAL_RELATION_FOLLOW_UP.test(content)) return false;
  if (isContextualConfirmation(content)) return false;
  if (CONTEXTUAL_EDIT_FOLLOW_UP.test(content)) return false;
  if (CONTEXTUAL_FOLLOW_UP.test(content)) return false;
  if (EXPLANATION_REQUEST.test(content)) return true;
  if (INFORMATION_REQUEST.test(content)) return true;

  return hasConversationHistory && content.endsWith("?");
}
