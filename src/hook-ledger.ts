/**
 * Local GitHub-hook ledger.
 *
 * Why this exists (AGI-108): the GitHub hook id used to live in exactly one
 * place — `meta.github_hook_id` on the Wire webhook row. Wire deletes that row
 * on several paths of its own (session-scoped purge, reaped-agent dependent
 * purge, the stale-webhook janitor), and each of those runs the row's cleanup
 * JS *best-effort*: the fetch result is never inspected, so a cleanup whose
 * GitHub DELETE returns 401/404 is still logged "cleanup ok" and the row goes
 * away regardless. The lane is then left holding a Wire id that 404s, with no
 * way to name the GitHub hook that is still live on the repo.
 *
 * So we keep a second, local copy of the (wire id -> repo + hook id) mapping
 * that outlives the Wire row. It is a convenience index, not a source of
 * truth: every operation is best-effort and never throws, because failing to
 * write a breadcrumb must never fail a webhook registration.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export type HookRecord = {
  wire_webhook_id: number;
  agent_id: string;
  repo: string;
  github_hook_id: number;
  name: string;
  recorded_at: number;
};

/**
 * Ledger location. `GITHUB_TOOLS_STATE_DIR` overrides it (tests, and hosts
 * that keep agent state somewhere other than ~/.wire).
 */
export function ledgerPath(): string {
  const dir = process.env.GITHUB_TOOLS_STATE_DIR ?? join(homedir(), ".wire");
  return join(dir, "github-hooks.json");
}

/** Wire webhook ids are per-gateway; scope them by owner so cross-agent cleanup can't collide. */
function key(webhookId: number, agentId: string): string {
  return `${agentId}:${webhookId}`;
}

function readAll(path: string): Record<string, HookRecord> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, HookRecord>) : {};
  } catch {
    // Missing or corrupt ledger is not an error — we simply have no breadcrumb.
    return {};
  }
}

function writeAll(path: string, all: Record<string, HookRecord>): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename: a torn ledger would strand every hook id in it.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Record a hook id. Best-effort: returns false if the ledger could not be written. */
export function recordHook(rec: Omit<HookRecord, "recorded_at">, path = ledgerPath()): boolean {
  const all = readAll(path);
  all[key(rec.wire_webhook_id, rec.agent_id)] = { ...rec, recorded_at: Date.now() };
  return writeAll(path, all);
}

/** Look up the GitHub hook behind a Wire webhook id. Null when we never saw it. */
export function lookupHook(webhookId: number, agentId: string, path = ledgerPath()): HookRecord | null {
  return readAll(path)[key(webhookId, agentId)] ?? null;
}

/** Drop an entry once the GitHub hook is known to be gone. Best-effort. */
export function forgetHook(webhookId: number, agentId: string, path = ledgerPath()): boolean {
  const all = readAll(path);
  const k = key(webhookId, agentId);
  if (!(k in all)) return true;
  delete all[k];
  return writeAll(path, all);
}
