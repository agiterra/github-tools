#!/usr/bin/env bun
/**
 * GitHub webhook MCP server — runtime-agnostic adapter.
 *
 * Provides tools for agents to register and manage GitHub webhooks on Wire.
 * The agent calls register_pr_webhook with a repo and PR number; the plugin
 * handles creating the GitHub hook and registering it on Wire.
 *
 * Config env vars:
 *   WIRE_URL             default http://localhost:9800
 *   WIRE_EXTERNAL_URL    externally-reachable Wire URL (e.g. ngrok)
 *   AGENT_ID             required
 *   AGENT_PRIVATE_KEY    Ed25519 PKCS8 base64 (required for Wire API auth)
 *   GITHUB_TOKEN         default GitHub token (admin:repo_hook scope)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerPrWebhook, registerRepoWebhook, deleteGithubWebhook, checkPrRebaseState } from "./index.js";
import { createAuthJwt, importPrivateKey } from "@agiterra/wire-tools/crypto";

const WIRE_URL = process.env.WIRE_URL ?? "http://localhost:9800";
const WIRE_EXTERNAL_URL = process.env.WIRE_EXTERNAL_URL ?? WIRE_URL;
const AGENT_ID = process.env.AGENT_ID ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

let signingKey: CryptoKey | null = null;

const mcp = new Server(
  { name: "github-webhooks", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "This plugin provides GitHub webhook management for Wire. " +
      "Use register_pr_webhook to monitor a PR's CI, reviews, and comments. " +
      "Use unregister_webhook to stop monitoring. " +
      "Webhooks are automatically cleaned up when ephemeral agents are reaped.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "register_pr_webhook",
      description:
        "Register a GitHub webhook to monitor a PR. Creates the hook on GitHub " +
        "and registers it on Wire with HMAC validation and PR-scoped filtering. " +
        "Catches both pre-merge events (CI on the PR branch) and post-merge " +
        "events (workflows triggered by the merge commit on the default branch). " +
        "Pass deploy_workflow_name to scope post-merge matches to a specific deploy " +
        "workflow (e.g. 'Deploy to Staging') and drop unrelated post-merge runs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Repository in owner/repo format" },
          pr_number: { type: "number", description: "PR number to monitor" },
          name: { type: "string", description: "Optional webhook name. Defaults to '{repo-name}-pr-{number}'" },
          filter: { type: "string", description: "Extra JS filter expression OR'd with the built-in PR filter. Vars: headers, payload." },
          deploy_workflow_name: {
            type: "string",
            description:
              "Optional GitHub Actions workflow name (e.g. 'Deploy to Staging'). " +
              "When set, post-merge workflow_run matches additionally require " +
              "workflow_run.name === this value. Omit to receive ALL post-merge " +
              "workflows tagged with the PR number in the merge commit message.",
          },
          github_token: { type: "string", description: "GitHub token. Defaults to GITHUB_TOKEN env var." },
        },
        required: ["repo", "pr_number"],
      },
    },
    {
      name: "register_repo_webhook",
      description:
        "Register a GitHub webhook for a repo with custom events and filter.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Repository in owner/repo format" },
          name: { type: "string", description: "Webhook name (used in the Wire URL path)" },
          events: { type: "array", items: { type: "string" }, description: "GitHub events to subscribe to" },
          filter: { type: "string", description: "JS filter expression. Vars: headers, payload." },
          github_token: { type: "string", description: "GitHub token. Defaults to GITHUB_TOKEN env var." },
        },
        required: ["repo", "name", "events"],
      },
    },
    {
      name: "check_pr_rebase",
      description:
        "Check whether a PR needs a rebase. Reads GitHub's `mergeable_state` " +
        "field (same signal as the 'This branch has conflicts that must be " +
        "resolved' banner on github.com).\n\n" +
        "GitHub computes mergeable_state lazily — the first poll after a base- " +
        "branch push often returns null ('computing'). This tool retries with " +
        "backoff up to ~52s total before settling.\n\n" +
        "Returns { state, needs_rebase, message, attempts, pr_url }. The " +
        "`needs_rebase` boolean is true only when state === 'dirty' " +
        "(actual conflicts that must be resolved). Other non-clean states " +
        "(behind, blocked, unstable, etc.) are reported but don't set " +
        "needs_rebase=true — those are the engineer's call.\n\n" +
        "Use case: agents receiving a pull_request.synchronize webhook event " +
        "call this on their own PR to learn whether they need to rebase, then " +
        "act (rebase locally + force-push) or relay the message to their " +
        "operator.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: "Repository in owner/repo format" },
          pr_number: { type: "number", description: "PR number to check" },
          github_token: { type: "string", description: "GitHub token. Defaults to GITHUB_TOKEN env var." },
        },
        required: ["repo", "pr_number"],
        additionalProperties: false,
      },
    },
    {
      name: "unregister_webhook",
      description:
        "Delete a Wire webhook registration. Runs the webhook's cleanup code (typically deletes the GitHub hook). " +
        "Optionally pass `agent_id` to target another agent's webhook — useful for operators / housekeeping agents " +
        "tidying up stale registrations owned by an offline or out-of-context agent. Wire authorizes any registered " +
        "agent's JWT for this endpoint; the URL path's `:agent_id` locks the target.",
      inputSchema: {
        type: "object" as const,
        properties: {
          webhook_id: { type: "number", description: "Wire webhook ID (returned by register_*)" },
          agent_id: {
            type: "string",
            description: "Optional. ID of the agent that owns the webhook. Defaults to the caller's AGENT_ID — only set this when cleaning up someone else's webhook.",
          },
        },
        required: ["webhook_id"],
      },
    },
  ],
}));

/** Sign body and POST to Wire. */
async function wirePost(path: string, body: string): Promise<Response> {
  if (!signingKey) throw new Error("no signing key — Wire auth disabled");
  const token = await createAuthJwt(signingKey, AGENT_ID, body);
  return fetch(`${WIRE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}

/** Sign body and DELETE on Wire. */
async function wireDelete(path: string): Promise<Response> {
  if (!signingKey) throw new Error("no signing key — Wire auth disabled");
  const body = "{}";
  const token = await createAuthJwt(signingKey, AGENT_ID, body);
  return fetch(`${WIRE_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "register_pr_webhook") {
      const token = (a.github_token as string) || GITHUB_TOKEN;
      if (!token) throw new Error("no GitHub token — set GITHUB_TOKEN or pass github_token param");

      const extraFilters = a.filter ? [a.filter as string] : undefined;
      const result = await registerPrWebhook({
        githubToken: token,
        repo: a.repo as string,
        prNumber: a.pr_number as number,
        agentId: AGENT_ID,
        wireExternalUrl: WIRE_EXTERNAL_URL,
        name: a.name as string | undefined,
        extraFilters,
        deployWorkflowName: a.deploy_workflow_name as string | undefined,
      });

      // Register on Wire
      const wireBody = JSON.stringify(result.wireBody);
      const wireRes = await wirePost(`/agents/${AGENT_ID}/webhooks`, wireBody);
      if (!wireRes.ok) {
        // Roll back GitHub webhook
        await deleteGithubWebhook({ githubToken: token, repo: a.repo as string, hookId: result.githubHookId });
        throw new Error(`Wire registration failed (${wireRes.status}): ${await wireRes.text()}`);
      }
      const wireHook = (await wireRes.json()) as { webhook_id: number };

      return {
        content: [{
          type: "text" as const,
          text: `Webhook registered: ${result.name}\nWire ID: ${wireHook.webhook_id}\nGitHub hook ID: ${result.githubHookId}`,
        }],
      };
    }

    if (name === "register_repo_webhook") {
      const token = (a.github_token as string) || GITHUB_TOKEN;
      if (!token) throw new Error("no GitHub token — set GITHUB_TOKEN or pass github_token param");

      const webhookUrl = `${WIRE_EXTERNAL_URL}/webhooks/${AGENT_ID}/github/${a.name}`;
      const result = await registerRepoWebhook({
        githubToken: token,
        repo: a.repo as string,
        name: a.name as string,
        webhookUrl,
        events: a.events as string[],
        filter: a.filter as string | undefined,
      });

      const wireBody = JSON.stringify(result.wireBody);
      const wireRes = await wirePost(`/agents/${AGENT_ID}/webhooks`, wireBody);
      if (!wireRes.ok) {
        await deleteGithubWebhook({ githubToken: token, repo: a.repo as string, hookId: result.githubHookId });
        throw new Error(`Wire registration failed (${wireRes.status}): ${await wireRes.text()}`);
      }
      const wireHook = (await wireRes.json()) as { webhook_id: number };

      return {
        content: [{
          type: "text" as const,
          text: `Webhook registered: ${result.name}\nWire ID: ${wireHook.webhook_id}\nGitHub hook ID: ${result.githubHookId}`,
        }],
      };
    }

    if (name === "check_pr_rebase") {
      const token = (a.github_token as string) || GITHUB_TOKEN;
      if (!token) throw new Error("no GitHub token — set GITHUB_TOKEN or pass github_token param");
      const result = await checkPrRebaseState({
        repo: a.repo as string,
        prNumber: a.pr_number as number,
        githubToken: token,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "unregister_webhook") {
      const webhookId = a.webhook_id as number;
      if (!webhookId) throw new Error("missing webhook_id");
      // Caller's AGENT_ID is the default owner; override via `agent_id`
      // when cleaning up another agent's webhook. Wire's endpoint accepts
      // any registered agent's JWT for the auth gate, then enforces that
      // the URL path's agent_id matches the webhook's owner row.
      const ownerId = (a.agent_id as string | undefined) ?? AGENT_ID;
      const res = await wireDelete(`/agents/${ownerId}/webhooks/${webhookId}`);
      if (!res.ok) throw new Error(`Wire deletion failed (${res.status}): ${await res.text()}`);

      return {
        content: [{ type: "text" as const, text: `Webhook ${webhookId} deleted (owner=${ownerId})` }],
      };
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `${name} failed: ${e.message}` }],
      isError: true,
    };
  }
});

export async function startServer(): Promise<void> {
  const rawKey = process.env.AGENT_PRIVATE_KEY;
  if (!rawKey) {
    console.error("[github] no private key — Wire auth disabled");
  } else {
    signingKey = await importPrivateKey(rawKey);
  }

  if (!AGENT_ID) console.error("[github] no AGENT_ID — tools will fail");
  if (!GITHUB_TOKEN) console.error("[github] no GITHUB_TOKEN — agents must pass github_token param");

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`[github] ready (agent=${AGENT_ID})`);
}
