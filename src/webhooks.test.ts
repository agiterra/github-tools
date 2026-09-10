/**
 * AGI-108 — the cleanup JS that gets stored on the Wire webhook row.
 *
 * Wire deletes the row whatever this code does: index.ts runs it fire-and-
 * forget then deletes, and server.ts's explicit DELETE `.catch(() => {})`s it.
 * So the only way a failed GitHub delete is ever visible is if this code
 * throws — otherwise Wire logs "webhook_cleanup_ok" over a hook that is still
 * live and still delivering. `secrets.github_token` is the installation token
 * captured at REGISTRATION time, and these cleanups can run many hours later,
 * by which point it has expired: 401 is the expected failure here, and it is
 * exactly what left GitHub hook 676795468 active after Wire row 119 was gone.
 *
 * The cleanup source is read back off the registration payload (rather than
 * imported directly) so this exercises what a lane actually ships to Wire.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { registerRepoWebhook } from "./webhooks.js";

const REPO = "fabrica/fabrica-v3-subgraph";
const HOOK_ID = 676795468;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Register against a stubbed GitHub and hand back the cleanup JS Wire would store. */
async function cleanupJs(): Promise<string> {
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: HOOK_ID }), { status: 201 })) as unknown as typeof fetch;
  const reg = await registerRepoWebhook({
    githubToken: "ghs_atregistration",
    repo: REPO,
    name: "fabrica-v3-subgraph-pr-52",
    webhookUrl: "https://wire.example/webhooks/papassinos/github/fabrica-v3-subgraph-pr-52",
    events: ["pull_request"],
  });
  expect(reg.githubHookId).toBe(HOOK_ID);
  return reg.wireBody.cleanup as string;
}

/** Verbatim copy of wire/src/server.ts:155-162 (runCleanup). */
async function runCleanup(
  code: string,
  ctx: { meta: Record<string, unknown>; secrets: Record<string, string> },
  fetchImpl: typeof fetch,
): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("meta", "secrets", "fetch", code);
  await fn(ctx.meta, ctx.secrets, fetchImpl);
}

const meta = { repo: REPO, github_hook_id: HOOK_ID };
const secrets = { github_token: "ghs_expired" };

function stub(status: number, body = "") {
  const calls: Array<{ url: string; method?: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("webhook cleanup JS", () => {
  test("DELETEs the recorded hook", async () => {
    const code = await cleanupJs();
    const { f, calls } = stub(204);
    await runCleanup(code, { meta, secrets }, f);
    expect(calls).toEqual([{ url: `https://api.github.com/repos/${REPO}/hooks/${HOOK_ID}`, method: "DELETE" }]);
  });

  test("throws when GitHub rejects the delete, so Wire logs cleanup_error, not cleanup_ok", async () => {
    // The AGI-108 regression: an expired installation token 401s, the old
    // cleanup ignored the response, and Wire dropped the row reporting success.
    const code = await cleanupJs();
    const { f } = stub(401, '{"message":"Bad credentials"}');
    await expect(runCleanup(code, { meta, secrets }, f)).rejects.toThrow(new RegExp(`${HOOK_ID} delete failed \\(401\\)`));
  });

  test("throws on a server-side failure too", async () => {
    const code = await cleanupJs();
    const { f } = stub(500);
    await expect(runCleanup(code, { meta, secrets }, f)).rejects.toThrow(/delete failed \(500\)/);
  });

  test("a GitHub 404 is success — the hook is already gone", async () => {
    const code = await cleanupJs();
    const { f } = stub(404);
    await runCleanup(code, { meta, secrets }, f);
  });

  test("no-ops when the row carries no hook id", async () => {
    const code = await cleanupJs();
    const { f, calls } = stub(204);
    await runCleanup(code, { meta: {}, secrets }, f);
    expect(calls).toEqual([]);
  });
});
