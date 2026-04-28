/**
 * Filter expression generators for GitHub webhook events.
 *
 * Each function returns a JS expression string that runs in Wire's filter VM.
 * The VM provides: headers (object), payload (parsed GitHub event body).
 * The GitHub event type is in headers["x-github-event"].
 *
 * Compose filters with || for OR logic.
 */

/** Match events for a specific PR number (check_run, pull_request, issue_comment, review). */
export function prFilter(prNumber: number): string {
  return [
    `payload.pull_request?.number === ${prNumber}`,
    `payload.issue?.number === ${prNumber}`,
    `payload.check_run?.pull_requests?.some(pr => pr.number === ${prNumber})`,
  ].join(" || ");
}

/**
 * Match workflow_run events on the repo's default branch.
 *
 * Used by `registerPrWebhook` to catch post-merge deploy workflows. After a
 * squash-merge to main, GitHub Actions emits workflow_run events whose
 * payload has no `pull_request`/`issue`/`check_run.pull_requests` linkage —
 * `prFilter` alone drops them. With this added, the engineer who registered
 * the PR webhook still sees their merge's Deploy-to-Staging completion.
 *
 * Cost: events from OTHER PRs' post-merge workflows on the same repo also
 * pass during the engineer's session. Acceptable; missing the deploy event
 * is a silent failure that bites every engineer.
 */
export function defaultBranchWorkflowRunFilter(defaultBranch: string): string {
  return `headers["x-github-event"] === "workflow_run" && payload.workflow_run?.head_branch === ${JSON.stringify(defaultBranch)}`;
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
