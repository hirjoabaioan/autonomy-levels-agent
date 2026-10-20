const strip = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const HANDOFF = /\b(?:human|operator|agent|om|persoana|real person|(?:speak|talk) to (?:a |some)?(?:one|person)|vorb(?:i|esc) cu cineva)\b/;

/** Keyword and phrase match (EN + RO). Deliberately not an LLM call. */
export function wantsHuman(text: string): boolean {
  return HANDOFF.test(strip(text));
}
