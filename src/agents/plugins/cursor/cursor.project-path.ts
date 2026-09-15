/**
 * Best-effort project-path recovery for a Cursor conversation that has no `composerHeaders` row.
 *
 * `composerHeaders` names the project directly (`workspaceIdentifier.uri.fsPath`), so these
 * heuristics only run for the shrinking set of transcript-only sessions (schema drift, a pruned
 * header row) that have nothing better to go on — see `cursor.session.ts`'s module doc comment
 * and {@link resolveProjectPath} there.
 *
 * Both heuristics verify against the filesystem rather than reconstructing a path from the slug
 * string alone: Cursor's slug replaces `/` and `_` alike with `-`, so naive de-slugging is
 * ambiguous by construction (`Users-ada_lovelace-claude-code-router` could de-slug to a directory
 * nobody has). Walking the filesystem and matching each step's own slug against a real, existing
 * directory turns "plausible-looking" into "verified".
 */

import { readdirSync, statSync } from 'fs';
import { dirname, isAbsolute, join, sep } from 'path';
import { logger } from '@/utils/logger.js';

/** Trailing-separator-insensitive directory comparison. */
export function sameDir(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '');
}

/**
 * Best-effort project path for a Cursor project slug.
 *
 * The slug is lossy in two directions at once: Cursor replaces `/` and `_` alike with `-`, and
 * a directory name may contain `-` of its own. So a `-` in a slug can mean any of three things,
 * and splitting on it cannot work — `Users-ada_lovelace-claude-code-router` would de-slug to
 * `/Users/ada/lovelace/claude/code/router`, which is nobody's project. That naive reversal is
 * why nearly every session used to report no project at all.
 *
 * Instead of guessing at the string, this walks the filesystem and lets it decide: from the
 * root, only descend into a child whose own slug matches the next tokens of the slug being
 * resolved. Each step is verified against a directory that exists, so the result is Cursor's
 * own naming confirmed rather than a plausible-looking reconstruction — the same principle
 * {@link projectPathFromFiles} already applies to the tracking database's file paths. When no
 * branch consumes the whole slug the session stays silent about its project: an honest gap
 * still beats a wrong answer.
 */
export function projectPathFromSlug(slug: string, cache?: Map<string, string | undefined>): string | undefined {
  if (cache?.has(slug)) {
    return cache.get(slug);
  }
  const matches = descendMatchingSlug(sep, slug.split('-'));
  if (matches.length > 1) {
    logger.debug(`[cursor-discovery] slug ${slug} matches ${matches.length} directories — reporting no project`);
  }
  const resolved = matches.length === 1 ? matches[0] : undefined;
  cache?.set(slug, resolved);
  return resolved;
}

/**
 * Every existing directory reachable by consuming a slug whole, stopping at two.
 *
 * A child matches when its own name, slugified, equals the tokens it would have to account for.
 * Recursion (rather than a single greedy pass) is what makes `foo-bar/baz` and `foo/bar-baz`
 * both reachable from `foo-bar-baz`.
 *
 * More than one branch can succeed, because `/`, `_` and `-` all slugify to `-`: with both
 * `~/work/my_app` and `~/work/my-app` on disk, one slug describes them equally well. Collecting
 * a second match is how the caller learns to stay silent — attributing a session confidently to
 * the wrong project is worse than reporting none. Two is enough to know it is ambiguous, and
 * stopping there keeps the walk from exploring a tree it has already disqualified.
 *
 * Terminating: every step consumes at least one token, so depth is bounded by the token count
 * even if a symlink points back up the tree.
 */
function descendMatchingSlug(dir: string, tokens: string[], found: string[] = []): string[] {
  if (tokens.length === 0) {
    found.push(dir);
    return found;
  }
  for (const name of readDirNames(dir)) {
    if (found.length >= 2) {
      break;
    }
    const nameTokens = slugForPath(name).split('-');
    if (nameTokens.length > tokens.length) {
      continue;
    }
    if (!nameTokens.every((token, i) => token === tokens[i])) {
      continue;
    }
    descendMatchingSlug(join(dir, name), tokens.slice(nameTokens.length), found);
  }
  return found;
}

/** The slug Cursor would have written for a directory: leading separator dropped, `/` and `_` → `-`. */
function slugForPath(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\_]/g, '-');
}

/** Deepest directory that is an ancestor of (or equal to) both paths. */
function commonAncestor(a: string, b: string): string {
  const left = a.split(sep);
  const right = b.split(sep);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) {
    shared.push(left[i]);
  }
  return shared.join(sep) || sep;
}

/**
 * Project root for a conversation, recovered from the absolute paths the AI-tracking database
 * recorded for it.
 *
 * The slug alone cannot be reversed (see {@link projectPathFromSlug}), and the files' common
 * directory alone is not the project root either — a conversation that only touched `src/`
 * yields `<root>/src`. Combining the two settles it: walk up from the common directory until a
 * directory slugifies back to the slug Cursor filed the conversation under. That match is a
 * verification against Cursor's own naming, not a guess, so the answer is exact even for slugs
 * whose `-` came from a `_`. No match means we stay silent and let the caller fall back.
 */
export function projectPathFromFiles(slug: string, files: string[]): string | undefined {
  const absolute = files.filter((file) => isAbsolute(file));
  if (absolute.length === 0) {
    return undefined;
  }

  let dir = absolute.map(dirname).reduce(commonAncestor);
  for (;;) {
    if (slugForPath(dir) === slug) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Subdirectory names of `dir`, or an empty list when it cannot be read.
 *
 * Symlinked directories count. On macOS `/var` — the ancestor of every temporary directory, and
 * of plenty of real project trees — is a symlink, and `isDirectory()` is false for a symlink, so
 * filtering on it alone would make the slug walk give up at the first step.
 */
export function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))))
      .map((entry) => entry.name);
  } catch (error) {
    logger.debug(`[cursor-discovery] failed to read ${dir}:`, error);
    return [];
  }
}

/** Whether `path` is a directory, following symlinks. False when it cannot be stat'd. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
