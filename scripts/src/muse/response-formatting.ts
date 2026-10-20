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

export function requestsSources(text: string): boolean {
  return /\b(?:show|give|list|include|provide|send|cite|attach|add)\b[^.!?\n]{0,50}\b(?:sourced|sources?|citations?|references?|bibliography|works cited)\b/i.test(text) ||
    /\bwhat\s+(?:are\s+)?(?:the\s+)?(?:sources?|citations?|references?)\b/i.test(text) ||
    /\b(?:where are|what were)\s+(?:(?:the|your)\s+)?(?:sources?|citations?|references?)\b/i.test(text) ||
    /\b(?:with|using)\s+(?:the\s+)?(?:sources?|citations?|references?)\b/i.test(text) ||
    /\bwhere did you get (?:that|this|the information)\b/i.test(text);
}

function splitMarkdownTableRow(line: string): string[] | undefined {
  const value = line.trim();
  if (!value.startsWith("|") || !value.endsWith("|")) return undefined;

  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  let escaped = false;
  for (let position = 1; position < value.length - 1; position += 1) {
    const character = value[position] ?? "";
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "`") {
      inCode = !inCode;
      cell += character;
    } else if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return Boolean(
    cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
}

function formatMarkdownTablesAsBullets(lines: string[]): string[] {
  const formatted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headerRow = splitMarkdownTableRow(lines[index] ?? "");
    if (!headerRow || !isMarkdownTableSeparator(lines[index + 1] ?? "")) {
      formatted.push(lines[index] ?? "");
      continue;
    }

    const headers = headerRow.filter(Boolean);
    index += 2;
    while (index < lines.length) {
      const row = splitMarkdownTableRow(lines[index] ?? "");
      if (!row || isMarkdownTableSeparator(lines[index] ?? "")) break;

      const values = row.filter(Boolean);
      const fields = values
        .map((value, cellIndex) => {
          const header = headers[cellIndex];
          return header ? `**${header}:** ${value}` : value;
        })
        .filter(Boolean);
      if (fields.length) formatted.push(`- ${fields.join("; ")}`);
      index += 1;
    }
    index -= 1;
  }
  return formatted;
}

export type ResponseSourceLink = {
  title: string;
  url: string;
};

export type ResponseFormattingOptions = {
  preserveSourceUrls?: boolean;
  preserveEmoji?: boolean;
};

export function requestsEmoji(text: string): boolean {
  const action =
    String.raw`(?:use|include|add|send|reply|respond|answer|write|explain|tell|describe|decorate|sprinkle|put|show)`;
  return new RegExp(
    String.raw`^(?:please\s+)?${action}\b[^.!?\n]{0,60}(?:\bemoji(?:s)?\b|\p{Extended_Pictographic})|` +
    String.raw`\b(?:can|could|would)\s+you\s+(?:please\s+)?${action}\b[^.!?\n]{0,60}\bemoji(?:s)?\b|` +
    String.raw`\b(?:I want|I'd like)\s+(?:you to\s+)?${action}\b[^.!?\n]{0,60}\bemoji(?:s)?\b|` +
    String.raw`^(?:some\s+)?emoji(?:s)?\s+please[?.!]*$`,
    "iu",
  ).test(text.trim());
}

const IMAGE_TERMS = String.raw`(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)`;

export function requestsImages(text: string): boolean {
  const negativeRequest = new RegExp(
    String.raw`\b(?:don't|do not|never|without|no)\b[^.!?\n]{0,30}\b${IMAGE_TERMS}\b`,
    "i",
  );
  const generationNegation = new RegExp(
    String.raw`\b(?:don't|do not|never|no need to|not necessary to)\b[^.!?\n]{0,40}\b(?:generate|create|draw|make|produce)\b[^.!?\n]{0,40}\b${IMAGE_TERMS}\b`,
    "i",
  );
  if (negativeRequest.test(text) && !generationNegation.test(text)) return false;

  const requestPattern = new RegExp(
    [
      String.raw`\b(?:show|find|include|add|attach|use|source|retrieve|send|provide|fetch|search for|look for|see|view|display|illustrate|back up|support)\b[^.!?\n]{0,80}\b${IMAGE_TERMS}\b`,
      String.raw`\b(?:I want|I'd like|I'd love|can I|could I)\b[^.!?\n]{0,50}\b${IMAGE_TERMS}\b`,
      String.raw`\bwith\b[^.!?\n]{0,48}\b${IMAGE_TERMS}\b(?!\s+(?:processing|editing|recognition|generation|analysis|compression|metadata|formats?|files?|uploads?|attachments?)\b)`,
      String.raw`\b(?:online|existing|sourced|available)\b[^.!?\n]{0,40}\b${IMAGE_TERMS}\b`,
      String.raw`\b${IMAGE_TERMS}\b[^.!?\n]{0,80}\b(?:attached|sourced|available|retrieved|found)\b[^.!?\n]{0,40}\b(?:online|on the web|from the web)\b`,
      String.raw`\b${IMAGE_TERMS}\b[^.!?\n]{0,60}\b(?:please|to support|to back up|for my research)\b`,
    ].join("|"),
    "i",
  );
  return requestPattern.test(text);
}

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

  const lines = formatMarkdownTablesAsBullets(normalized.split("\n"));
  normalized = lines
    .map((line, index) => {
      if (/^\s{0,3}>/.test(line)) return line;
      const formattedLine = line
        .replace(
          /^\s*- /.test(line) ? /<br\s*\/?>/gi : /$^/,
          /^\s*- /.test(line) ? " " : "",
        )
        .replace(/\\n/g, "\n")
        .replace(/;\./g, ".")
        .replace(/\.;/g, ".")
        .replace(/“([^”\n]*)"/g, "“$1”")
        .replace(/‘([^’\n]*)'/g, "‘$1’")
        .replace(/“([^”\n]*)’/g, "“$1”")
        .replace(/‘([^’\n]*)”/g, "‘$1’");
      const emojiNormalized = options.preserveEmoji
        ? formattedLine
        : formattedLine.replace(EMOJI, "");
      return emojiNormalized
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
