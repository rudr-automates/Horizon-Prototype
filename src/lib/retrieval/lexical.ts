/**
 * Simple, dependency-free lexical helpers.
 *
 * These are used by the in-memory demo store and by the coarse backend
 * diagnostic. The Supabase store uses PostgreSQL full-text search instead.
 */

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","what","which",
  "who","whom","whose","why","how","when","where","does","do","did","doing",
  "of","to","in","on","at","by","for","with","about","into","from","than",
  "then","and","or","but","if","not","no","it","its","this","that","these",
  "those","i","we","you","they","he","she","our","your","their","as","so",
  "can","could","should","would","will","shall","may","might","must","have",
  "has","had","there","here","also","very","just","only",
]);

const TOKEN_RE = /[a-z0-9]+(?:\.[0-9]+)?/gi;

export function tokenize(text: string): string[] {
  const matches = text.match(TOKEN_RE);
  if (!matches) return [];
  return matches
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))];
}

/**
 * Score a block against query terms. Returns 0 when nothing matches, so
 * callers can exclude non-matches rather than ranking them.
 */
export function lexicalScore(blockText: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of tokenize(blockText)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let score = 0;
  for (const term of terms) {
    const count = counts.get(term) ?? 0;
    if (count > 0) score += 1 + Math.log(1 + count);
  }
  return score;
}
