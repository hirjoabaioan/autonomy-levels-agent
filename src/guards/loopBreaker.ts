export interface TimedText {
  body: string;
  ts: number;
}

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[\d\p{P}]+/gu, ' ').split(/\s+/).filter(Boolean));

/** Jaccard similarity over word sets; digits and punctuation are ignored so counters/timestamps don't hide a loop. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}

/**
 * Bot-to-bot signature: the last `k` inbound messages (current one last) are near-identical
 * and arrived seconds apart. Humans do not repeat themselves at that speed.
 */
export function looksLikeLoop(inbound: TimedText[], k: number, gapMs: number, minSimilarity: number): boolean {
  if (inbound.length < k) return false;
  const last = inbound.slice(-k);
  for (let i = 1; i < last.length; i++) {
    const prev = last[i - 1] as TimedText;
    const cur = last[i] as TimedText;
    if (cur.ts - prev.ts > gapMs || similarity(prev.body, cur.body) < minSimilarity) return false;
  }
  return true;
}
