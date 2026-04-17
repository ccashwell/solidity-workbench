/**
 * Trigram index for workspace-symbol search.
 *
 * Gives sub-linear pruning on large workspaces where the previous
 * linear `symbolsByName.includes` scan becomes the bottleneck. The
 * core data structure is a map from trigram → set of symbol names
 * that contain it; looking up a query means intersecting the posting
 * lists of the query's own trigrams, which in the common case
 * examines a tiny fraction of the workspace.
 *
 * Fuzzy matching (ordered subsequence, e.g. `tkTr` → `tokenTransfer`)
 * is handled by the caller via {@link scoreName}; the trigram index
 * returns a candidate set only, so callers still apply an explicit
 * substring / fuzzy filter and rank.
 */
export class TrigramIndex {
  /** Set of all indexed names, used for short-query fallback. */
  private readonly names = new Set<string>();

  /** Lowercase trigram → set of names whose lowercase form contains it. */
  private readonly postings = new Map<string, Set<string>>();

  /** True when no names have been indexed. */
  get isEmpty(): boolean {
    return this.names.size === 0;
  }

  /**
   * Record a name as present in the index. Idempotent — indexing the
   * same name twice is a no-op so the posting lists don't inflate.
   */
  add(name: string): void {
    if (!name || this.names.has(name)) return;
    this.names.add(name);
    const lower = name.toLowerCase();
    for (const tg of uniqueTrigrams(lower)) {
      let bucket = this.postings.get(tg);
      if (!bucket) {
        bucket = new Set();
        this.postings.set(tg, bucket);
      }
      bucket.add(name);
    }
  }

  /**
   * Remove a name from the index. Safe to call for names that were
   * never added.
   */
  remove(name: string): void {
    if (!this.names.delete(name)) return;
    const lower = name.toLowerCase();
    for (const tg of uniqueTrigrams(lower)) {
      const bucket = this.postings.get(tg);
      if (!bucket) continue;
      bucket.delete(name);
      if (bucket.size === 0) this.postings.delete(tg);
    }
  }

  clear(): void {
    this.names.clear();
    this.postings.clear();
  }

  /**
   * Return the candidate names that could match `query`. The candidate
   * set is guaranteed to be a superset of any name that:
   *   - contains `query` as a substring (for queries of length ≥ 3), or
   *   - contains `query.toLowerCase()` via any trigram overlap.
   *
   * For short queries (< 3 chars) all indexed names are returned — the
   * caller does the filtering. This is correct and still O(names)
   * but acceptable: short queries match so many things that trigram
   * pruning provides no real benefit.
   *
   * When a query trigram has no posting list at all, we return
   * `[]` immediately — no name can possibly contain the query.
   */
  candidates(query: string): string[] {
    const q = query.toLowerCase();
    if (q.length === 0) return Array.from(this.names);
    if (q.length < 3) {
      const out: string[] = [];
      for (const n of this.names) {
        if (n.toLowerCase().includes(q)) out.push(n);
      }
      return out;
    }

    const grams = uniqueTrigrams(q);
    if (grams.length === 0) return [];

    const lists: Set<string>[] = [];
    for (const tg of grams) {
      const bucket = this.postings.get(tg);
      if (!bucket) return []; // any missing trigram ⇒ no substring match
      lists.push(bucket);
    }

    // Walk the smallest list first and intersect into it.
    lists.sort((a, b) => a.size - b.size);
    const smallest = lists[0];
    const rest = lists.slice(1);
    const out: string[] = [];
    outer: for (const name of smallest) {
      for (const other of rest) {
        if (!other.has(name)) continue outer;
      }
      out.push(name);
    }
    return out;
  }

  /**
   * Number of distinct names currently indexed. Exposed for tests and
   * diagnostics; production code should not rely on the count for
   * correctness.
   */
  get size(): number {
    return this.names.size;
  }
}

/**
 * Extract the unique lowercase 3-grams from a string. Returns `[]`
 * when the input is shorter than 3 chars. Using a set-de-duplication
 * avoids inflating posting lists for names with repeated patterns
 * like `aaaa`.
 */
function uniqueTrigrams(s: string): string[] {
  if (s.length < 3) return [];
  const set = new Set<string>();
  const end = s.length - 3;
  for (let i = 0; i <= end; i++) set.add(s.slice(i, i + 3));
  return Array.from(set);
}

/**
 * Score a candidate `name` against a query for workspace-symbol
 * ranking. Returns `0` when the candidate does not match at all, and
 * a positive number otherwise — higher is better.
 *
 * Match tiers (descending priority):
 *   1. Exact (case-insensitive) match.
 *   2. Prefix match.
 *   3. Substring match.
 *   4. Ordered-subsequence ("fuzzy") match — e.g. `tkTr`
 *      matches `tokenTransfer`.
 *
 * Shorter names score higher within a tier because they are more
 * specific to the query.
 */
export function scoreName(name: string, query: string): number {
  if (!query) return 1; // empty query → everything passes
  const n = name.toLowerCase();
  const q = query.toLowerCase();

  if (n === q) return 10_000;
  if (n.startsWith(q)) return 5_000 - name.length;
  if (n.includes(q)) return 3_000 - name.length;
  if (isOrderedSubsequence(n, q)) return 1_000 - name.length;
  return 0;
}

/**
 * True when every character of `query` appears in `name` in order
 * (skipping any number of characters in `name` between matches).
 * Case-sensitive; callers lowercase both sides before invoking.
 */
function isOrderedSubsequence(name: string, query: string): boolean {
  let ni = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const target = query[qi];
    while (ni < name.length && name[ni] !== target) ni++;
    if (ni >= name.length) return false;
    ni++;
  }
  return true;
}
