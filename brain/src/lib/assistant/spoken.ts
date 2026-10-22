/**
 * Spoken-reply guard. The contract promises `spoken` is <= 2 sentences for watch TTS and
 * glasses audio. The model is asked for that, but we enforce it here regardless of what
 * the model returns: strip markdown/URLs/ids, then keep at most two sentences and a hard
 * character budget.
 */

export const MAX_SPOKEN_SENTENCES = 2;
export const MAX_SPOKEN_CHARS = 280;

const ABBREVIATIONS = [
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd", "co", "corp",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "e.g", "i.e", "a.m", "p.m", "approx", "no", "est",
];

/** Remove markdown and things that sound bad when read aloud. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(cmt|fu|drf|dec|evt|dev|evp)_[a-z0-9]+\b/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<![\w*])[*_](?!\s)([^*_\n]+?)[*_](?![\w*])/g, "$1")
    .replace(/[*_~#|]/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split into sentences without breaking on common abbreviations, decimals or initials. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+(?=\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const before = text.slice(start, m.index);
    const lastWord = (/([A-Za-z.]+)$/.exec(before)?.[1] ?? "").toLowerCase();
    const isAbbrev = m[0] === "." && (ABBREVIATIONS.includes(lastWord) || /^[a-z]$/i.test(lastWord));
    if (isAbbrev && end < text.length) continue;
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export function countSentences(text: string): number {
  return splitSentences(stripForSpeech(text)).length;
}

/**
 * Produce a compliant spoken line. Prefers the model's `spoken`; falls back to the first
 * sentences of `reply`; never returns empty.
 */
export function enforceSpoken(spoken: string | undefined | null, reply?: string): string {
  const source = stripForSpeech(spoken ?? "") || stripForSpeech(reply ?? "");
  if (!source) return "Done.";
  let sentences = splitSentences(source).slice(0, MAX_SPOKEN_SENTENCES);
  let text = sentences.join(" ");
  if (text.length > MAX_SPOKEN_CHARS) {
    sentences = sentences.slice(0, 1);
    text = sentences.join(" ");
  }
  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.slice(0, MAX_SPOKEN_CHARS - 1);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${(lastSpace > MAX_SPOKEN_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s-]+$/, "")}…`;
  }
  return text;
}
