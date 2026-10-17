const PROTECTED_SPANS = [
  /```[\s\S]*?```|~~~[\s\S]*?~~~/g,
  /(`+)[\s\S]*?\1/g,
  /\[[^\]]+\]\((?:<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g,
  /https?:\/\/[^\s<>)\]]+/gi,
  /\[(?:SRC-[A-Za-z0-9_-]+|\d+)\]/g,
  /(?<![\p{L}\p{N}_])"(?:\\.|[^"\\\n])*"(?![\p{L}\p{N}_])|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}_])'(?:\\.|[^'\\\n])*'(?![\p{L}\p{N}_])/gu,
];

const EMOJI =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|(?:\p{Regional_Indicator}{2})/gu;

export function normalizeResponseFormatting(response: string): string {
  const protectedSpans: string[] = [];
  let normalized = response;

  for (const pattern of PROTECTED_SPANS) {
    normalized = normalized.replace(pattern, (span) => {
      const marker = `\uE000${protectedSpans.length}\uE001`;
      protectedSpans.push(span);
      return marker;
    });
  }

  normalized = normalized
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}>/.test(line)) return line;
      return line
        .replace(/\\n/g, "\n")
        .replace(/;\./g, ".")
        .replace(/\.;/g, ".")
        .replace(/“([^”\n]*)"/g, "“$1”")
        .replace(/‘([^’\n]*)'/g, "‘$1’")
        .replace(/“([^”\n]*)’/g, "“$1”")
        .replace(/‘([^’\n]*)”/g, "‘$1’")
        .replace(EMOJI, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;!?])/g, "$1")
        .trimEnd();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) =>
    protectedSpans[Number(index)] ?? _marker
  );
}
