/**
 * GitHub commit-status helpers.
 *
 * Wraps the Commit Status API:
 *   https://docs.github.com/en/rest/commits/statuses
 *
 * Primary use case: the `brioche/gates` deterministic merge gate (Brioche
 * 2026-05-28). Branch protection requires `brioche/gates` to pass; only
 * Brioche flips it to success after auditing the two skip-prone gates
 * (adversarial 10-review + local-services verification). On PR
 * synchronize, the gate auto-resets to pending.
 */

export type CommitStatusState = "pending" | "success" | "failure" | "error";

export interface SetCommitStatusOptions {
  /** GitHub token with `statuses:write` (or `repo` scope on classic PATs). */
  githubToken: string;
  /** Repository in `owner/repo` format. */
  repo: string;
  /** Commit SHA to attach the status to. */
  sha: string;
  /** Status state. */
  state: CommitStatusState;
  /**
   * Status context — the unique key shown in the PR's check list, e.g.
   * `brioche/gates`. Branch protection rules require by context name.
   */
  context: string;
  /** Short human-readable summary (≤140 chars). */
  description?: string;
  /** Optional URL for "Details" link on the PR check. */
  target_url?: string;
}

export interface CommitStatusResult {
  /** GitHub status row id. */
  id: number;
  /** Permalink to the status entry on GitHub. */
  url: string;
  /** The state we set. */
  state: CommitStatusState;
  /** The context we wrote. */
  context: string;
}

export async function setCommitStatus(opts: SetCommitStatusOptions): Promise<CommitStatusResult> {
  const body = JSON.stringify({
    state: opts.state,
    context: opts.context,
    ...(opts.description ? { description: opts.description.slice(0, 140) } : {}),
    ...(opts.target_url ? { target_url: opts.target_url } : {}),
  });
  const res = await fetch(`https://api.github.com/repos/${opts.repo}/statuses/${opts.sha}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setCommitStatus failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id: number; url: string; state: CommitStatusState; context: string };
  return { id: data.id, url: data.url, state: data.state, context: data.context };
}

export interface GetPrHeadShaOptions {
  githubToken: string;
  repo: string;
  prNumber: number;
}

/**
 * Look up a PR's head commit SHA. Required input to setCommitStatus when
 * the caller only knows the PR number.
 */
export async function getPrHeadSha(opts: GetPrHeadShaOptions): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${opts.repo}/pulls/${opts.prNumber}`, {
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getPrHeadSha failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { head: { sha: string } };
  if (!data.head?.sha) throw new Error(`no head.sha on PR ${opts.repo}#${opts.prNumber}`);
  return data.head.sha;
}

/** Brioche-gate context. Hard-coded so callers can't accidentally vary it. */
export const BRIOCHE_GATES_CONTEXT = "brioche/gates";

export interface SetBriocheGateOptions {
  githubToken: string;
  repo: string;
  prNumber: number;
  state: CommitStatusState;
  description?: string;
  target_url?: string;
}

/**
 * Convenience: resolves the PR head SHA and writes a `brioche/gates`
 * commit-status. Use when you have a PR number, not a raw SHA.
 */
export async function setBriocheGate(opts: SetBriocheGateOptions): Promise<CommitStatusResult & { sha: string }> {
  const sha = await getPrHeadSha({
    githubToken: opts.githubToken,
    repo: opts.repo,
    prNumber: opts.prNumber,
  });
  const result = await setCommitStatus({
    githubToken: opts.githubToken,
    repo: opts.repo,
    sha,
    state: opts.state,
    context: BRIOCHE_GATES_CONTEXT,
    description: opts.description,
    target_url: opts.target_url,
  });
  return { ...result, sha };
}
