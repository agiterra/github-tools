/**
 * ENG-4094: a callback URL GitHub cannot reach must be REFUSED, not sent.
 *
 * The defect was never in URL construction — it is the default
 * `WIRE_EXTERNAL_URL ?? WIRE_URL`, where WIRE_URL is localhost. It has looked fixed
 * all cycle only because every crew spawn sets WIRE_EXTERNAL_URL. Absence of the
 * symptom is not a fix, so these tests pin the BEHAVIOUR rather than the environment.
 */
import { expect, test, describe } from "bun:test";
import { isReachableCallbackUrl } from "./webhooks.ts";

describe("isReachableCallbackUrl", () => {
  test("REFUSES the exact shape ENG-4094 hit", () => {
    const r = isReachableCallbackUrl("http://localhost:9800/webhooks/eng-x/github/pr");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("WIRE_EXTERNAL_URL");   // names the cause, not just the symptom
  });

  test("REFUSES other unreachable hosts", () => {
    for (const u of [
      "http://127.0.0.1:9800/x", "http://10.0.0.5/x", "http://192.168.1.9/x",
      "http://172.16.0.3/x", "http://169.254.1.1/x", "http://box.local/x", "http://svc.internal/x",
    ]) {
      expect(isReachableCallbackUrl(u).ok).toBe(false);
    }
  });

  // ⛔ THE ACCEPT PATH. A guard never shown to PERMIT is indistinguishable from one that
  // refuses everything — and this one sits in front of every webhook registration.
  test("PERMITS the real production callback", () => {
    const r = isReachableCallbackUrl("https://patisserie.ngrok.io/webhooks/eng-x/github/pr");
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  test("PERMITS ordinary public hosts, http and https", () => {
    expect(isReachableCallbackUrl("https://example.com/webhooks/a/github/b").ok).toBe(true);
    expect(isReachableCallbackUrl("http://example.com/webhooks/a/github/b").ok).toBe(true);
  });

  test("REFUSES malformed input and non-http schemes without throwing", () => {
    expect(isReachableCallbackUrl("not a url").ok).toBe(false);
    expect(isReachableCallbackUrl("ftp://example.com/x").ok).toBe(false);
  });

  // 172.16–172.31 is private; 172.15 and 172.32 are NOT. An over-broad regex would
  // refuse legitimate public hosts, which fails closed in the expensive direction.
  test("the private-range boundary is not over-broad", () => {
    expect(isReachableCallbackUrl("http://172.15.0.1/x").ok).toBe(true);
    expect(isReachableCallbackUrl("http://172.32.0.1/x").ok).toBe(true);
    expect(isReachableCallbackUrl("http://172.31.0.1/x").ok).toBe(false);
  });
});
