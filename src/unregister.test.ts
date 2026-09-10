/**
 * AGI-108 — unregister_webhook's Wire-404 path.
 *
 * Field case (papassinos, 2026-09-10): Wire row 119 for fabrica-v3-subgraph#52
 * was gone by 13:47Z while GitHub hook 676795468 was still active=true.
 * unregister_webhook(119) reported only `Wire deletion failed (404)`, so the
 * lane had to list the repo's hooks by hand to find and delete it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unregisterWebhook, type UnregisterDeps } from "./unregister.js";
import { recordHook, lookupHook, forgetHook, ledgerPath, type HookRecord } from "./hook-ledger.js";

const HOOK_ID = 676795468;
const REPO = "fabrica/fabrica-v3-subgraph";
const WIRE_ID = 119;
const AGENT = "papassinos";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agi108-")); process.env.GITHUB_TOOLS_STATE_DIR = dir; });
afterEach(() => { delete process.env.GITHUB_TOOLS_STATE_DIR; try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function res(status: number, body = ""): Response {
  return new Response(body, { status });
}

/** Deps with an in-memory ledger; overrides let each test vary one piece. */
function deps(over: Partial<UnregisterDeps> & { ledger?: HookRecord[] } = {}) {
  const store = new Map<string, HookRecord>();
  for (const r of over.ledger ?? []) store.set(`${r.agent_id}:${r.wire_webhook_id}`, r);
  const ghDeletes: Array<{ repo: string; hookId: number; githubToken: string }> = [];
  const d: UnregisterDeps = {
    wireDelete: over.wireDelete ?? (async () => res(200, '{"deleted":119}')),
    lookupHook: over.lookupHook ?? ((id, agent) => store.get(`${agent}:${id}`) ?? null),
    forgetHook: over.forgetHook ?? ((id, agent) => { store.delete(`${agent}:${id}`); }),
    deleteGithubHook: over.deleteGithubHook ?? (async (o) => { ghDeletes.push(o); }),
    resolveGithubToken: over.resolveGithubToken ?? (async () => "ghs_freshtoken"),
  };
  return { d, store, ghDeletes };
}

const record: HookRecord = {
  wire_webhook_id: WIRE_ID, agent_id: AGENT, repo: REPO,
  github_hook_id: HOOK_ID, name: "fabrica-v3-subgraph-pr-52", recorded_at: Date.now(),
};

describe("unregisterWebhook — Wire 404 with a recoverable GitHub hook id", () => {
  test("deletes the still-live GitHub hook and says so", async () => {
    const { d, ghDeletes } = deps({ wireDelete: async () => res(404, '{"error":"webhook not found"}'), ledger: [record] });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });

    expect(ghDeletes).toEqual([{ repo: REPO, hookId: HOOK_ID, githubToken: "ghs_freshtoken" }]);
    expect(out.ok).toBe(true);
    expect(out.text).toContain(`Wire record missing; GitHub hook ${HOOK_ID} deleted`);
    expect(out.structured).toMatchObject({ github_hook_id: HOOK_ID, repo: REPO, recovered: true });
  });

  test("drops the ledger entry once the hook is gone (no second delete attempt)", async () => {
    const { d, store } = deps({ wireDelete: async () => res(404, '{"error":"webhook not found"}'), ledger: [record] });
    await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(store.has(`${AGENT}:${WIRE_ID}`)).toBe(false);
  });

  test("a token that cannot be minted is reported, not swallowed as success", async () => {
    const { d } = deps({
      wireDelete: async () => res(404, '{"error":"webhook not found"}'),
      ledger: [record],
      resolveGithubToken: async () => { throw new Error("mint failed"); },
    });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(false);
    expect(out.text).toContain(`GitHub hook ${HOOK_ID} could not be deleted`);
    expect(out.text).toContain(REPO);
  });

  test("a failing GitHub DELETE is reported with the hook id, not a bare 404", async () => {
    const { d } = deps({
      wireDelete: async () => res(404, '{"error":"webhook not found"}'),
      ledger: [record],
      deleteGithubHook: async () => { throw new Error("GitHub webhook deletion failed (401): Bad credentials"); },
    });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(false);
    expect(out.text).toContain(String(HOOK_ID));
    expect(out.structured).toMatchObject({ github_hook_id: HOOK_ID, remedy: "list repo hooks" });
  });
});

