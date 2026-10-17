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
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

export type ResponseSourceLink = {
  title: string;
  url: string;
};

export type ResponseFormattingOptions = {
  preserveSourceUrls?: boolean;
};

export function normalizeResponseFormatting(
  response: string,
  sourceLinks: readonly ResponseSourceLink[] = [],
  options: ResponseFormattingOptions = {},
): string {
  const protectedSpans: string[] = [];
  let normalized = response;

  for (const pattern of PROTECTED_SPANS) {
    normalized = normalized.replace(pattern, (span) => {
      const marker = `\uE000${protectedSpans.length}\uE001`;
      protectedSpans.push(span);
      return marker;
    });
  }

  const lines = normalized.split("\n");
  const tableLines = new Set<number>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      !/^\s*\|.*\|\s*$/.test(lines[index] ?? "") ||
      !TABLE_SEPARATOR.test(lines[index + 1] ?? "")
    ) continue;
    tableLines.add(index);
    tableLines.add(index + 1);
    for (let row = index + 2; /^\s*\|.*\|\s*$/.test(lines[row] ?? ""); row += 1) {
      tableLines.add(row);
    }
  }

  normalized = normalized
    .split("\n")
    .map((line, index) => {
      if (/^\s{0,3}>/.test(line)) return line;
      return line
        .replace(
          tableLines.has(index) ? /<br\s*\/?>/gi : /$^/,
          tableLines.has(index) ? " " : "",
        )
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

  normalized = normalized.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) =>
    protectedSpans[Number(index)] ?? _marker
  );
  if (options.preserveSourceUrls) return normalized;

  const linkProtectedSpans: string[] = [];
  let sourceText = normalized;
  for (const pattern of PROTECTED_SPANS.filter((_pattern, index) => index !== 3)) {
    sourceText = sourceText.replace(pattern, (span) => {
      const marker = `\uE000${linkProtectedSpans.length}\uE001`;
      linkProtectedSpans.push(span);
      return marker;
    });
  }
  sourceText = sourceText.replace(
    /https?:\/\/[^\s<>)\]]+/gi,
    (rawUrl, offset: number, text: string) => {
      if (text.slice(0, offset).endsWith("](")) return rawUrl;
      const trailingPunctuation = rawUrl.match(/[.,!?;:]+$/)?.[0] ?? "";
      const url = rawUrl.slice(0, rawUrl.length - trailingPunctuation.length);
      const source = sourceLinks.find((item) => item.url === url);
      return source
        ? `[${source.title}](${source.url})${trailingPunctuation}`
        : rawUrl;
    },
  );
  return sourceText.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) =>
    linkProtectedSpans[Number(index)] ?? _marker
  );
}
