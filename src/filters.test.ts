import { describe, expect, test } from "bun:test";
import { prFilter } from "./filters";
// Same semantics as wire's filter VM: a JS expression over (headers, payload), coerced to boolean.
const run = (f: string, payload: unknown) => !!new Function("headers", "payload", `"use strict"; return !!(${f})`)({}, payload);
describe("prFilter — bot-edited comments are noise", () => {
  const f = prFilter(1355);
  test("human PR comment created/edited passes", () => {
    expect(run(f, { action: "created", issue: { number: 1355 }, sender: { type: "User" } })).toBe(true);
    expect(run(f, { action: "edited", issue: { number: 1355 }, sender: { type: "User" } })).toBe(true);
  });
  test("bot comment CREATED passes, bot comment EDITED is dropped", () => {
    expect(run(f, { action: "created", issue: { number: 1355 }, sender: { type: "Bot", login: "coderabbitai[bot]" } })).toBe(true);
    expect(run(f, { action: "edited", issue: { number: 1355 }, sender: { type: "Bot", login: "coderabbitai[bot]" } })).toBe(false);
    expect(run(f, { action: "edited", issue: { number: 1355 }, sender: { type: "Bot", login: "vercel[bot]" } })).toBe(false);
  });
  test("other PRs never match; pull_request events unaffected", () => {
    expect(run(f, { action: "edited", issue: { number: 99 }, sender: { type: "User" } })).toBe(false);
    expect(run(f, { action: "synchronize", pull_request: { number: 1355 }, sender: { type: "Bot" } })).toBe(true);
  });
});
describe("exclude wrapping", () => {
  test("AND NOT removes what the OR-chain would deliver", () => {
    const inner = `(${prFilter(7)})`; const f = `(${inner}) && !((payload.sender?.type === "Bot"))`;
    expect(run(f, { action: "created", issue: { number: 7 }, sender: { type: "Bot" } })).toBe(false);
    expect(run(f, { action: "created", issue: { number: 7 }, sender: { type: "User" } })).toBe(true);
  });
});
