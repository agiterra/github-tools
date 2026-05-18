/**
 * Filter expression generators for GitHub webhook events.
 *
 * Each function returns a JS expression string that runs in Wire's filter VM.
 * The VM provides: headers (object), payload (parsed GitHub event body).
 * The GitHub event type is in headers["x-github-event"].
 *
 * Compose filters with || for OR logic.
 */

/**
 * Match events for a specific PR number (check_run, pull_request, issue_comment, review).
 *
 * The check_run clause additionally requires `action === "completed"` —
 * GitHub fires a check_run event for *every* job state transition
 * (`created`, `completed`, sometimes `rerequested`). A PR with N check jobs
 * across M CI rebuilds produces ~2NM check_run events, of which only the
 * NM `completed` ones carry actionable result information. Dropping the
 * `created` half cuts agent context burn roughly in half for an active PR
 * with no information loss — engineers only care about the result, not
 * the start.
 *
 * Fixed 2026-05-18 after Eclair3 took 107 webhook events in one hour on
 * a single PR, ~30 of them check_run.created noise.
 */
export function prFilter(prNumber: number): string {
  return [
    `payload.pull_request?.number === ${prNumber}`,
    `payload.issue?.number === ${prNumber}`,
    `(payload.check_run?.pull_requests?.some(pr => pr.number === ${prNumber}) && payload.action === "completed")`,
  ].join(" || ");
}

/**
 * Match workflow_run events scoped to a specific PR's lifecycle.
 *
 * Two clauses OR'd together — one for pre-merge, one for post-merge:
 *
 * - Pre-merge: workflow_run.head_branch === the PR's head ref. Catches CI
 *   workflows triggered by pushes to the PR branch.
 *
 * - Post-merge: workflow_run.head_branch === the default branch AND
 *   head_commit.message includes "(#<N>)". GitHub's squash-merge and
 *   merge-commit styles both put "(#<PR-number>)" in the merge commit
 *   message, so this scopes default-branch workflow_runs to ONLY the ones
 *   triggered by THIS PR's merge — not other PRs landing in parallel.
 *
 *   If `deployWorkflowName` is provided, also require workflow_run.name to
 *   match it — useful when the engineer cares about a specific workflow
 *   like "Deploy to Staging" and wants to drop unrelated post-merge runs
 *   (CI re-runs on main, scheduled jobs, etc.).
 *
 * Known limitation: rebase-merge to the default branch fans out the
 * original commit messages without injecting "(#<N>)". Post-merge
 * workflows in that case won't match. Rebase-merge to default branches is
 * uncommon; document the gap rather than fight it.
 */
export function prScopedWorkflowRunFilter(opts: {
  prNumber: number;
  prHeadRef: string;
  defaultBranch: string;
  deployWorkflowName?: string;
}): string {
  const isWorkflowRun = `headers["x-github-event"] === "workflow_run"`;
  const preMerge = `payload.workflow_run?.head_branch === ${JSON.stringify(opts.prHeadRef)}`;
  const postMergeBranch = `payload.workflow_run?.head_branch === ${JSON.stringify(opts.defaultBranch)}`;
  const mergeCommitTag = `payload.workflow_run?.head_commit?.message?.includes("(#${opts.prNumber})")`;
  const deployName = opts.deployWorkflowName
    ? ` && payload.workflow_run?.name === ${JSON.stringify(opts.deployWorkflowName)}`
    : "";
  const postMerge = `(${postMergeBranch} && ${mergeCommitTag}${deployName})`;
  return `${isWorkflowRun} && (${preMerge} || ${postMerge})`;
}

/** Match workflow_run completions for a specific workflow name. */
export function workflowFilter(workflowName: string): string {
  return `headers["x-github-event"] === "workflow_run" && payload.workflow_run?.name === ${JSON.stringify(workflowName)} && payload.action === "completed"`;
}

/** Match push events to a specific branch. */
export function branchFilter(branch: string): string {
  return `payload.ref === "refs/heads/${branch}"`;
}

/** Match check_suite completions (CI results on any branch). */
export function checkSuiteFilter(): string {
  return `headers["x-github-event"] === "check_suite" && payload.action === "completed"`;
}

/** Match events from a specific bot user (e.g. CodeRabbit). */
export function botFilter(botLogin: string): string {
  return [
    `payload.comment?.user?.login === ${JSON.stringify(botLogin)}`,
    `payload.review?.user?.login === ${JSON.stringify(botLogin)}`,
  ].join(" || ");
}

/** Combine multiple filter expressions with OR. */
export function anyOf(...filters: string[]): string {
  return filters.map((f) => `(${f})`).join(" || ");
}
