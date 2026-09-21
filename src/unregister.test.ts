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
  // ⛔ THIS TEST USED TO ASSERT THE DEFECT. It required `ghDeletes` to be EMPTY on a 200,
  // commented "Wire's own cleanup JS did it" — encoding an unverified assumption as a
  // REQUIREMENT. So the bug shipped with a green suite, three times, and the suite is why
  // it looked verified. A test that asserts an assumption protects the assumption.
  test("200 VERIFIES the GitHub hook is gone before clearing the breadcrumb", async () => {
    const { d, store, ghDeletes } = deps({ ledger: [record] });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(true);
    expect(ghDeletes.map((g) => g.hookId)).toEqual([record.github_hook_id]);  // we CHECK, we do not assume
    expect(ghDeletes[0]?.repo).toBe(record.repo);
    expect(out.text).toContain("confirmed removed");
    expect(out.structured?.github_verified).toBe(true);
    expect(store.has(`${AGENT}:${WIRE_ID}`)).toBe(false); // cleared only after confirmation
  });

  // ⛔ THE BRANCH THE WHOLE FIX EXISTS FOR. Brioche's lane lost the hook id exactly here:
  // row gone, hook alive, breadcrumb destroyed, next call 404s with github_hook_id:null.
  test("200 with a FAILING GitHub delete RETAINS the breadcrumb and reports not-ok", async () => {
    const { d, store } = deps({
      ledger: [record],
      deleteGithubHook: async () => { throw new Error("502 bad gateway"); },
    });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(false);
    expect(out.structured?.github_hook_id).toBe(record.github_hook_id);  // id SURVIVES
    expect(out.structured?.record_retained).toBe(true);
    expect(store.has(`${AGENT}:${WIRE_ID}`)).toBe(true);                 // breadcrumb kept
    expect(out.text).toContain("may still be delivering");
  });

  test("200 with NO breadcrumb says GitHub is unverified rather than claiming success", async () => {
    const { d, ghDeletes } = deps({ ledger: [] });
    const out = await unregisterWebhook(d, { webhookId: WIRE_ID, agentId: AGENT });
    expect(out.ok).toBe(true);                       // the Wire row really is gone
    expect(ghDeletes).toEqual([]);                   // nothing to delete against
    expect(out.structured?.github_verified).toBe(false);
    expect(out.text).toContain("NOT VERIFIED");
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
