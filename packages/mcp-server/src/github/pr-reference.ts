export interface PrReference { owner?: string; repo?: string; number: number }

export function validRepoOwner(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value);
}

export function validRepoName(value: string): boolean {
  return /^(?!\.{1,2}$)[a-z0-9_.-]+$/i.test(value);
}

/** Parse the whole reference, never a github.com substring in an unrelated URL.
 * Keep the throw-free identity parser shared by posting and authorization. */
export function parsePrReference(ref: string): PrReference | null {
  const value = ref.trim();
  const bare = /^#?(\d+)$/.exec(value);
  if (bare) {
    const number = Number(bare[1]);
    return Number.isSafeInteger(number) && number > 0 ? { number } : null;
  }
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?(?:[?#][^\s]*)?$/i.exec(value);
  if (!match) return null;
  const [, owner, repo, digits] = match;
  const number = Number(digits);
  if (!owner || !repo || !validRepoOwner(owner) || !validRepoName(repo) ||
      !Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number };
}
