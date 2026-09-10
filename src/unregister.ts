/**
 * unregister_webhook's library half (AGI-108).
 *
 * A Wire DELETE that 404s used to surface as a bare
 * `Wire deletion failed (404): {"error":"webhook not found"}`, which tells the
 * lane nothing about the thing that actually matters: the GitHub hook is very
 * likely still live and still delivering. Wire drops webhook rows on paths of
 * its own (see hook-ledger.ts), so a 404 is a routine outcome, not a caller
 * error — and it is the one case where the caller has to finish the teardown
 * on the GitHub side itself.
 *
 * Dependencies are injected so this is testable without a Wire gateway, a
 * GitHub token, or the MCP transport.
 */

import type { HookRecord } from "./hook-ledger.js";

export type UnregisterDeps = {
  /** Signed DELETE against the Wire gateway. */
  wireDelete: (path: string) => Promise<Response>;
  /** Local ledger lookup for the GitHub hook id. */
  lookupHook: (webhookId: number, agentId: string) => HookRecord | null;
  /** Drop the ledger entry once the GitHub hook is gone. */
  forgetHook: (webhookId: number, agentId: string) => void;
  /** Delete the hook on GitHub. */
  deleteGithubHook: (opts: { githubToken: string; repo: string; hookId: number }) => Promise<void>;
  /** Resolve a GitHub token (only called when a recovery is actually needed). */
  resolveGithubToken: () => Promise<string>;
};

export type UnregisterResult = {
  /** false => the MCP layer marks the tool call isError. */
  ok: boolean;
  /** Human-facing text. */
  text: string;
  /** Machine-readable detail, serialized alongside `text` for the error paths. */
  structured?: Record<string, unknown>;
};

/**
 * Delete a Wire webhook registration, recovering the GitHub side when Wire has
 * already forgotten the row.
 *
 * 200  -> Wire ran the row's cleanup; drop our breadcrumb and report success.
 * 404  -> the row is gone. If we recorded the GitHub hook id at registration,
 *         delete the hook ourselves and say so. If we did not, say plainly
 *         that a hook may still be live rather than echoing a bare 404.
 * else -> unchanged: surface the status and body.
 */
export async function unregisterWebhook(
  deps: UnregisterDeps,
  args: { webhookId: number; agentId: string },
): Promise<UnregisterResult> {
  const { webhookId, agentId } = args;
  const res = await deps.wireDelete(`/agents/${agentId}/webhooks/${webhookId}`);

  if (res.ok) {
    // Wire's DELETE handler ran the row's cleanup JS, which deletes the GitHub
    // hook. The breadcrumb has no further use.
    deps.forgetHook(webhookId, agentId);
    return { ok: true, text: `Webhook ${webhookId} deleted (owner=${agentId})` };
  }

  if (res.status !== 404) {
    return {
      ok: false,
      text: `Wire deletion failed (${res.status}): ${await res.text()}`,
      structured: { wire_status: res.status, webhook_id: webhookId, agent_id: agentId },
    };
  }

  // --- 404: the Wire row is gone. Finish the job on GitHub. ---
  const rec = deps.lookupHook(webhookId, agentId);

  if (!rec) {
    return {
      ok: false,
      text:
        "Wire record missing; GitHub hook may still exist — list repo hooks " +
        `(GET /repos/{owner}/{repo}/hooks, match config.url ending /webhooks/${agentId}/github/<name>, then DELETE it)`,
      structured: {
        wire_status: 404,
        webhook_id: webhookId,
        agent_id: agentId,
        github_hook_id: null,
        reason: "no local record of the GitHub hook id for this Wire webhook id",
        remedy: "list repo hooks",
      },
    };
  }

  try {
    const githubToken = await deps.resolveGithubToken();
    // deleteGithubWebhook treats a GitHub 404 as success — the hook being
    // already gone is the outcome we wanted.
    await deps.deleteGithubHook({ githubToken, repo: rec.repo, hookId: rec.github_hook_id });
  } catch (e) {
    return {
      ok: false,
      text:
        `Wire record missing; GitHub hook ${rec.github_hook_id} could not be deleted ` +
        `(${(e as Error).message}) — list repo hooks for ${rec.repo}`,
      structured: {
        wire_status: 404,
        webhook_id: webhookId,
        agent_id: agentId,
        github_hook_id: rec.github_hook_id,
        repo: rec.repo,
        remedy: "list repo hooks",
      },
    };
  }

  deps.forgetHook(webhookId, agentId);
  return {
    ok: true,
    text: `Wire record missing; GitHub hook ${rec.github_hook_id} deleted (repo=${rec.repo}, name=${rec.name})`,
    structured: {
      wire_status: 404,
      webhook_id: webhookId,
      agent_id: agentId,
      github_hook_id: rec.github_hook_id,
      repo: rec.repo,
      recovered: true,
    },
  };
}
