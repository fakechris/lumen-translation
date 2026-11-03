import { describe, it, expect } from "vitest";
import { stripThinkingTags } from "../thinking.js";

/**
 * Reasoning models stream their scratchpad inside `<think>…</think>` before the
 * actual answer. That scratchpad is not a translation — it is the model
 * thinking out loud, often in a different language — and it must never reach
 * the user's translation pane.
 *
 * The function is called on *every* streamed chunk, so it has to handle a
 * half-written block: an unterminated `<think>` is dropped as well.
 */

describe("stripThinkingTags", () => {
  it("leaves ordinary text untouched", () => {
    expect(stripThinkingTags("你好，世界")).toBe("你好，世界");
    expect(stripThinkingTags("")).toBe("");
  });

  it("removes a closed reasoning block", () => {
    expect(stripThinkingTags("<think>let me translate this</think>你好")).toBe("你好");
  });

  it("removes an unterminated reasoning block", () => {
    // The model is still writing its scratchpad: everything from the tag on
    // is reasoning, not output.
    expect(stripThinkingTags("<think>still going")).toBe("");
    expect(stripThinkingTags("visible<think>hidden")).toBe("visible");
  });

  it("removes every reasoning block in the text", () => {
    expect(stripThinkingTags("<think>a</think>中<think>b</think>文")).toBe("中文");
  });

  it("is case-insensitive about the tag", () => {
    expect(stripThinkingTags("<THINK>a</THINK>ok")).toBe("ok");
  });

  it("keeps text that merely mentions the tag name in other markup", () => {
    expect(stripThinkingTags("<thought>not a think block</thought>ok")).toBe(
      "<thought>not a think block</thought>ok",
    );
  });

  it("is idempotent", () => {
    const once = stripThinkingTags("<think>x</think>hello");
    expect(stripThinkingTags(once)).toBe(once);
  });
});