describe("unregisterWebhook — Wire 404 with no recoverable id", () => {
  test("returns the structured 'may still exist' error instead of a bare 404", async () => {
    const { d, ghDeletes } = deps({ wireDelete: async () => res(404, '{"error":"webhook not found"}') });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });

    expect(out.ok).toBe(false);
    expect(out.text).toContain("Wire record missing; GitHub hook may still exist — list repo hooks");
    expect(out.text).not.toContain("Wire deletion failed (404)");
    expect(out.structured).toMatchObject({ wire_status: 404, webhook_id: WIRE_ID, agent_id: AGENT, github_hook_id: null });
    expect(ghDeletes).toEqual([]);          // nothing to delete, and we must not guess
  });

  test("does not need a GitHub token when there is nothing to recover", async () => {
    let minted = 0;
    const { d } = deps({
      wireDelete: async () => res(404, ""),
      resolveGithubToken: async () => { minted++; return "ghs_x"; },
    });
    await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(minted).toBe(0);
  });
});

describe("unregisterWebhook — unchanged paths", () => {
  test("200 reports the delete and clears the breadcrumb", async () => {
    const { d, store, ghDeletes } = deps({ ledger: [record] });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(true);
    expect(out.text).toBe(`Webhook ${WIRE_ID} deleted (owner=${AGENT})`);
    expect(ghDeletes).toEqual([]);          // Wire's own cleanup JS did it
    expect(store.has(`${AGENT}:${WIRE_ID}`)).toBe(false);
  });

  test("a non-404 failure still surfaces status and body verbatim", async () => {
    const { d } = deps({ wireDelete: async () => res(403, '{"error":"forbidden"}'), ledger: [record] });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(false);
    expect(out.text).toBe('Wire deletion failed (403): {"error":"forbidden"}');
  });

  test("targets the owner passed in, not the caller", async () => {
    const paths: string[] = [];
    const { d } = deps({ wireDelete: async (p) => { paths.push(p); return res(200); } });
    await unregisterWebhook(d, { webhookId: 7, agentId: "someone-else" });
    expect(paths).toEqual(["/agents/someone-else/webhooks/7"]);
  });
});

describe("hook ledger", () => {
  test("round-trips a record through the on-disk ledger", () => {
    expect(recordHook({ wire_webhook_id: WIRE_ID, agent_id: AGENT, repo: REPO, github_hook_id: HOOK_ID, name: "pr-52" })).toBe(true);
    expect(existsSync(ledgerPath())).toBe(true);
    expect(lookupHook(WIRE_ID, AGENT)).toMatchObject({ github_hook_id: HOOK_ID, repo: REPO });
  });

  test("scopes ids by owning agent so cross-agent cleanup cannot collide", () => {
    recordHook({ wire_webhook_id: WIRE_ID, agent_id: AGENT, repo: REPO, github_hook_id: HOOK_ID, name: "pr-52" });
    recordHook({ wire_webhook_id: WIRE_ID, agent_id: "other-lane", repo: "fabrica/other", github_hook_id: 1, name: "pr-1" });
    expect(lookupHook(WIRE_ID, AGENT)?.github_hook_id).toBe(HOOK_ID);
    expect(lookupHook(WIRE_ID, "other-lane")?.github_hook_id).toBe(1);
  });

  test("unknown id reads as null, and forget is idempotent", () => {
    expect(lookupHook(999, AGENT)).toBeNull();
    expect(forgetHook(999, AGENT)).toBe(true);
  });

  test("a corrupt ledger degrades to 'no breadcrumb' rather than throwing", () => {
    writeFileSync(ledgerPath(), "{not json");
    expect(lookupHook(WIRE_ID, AGENT)).toBeNull();
    expect(recordHook({ wire_webhook_id: 5, agent_id: AGENT, repo: REPO, github_hook_id: 5, name: "n" })).toBe(true);
    expect(lookupHook(5, AGENT)?.github_hook_id).toBe(5);
  });

  test("an unwritable ledger reports false instead of failing the registration", () => {
    process.env.GITHUB_TOOLS_STATE_DIR = "/proc/nonexistent-agi108/state";
    expect(recordHook({ wire_webhook_id: 1, agent_id: AGENT, repo: REPO, github_hook_id: 1, name: "n" })).toBe(false);
  });
});
