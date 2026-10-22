import { describe, test, expect } from "bun:test";
import { selectGithubToken, mintFailureReason, TOKEN_RE } from "./mcp-server";

const quiet = () => {};
const REAL = "ghs_" + "A".repeat(36);
describe("selectGithubToken — mint path configured", () => {
  test("mint wins; a per-call token is IGNORED (the pizzicati/cannele/pinolate class)", async () => {
    const logs: string[] = [];
    const r = await selectGithubToken({ cmdConfigured: true, mint: async () => REAL, staticToken: "ghs_stale" + "B".repeat(30), ghCli: async () => null, log: (m) => logs.push(m) }, "GITHUB_TOKEN");
    expect(r).toEqual({ token: REAL, source: "mint" });
    expect(logs.some((l) => l.includes("per-call github_token IGNORED") && l.includes("did not look like a token"))).toBe(true);
  });
  test("mint failure falls back to static, then gh, then a clear error", async () => {
    expect((await selectGithubToken({ cmdConfigured: true, mint: async () => null, staticToken: "ghp_x", ghCli: async () => null, log: quiet })).source).toBe("static");
    expect((await selectGithubToken({ cmdConfigured: true, mint: async () => null, staticToken: "", ghCli: async () => "gho_y", log: quiet })).source).toBe("gh-cli");
    await expect(selectGithubToken({ cmdConfigured: true, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet })).rejects.toThrow(/mint failed and no fallback/);
  });
});
describe("mint failure reason reaches the error (Vacherin 767791)", () => {
  const POLICY = "gh (pod): this persona has no standing GitHub identity (policy). Mint per use: GH_TOKEN=... gh ...";
  test("the mint command's stderr is in the thrown error", async () => {
    await expect(selectGithubToken({ cmdConfigured: true, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet, mintError: () => POLICY }))
      .rejects.toThrow(/Mint command said: gh \(pod\): this persona has no standing GitHub identity \(policy\)/);
  });
  test("no recorded reason -> the old text, no dangling suffix", async () => {
    const e = await selectGithubToken({ cmdConfigured: true, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet, mintError: () => null }).catch((x) => x as Error);
    expect(e.message).toMatch(/gh CLI not authenticated\)$/);
  });
  test("mintFailureReason: every stderr line, wrapper's explanation first, over the execFile message", () => {
    const e = Object.assign(new Error("Command failed: bash -c gh auth token\nmore"), { stderr: `${POLICY}\nno oauth token found for github.com\n\n` });
    expect(mintFailureReason(e)).toBe(`${POLICY} | no oauth token found for github.com`);
    expect(mintFailureReason(Object.assign(new Error("Command failed: x\ny"), { stderr: "" }))).toBe("Command failed: x");
    expect(mintFailureReason(new Error("command printed no token"))).toBe("command printed no token");
  });
});
describe("selectGithubToken — no mint path", () => {
  test("a real per-call token is used", async () => {
    expect(await selectGithubToken({ cmdConfigured: false, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet }, REAL)).toEqual({ token: REAL, source: "per-call" });
  });
  test("the NAME of an env var or an unexpanded $(…) is refused with a message naming the mistake", async () => {
    for (const bogus of ["GITHUB_TOKEN", "$GITHUB_TOKEN", "$(/opt/fabrica/fabrica-v3/.claude/scripts/gh-app-token.sh)`"]) {
      await expect(selectGithubToken({ cmdConfigured: false, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet }, bogus)).rejects.toThrow(/is not a GitHub token/);
    }
  });
  test("static then gh then error", async () => {
    expect((await selectGithubToken({ cmdConfigured: false, mint: async () => null, staticToken: "ghp_static", ghCli: async () => null, log: quiet })).source).toBe("static");
    expect((await selectGithubToken({ cmdConfigured: false, mint: async () => null, staticToken: "", ghCli: async () => "gho_z", log: quiet })).source).toBe("gh-cli");
    await expect(selectGithubToken({ cmdConfigured: false, mint: async () => null, staticToken: "", ghCli: async () => null, log: quiet })).rejects.toThrow(/no GitHub token/);
  });
});
describe("TOKEN_RE", () => {
  test("accepts real shapes, rejects prose", () => {
    expect(TOKEN_RE.test("ghs_" + "x".repeat(36))).toBe(true);
    expect(TOKEN_RE.test("github_pat_" + "x".repeat(40))).toBe(true);
    expect(TOKEN_RE.test("GITHUB_TOKEN")).toBe(false);
    expect(TOKEN_RE.test("ghs_short")).toBe(false);
  });
});
