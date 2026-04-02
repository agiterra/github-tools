/**
 * GitHub webhook lifecycle — register, unregister, and helpers.
 *
 * Pure functions. All config via params. No env reads.
 * Generates the Wire webhook payload (validator JS, filter JS, cleanup JS)
 * and creates/deletes the GitHub-side webhook via API.
 */

import { createAuthJwt } from "@agiterra/wire-tools/crypto";
import { prFilter } from "./filters.js";

export type RepoWebhookOptions = {
  wireUrl: string;
  agentId: string;
  signingKey: CryptoKey;
  githubToken: string;
  /** Repository in owner/repo format */
  repo: string;
  /** Webhook name (used in Wire URL path) */
  name: string;
  /** GitHub webhook events to subscribe to */
  events: string[];
  /** Filter JS expression. If omitted, all events are delivered. */
  filter?: string;
  /** Wire webhook URL base (externally-reachable). Defaults to wireUrl. */
  externalUrl?: string;
};

export type PrWebhookOptions = {
  wireUrl: string;
  agentId: string;
  signingKey: CryptoKey;
  githubToken: string;
  repo: string;
  prNumber: number;
  /** Webhook name. Defaults to "{repo-name}-pr-{prNumber}" */
  name?: string;
  /** Extra events beyond the PR default set */
  extraEvents?: string[];
  /** Extra filter expressions OR'd with the PR filter */
  extraFilters?: string[];
  externalUrl?: string;
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

type WebhookResult = {
  wireWebhookId: number;
  wireWebhookUrl: string;
  githubHookId: number;
  name: string;
};

/**
 * Register a GitHub webhook with full control over events and filter.
 */
export async function registerRepoWebhook(opts: RepoWebhookOptions): Promise<WebhookResult> {
  const externalUrl = opts.externalUrl ?? opts.wireUrl;
  const webhookSecret = crypto.randomUUID();
  const wireWebhookUrl = `${externalUrl}/webhooks/${opts.agentId}/github/${opts.name}`;

  // 1. Create GitHub webhook
  const ghRes = await fetch(`https://api.github.com/repos/${opts.repo}/hooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "wire-github-tools",
    },
    body: JSON.stringify({
      config: {
        url: wireWebhookUrl,
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

  // 2. Register on Wire
  const wireBody = JSON.stringify({
    plugin: "github",
    name: opts.name,
    validator: hmacValidatorCode(),
    filter: opts.filter ?? undefined,
    cleanup: cleanupCode(),
    meta: {
      repo: opts.repo,
      github_hook_id: ghHook.id,
    },
    secrets: {
      webhook_secret: webhookSecret,
      github_token: opts.githubToken,
    },
  });

  const wireToken = await createAuthJwt(opts.signingKey, opts.agentId, wireBody);
  const wireRes = await fetch(`${opts.wireUrl}/agents/${opts.agentId}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wireToken}`,
      "Content-Type": "application/json",
    },
    body: wireBody,
  });

  if (!wireRes.ok) {
    // Roll back GitHub webhook
    await fetch(`https://api.github.com/repos/${opts.repo}/hooks/${ghHook.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.githubToken}`, "User-Agent": "wire-github-tools" },
    }).catch(() => {});
    const detail = await wireRes.text();
    throw new Error(`Wire webhook registration failed (${wireRes.status}): ${detail}`);
  }

  const wireHook = (await wireRes.json()) as { webhook_id: number };

  return {
    wireWebhookId: wireHook.webhook_id,
    wireWebhookUrl,
    githubHookId: ghHook.id,
    name: opts.name,
  };
}

/**
 * Register a GitHub webhook for PR monitoring.
 * Convenience wrapper over registerRepoWebhook with PR-specific defaults.
 */
export async function registerPrWebhook(opts: PrWebhookOptions): Promise<WebhookResult> {
  const repoName = opts.repo.split("/").pop() ?? opts.repo;
  const name = opts.name ?? `${repoName}-pr-${opts.prNumber}`;

  const events = [...DEFAULT_PR_EVENTS, ...(opts.extraEvents ?? [])];

  const filters = [prFilter(opts.prNumber), ...(opts.extraFilters ?? [])];
  const filter = filters.map((f) => `(${f})`).join(" || ");

  return registerRepoWebhook({
    wireUrl: opts.wireUrl,
    agentId: opts.agentId,
    signingKey: opts.signingKey,
    githubToken: opts.githubToken,
    repo: opts.repo,
    name,
    events,
    filter,
    externalUrl: opts.externalUrl,
  });
}

/**
 * Unregister a webhook from Wire (runs cleanup JS → deletes GitHub hook).
 */
export async function unregisterWebhook(opts: {
  wireUrl: string;
  agentId: string;
  signingKey: CryptoKey;
  webhookId: number;
}): Promise<void> {
  const body = "{}";
  const token = await createAuthJwt(opts.signingKey, opts.agentId, body);
  const res = await fetch(
    `${opts.wireUrl}/agents/${opts.agentId}/webhooks/${opts.webhookId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`Wire webhook deletion failed (${res.status}): ${await res.text()}`);
  }
}
