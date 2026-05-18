/**
 * PR rebase-needed detection.
 *
 * Reads GitHub's `mergeable_state` field — the same signal that drives the
 * "This branch has conflicts that must be resolved" banner on github.com.
 * GitHub computes this lazily; first read after a base-branch push often
 * returns `null` ("computing"). We retry with backoff up to a cap.
 *
 * Closes agiterra/github-tools#6: PR engineers should know when a rebase
 * is needed instead of waiting for Tim to flag it.
 *
 * Pure function. All config via params. No env reads, no Wire calls.
 */

/** Possible mergeable_state values from GitHub. See:
 *  https://docs.github.com/en/graphql/reference/enums#mergestatestatus
 */
export type MergeableState =
  | "clean"      // no conflicts, can merge
  | "dirty"      // base-branch conflicts — REBASE NEEDED
  | "blocked"    // required checks failing or review pending
  | "behind"     // base moved but no conflict yet (rebase recommended)
  | "unstable"   // passing required checks, optional ones failing
  | "draft"      // PR is in draft
  | "has_hooks"  // pending status hooks
  | "unknown";   // GitHub still computing

export type RebaseCheckResult = {
  /** Final mergeable_state we observed (or 'unknown' if we never got a definitive answer) */
  state: MergeableState;
  /** True only when state === 'dirty' — actionable "engineer, rebase me" signal */
  needs_rebase: boolean;
  /** Human-readable summary for the IPC alert body */
  message: string;
  /** Number of attempts we made before settling */
  attempts: number;
  /** PR URL for convenience in the alert */
  pr_url: string;
};

export type CheckRebaseOptions = {
  repo: string;                 // "owner/repo"
  prNumber: number;
  githubToken: string;
  /** Override the retry schedule (ms between attempts) — useful for tests. */
  backoffMs?: number[];
};

/** Default retry schedule for GitHub's lazy mergeable_state computation. */
const DEFAULT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Fetch a PR's mergeable_state, retrying with backoff when GitHub returns
 * null (still computing). Returns a structured result the caller can route
 * on (needs_rebase boolean, human-readable message).
 *
 * Bails out early as soon as we see a non-null state — no extra polls.
 */
export async function checkPrRebaseState(opts: CheckRebaseOptions): Promise<RebaseCheckResult> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const url = `https://api.github.com/repos/${opts.repo}/pulls/${opts.prNumber}`;
  const headers = {
    Authorization: `Bearer ${opts.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "wire-github-tools",
  };

  let attempts = 0;
  let lastState: MergeableState = "unknown";
  let prUrl = "";

  for (let i = 0; i <= backoff.length; i++) {
    attempts++;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`fetch PR ${opts.repo}#${opts.prNumber} failed (${res.status}): ${await res.text()}`);
    }
    const pr = (await res.json()) as {
      html_url?: string;
      mergeable_state?: string | null;
    };
    prUrl = pr.html_url ?? `https://github.com/${opts.repo}/pull/${opts.prNumber}`;
    const state = (pr.mergeable_state ?? "unknown") as MergeableState;
    lastState = state;

    // Definitive answer — stop polling
    if (state !== "unknown") break;

    // No more retries left
    if (i >= backoff.length) break;

    await new Promise((r) => setTimeout(r, backoff[i]));
  }

  const needs_rebase = lastState === "dirty";
  const message = formatMessage(lastState, opts.repo, opts.prNumber, prUrl);
  return { state: lastState, needs_rebase, message, attempts, pr_url: prUrl };
}

function formatMessage(state: MergeableState, repo: string, prNumber: number, prUrl: string): string {
  switch (state) {
    case "dirty":
      return `🚧 Rebase needed: ${repo}#${prNumber} has base-branch conflicts. Resolve at ${prUrl}`;
    case "behind":
      return `${repo}#${prNumber} is behind base. Rebase recommended (no conflicts yet). ${prUrl}`;
    case "clean":
      return `${repo}#${prNumber} is clean. ${prUrl}`;
    case "blocked":
      return `${repo}#${prNumber} is blocked (required checks failing or review pending). ${prUrl}`;
    case "unstable":
      return `${repo}#${prNumber} has failing optional checks. ${prUrl}`;
    case "draft":
      return `${repo}#${prNumber} is in draft. ${prUrl}`;
    case "has_hooks":
      return `${repo}#${prNumber} is pending status hooks. ${prUrl}`;
    case "unknown":
    default:
      return `${repo}#${prNumber} mergeable state still computing — try again shortly. ${prUrl}`;
  }
}
