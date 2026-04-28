/**
 * GitHub webhook lifecycle — register, and helpers.
 *
 * Pure functions. All config via params. No env reads.
 * Creates the GitHub-side webhook and returns the Wire registration payload.
 * The caller is responsible for Wire auth and sending the request.
 */

import { prFilter, prScopedWorkflowRunFilter } from "./filters.js";

/** Fetch the repo's default branch + the PR's head ref via GitHub REST. */
async function fetchPrContext(
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ defaultBranch: string; prHeadRef: string }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "wire-github-tools",
  };
  const [repoRes, prRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}`, { headers }),
    fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers }),
  ]);
  if (!repoRes.ok) {
    throw new Error(`fetch repo ${repo} failed (${repoRes.status}): ${await repoRes.text()}`);
  }
  if (!prRes.ok) {
    throw new Error(`fetch PR ${repo}#${prNumber} failed (${prRes.status}): ${await prRes.text()}`);
  }
  const repoData = (await repoRes.json()) as { default_branch?: string };
  const prData = (await prRes.json()) as { head?: { ref?: string } };
  if (!repoData.default_branch) {
    throw new Error(`repo ${repo} response missing default_branch`);
  }
  if (!prData.head?.ref) {
    throw new Error(`PR ${repo}#${prNumber} response missing head.ref`);
  }
  return { defaultBranch: repoData.default_branch, prHeadRef: prData.head.ref };
}

export type RepoWebhookOptions = {
  githubToken: string;
  /** Repository in owner/repo format */
  repo: string;
  /** Webhook name (used in Wire URL path) */
  name: string;
  /** The externally-reachable Wire webhook URL */
  webhookUrl: string;
  /** GitHub webhook events to subscribe to */
  events: string[];
  /** Filter JS expression. If omitted, all events are delivered. */
  filter?: string;
};

export type PrWebhookOptions = {
  githubToken: string;
  repo: string;
  /** The externally-reachable Wire base URL (e.g. ngrok URL) */
  wireExternalUrl: string;
  /** Wire agent ID (for URL path) */
  agentId: string;
  prNumber: number;
  /** Webhook name. Defaults to "{repo-name}-pr-{prNumber}" */
  name?: string;
  /** Extra events beyond the PR default set */
  extraEvents?: string[];
  /** Extra filter expressions OR'd with the PR filter */
  extraFilters?: string[];
  /**
   * Optional deploy workflow name (e.g. "Deploy to Staging"). When set, the
   * post-merge workflow_run filter additionally requires
   * workflow_run.name === this value, scoping default-branch matches to
   * only the engineer's deploy event. When omitted, ALL post-merge
   * workflow_runs whose head_commit.message contains "(#<prNumber>)" pass.
   */
  deployWorkflowName?: string;
};

const DEFAULT_PR_EVENTS = [
  "check_run",
  "check_suite",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "workflow_run",
];

/**
 * HMAC-SHA256 validator JS for GitHub webhooks.
 * Runs in Wire's VM sandbox.
 */
function hmacValidatorCode(): string {
  return `
const sig = headers["x-hub-signature-256"];
if (!sig) return false;
const mac = crypto.createHmac("sha256", secrets.webhook_secret);
const digest = await mac.update(body).digest("hex");
if (sig !== "sha256=" + digest) return false;
return { source: "github" };
`.trim();
}

/**
 * Cleanup JS that deletes the GitHub webhook.
 * Runs in Wire's cleanup VM with access to meta, secrets, fetch.
 */
function cleanupCode(): string {
  return `
if (meta.github_hook_id && meta.repo) {
  await fetch(
    "https://api.github.com/repos/" + meta.repo + "/hooks/" + meta.github_hook_id,
    {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + secrets.github_token,
        "User-Agent": "wire-github-tools",
      },
    }
  );
}
`.trim();
}

export type WebhookRegistration = {
  /** The Wire webhook registration body — caller signs and POSTs to Wire */
  wireBody: Record<string, unknown>;
  /** GitHub hook ID (for reference) */
  githubHookId: number;
  /** Webhook name */
  name: string;
};

