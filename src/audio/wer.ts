/**
 * Word error rate between what was meant and what speech-to-text heard. Both sides are normalised the same way
 * first (lowercase, no punctuation, "example.com" read as "example dot com"), so only real mishearings count.
 */

export function werWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(?<=[a-z0-9])\.(?=[a-z0-9])/g, " dot ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** (substitutions + deletions + insertions) / reference words, by word-level edit distance. */
export function wordErrorRate(reference: string, hypothesis: string): { wer: number; errors: number; words: number } {
  const ref = werWords(reference);
  const hyp = werWords(hypothesis);
  const d = Array.from({ length: ref.length + 1 }, (_, i) => Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const sub = d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      d[i]![j] = Math.min(sub, d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    }
  }
  const errors = d[ref.length]![hyp.length]!;
  return { wer: ref.length ? errors / ref.length : hyp.length ? 1 : 0, errors, words: ref.length };
}