/**
 * Create a GitHub webhook and return the Wire registration payload.
 *
 * 1. Creates the webhook on GitHub via API
 * 2. Returns the Wire registration body — caller is responsible for
 *    signing (JWT) and POSTing to Wire's webhook registration endpoint.
 */
export async function registerRepoWebhook(opts: RepoWebhookOptions): Promise<WebhookRegistration> {
  const webhookSecret = crypto.randomUUID();

  // Create GitHub webhook
  const ghRes = await fetch(`https://api.github.com/repos/${opts.repo}/hooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "wire-github-tools",
    },
    body: JSON.stringify({
      config: {
        url: opts.webhookUrl,
        content_type: "json",
        secret: webhookSecret,
      },
      events: opts.events,
      active: true,
    }),
  });

  if (!ghRes.ok) {
    const detail = await ghRes.text();
    throw new Error(`GitHub webhook creation failed (${ghRes.status}): ${detail}`);
  }

  const ghHook = (await ghRes.json()) as { id: number };

  return {
    wireBody: {
      plugin: "github",
      name: opts.name,
      validator: hmacValidatorCode(),
      filter: opts.filter ?? undefined,
      cleanup: cleanupCode(),
      dedup: 'headers["x-github-delivery"]',
      meta: {
        repo: opts.repo,
        github_hook_id: ghHook.id,
      },
      secrets: {
        webhook_secret: webhookSecret,
        github_token: opts.githubToken,
      },
    },
    githubHookId: ghHook.id,
    name: opts.name,
  };
}

/**
 * Create a GitHub webhook for PR monitoring.
 * Convenience wrapper over registerRepoWebhook with PR-specific defaults.
 */
export async function registerPrWebhook(opts: PrWebhookOptions): Promise<WebhookRegistration> {
  const repoName = opts.repo.split("/").pop() ?? opts.repo;
  const name = opts.name ?? `${repoName}-pr-${opts.prNumber}`;
  const events = [...DEFAULT_PR_EVENTS, ...(opts.extraEvents ?? [])];

  // Scope post-merge workflow_run capture to THIS PR's lifecycle:
  //   - pre-merge: workflow_runs on the PR's head_ref
  //   - post-merge: workflow_runs on default_branch whose head_commit
  //     message contains "(#<prNumber>)" (squash and merge-commit
  //     conventions both inject this), optionally narrowed further by
  //     workflow_run.name when deployWorkflowName is provided.
  // Without these clauses, prFilter() drops events that have no PR
  // linkage in payload — the silent-blind-through-deploy gap reported by
  // Profiterole on ENG-3024 PR #1500 (2026-04-28).
  const { defaultBranch, prHeadRef } = await fetchPrContext(
    opts.repo,
    opts.prNumber,
    opts.githubToken,
  );

  const filters = [
    prFilter(opts.prNumber),
    prScopedWorkflowRunFilter({
      prNumber: opts.prNumber,
      prHeadRef,
      defaultBranch,
      deployWorkflowName: opts.deployWorkflowName,
    }),
    ...(opts.extraFilters ?? []),
  ];
  const filter = filters.map((f) => `(${f})`).join(" || ");
  const webhookUrl = `${opts.wireExternalUrl}/webhooks/${opts.agentId}/github/${name}`;

  return registerRepoWebhook({
    githubToken: opts.githubToken,
    repo: opts.repo,
    name,
    webhookUrl,
    events,
    filter,
  });
}

/**
 * Delete a GitHub webhook directly via API.
 * Use this for manual cleanup. For Wire-managed cleanup, delete the
 * Wire webhook registration instead (the cleanup JS handles it).
 */
export async function deleteGithubWebhook(opts: {
  githubToken: string;
  repo: string;
  hookId: number;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${opts.repo}/hooks/${opts.hookId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${opts.githubToken}`,
        "User-Agent": "wire-github-tools",
      },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub webhook deletion failed (${res.status}): ${await res.text()}`);
  }
}
