import assert from "node:assert/strict";
import test from "node:test";
import { PiAgent } from "../src/agent.js";
import { OutputError, RunAbortedError, RunFailedError } from "../src/errors.js";
import { checkModel } from "../src/model.js";
import { outputTool, runForOutput } from "../src/output.js";
import { scriptedAgent } from "../src/testing.js";
import { clip, formatEvent } from "../src/trace.js";

const schema = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
};

function judgmentTool() {
  return outputTool<{ status: "cited" | "absent" }>({
    name: "submit_judgment",
    parameters: schema,
    validate(value: any) {
      if (value?.status !== "cited" && value?.status !== "absent") throw new Error(`bad status ${value?.status}`);
      return { status: value.status };
    },
  });
}

test("runForOutput returns the validated output with a trace", async () => {
  const output = judgmentTool();
  const agent = scriptedAgent({ tools: [output.tool], script: [[{ tool: "submit_judgment", args: { status: "cited" } }]] });
  const result = await agent.runForOutput("judge", output);
  assert.deepEqual(result.output, { status: "cited" });
  assert.equal(result.outputAttempts, 1);
  assert.equal(result.trace?.toolCalls.length, 1);
  assert.equal(result.trace?.toolCalls[0].isError, false);
  assert.equal(result.model, "scripted/scripted");
  agent.dispose();
});

test("a rejected output reaches the model as a tool error and can be corrected in the same run", async () => {
  const output = judgmentTool();
  const agent = scriptedAgent({
    tools: [output.tool],
    script: [[
      { tool: "submit_judgment", args: { status: "maybe" } },
      { tool: "submit_judgment", args: { status: "absent" } },
    ]],
  });
  const result = await runForOutput(agent, "judge", output);
  assert.deepEqual(result.output, { status: "absent" });
  const [rejected] = result.trace!.toolCalls;
  assert.equal(rejected.isError, true);
  assert.match(clip(rejected.result), /bad status maybe/);
  agent.dispose();
});

test("a missing output is nudged in the same session", async () => {
  const output = judgmentTool();
  const agent = scriptedAgent({
    tools: [output.tool],
    script: [[{ text: "I think it is cited." }], [{ tool: "submit_judgment", args: { status: "cited" } }]],
  });
  const result = await agent.runForOutput("judge", output, { nudge: "Call submit_judgment now." });
  assert.equal(result.outputAttempts, 2);
  assert.deepEqual(agent.prompts, ["judge", "Call submit_judgment now."]);
  agent.dispose();
});

test("runForOutput throws OutputError after its nudges", async () => {
  const output = judgmentTool();
  const agent = scriptedAgent({
    tools: [output.tool],
    script: [[{ text: "no" }], [{ tool: "submit_judgment", args: { status: "nope" } }]],
  });
  await assert.rejects(agent.runForOutput("judge", output), (error: unknown) => {
    assert.ok(error instanceof OutputError);
    assert.equal(error.attempts, 2);
    assert.equal(error.calls, 1);
    assert.deepEqual(error.rejections, ["bad status nope"]);
    assert.match(error.message, /last rejection: bad status nope/);
    return true;
  });
  agent.dispose();
});

test("a looping output tool is aborted and the recorded output is kept", async () => {
  const output = judgmentTool();
  const loop = Array.from({ length: 20 }, () => ({ tool: "submit_judgment", args: { status: "cited" } }));
  const agent = scriptedAgent({ tools: [output.tool], script: [loop] });
  const result = await agent.runForOutput("judge", output, { maxOutputCalls: 2 });
  assert.deepEqual(result.output, { status: "cited" });
  assert.ok(result.trace!.toolCalls.length <= 4, `expected the loop to stop early, got ${result.trace!.toolCalls.length}`);
  const replies = result.trace!.toolCalls.map(call => clip(call.result));
  assert.match(replies[0], /Recorded/);
  assert.match(replies[1], /STOP/);
  agent.dispose();
});

test("timeoutMs aborts a stalled run with a typed error and runForOutput nudges after it", async () => {
  const stalled = scriptedAgent({ script: [[{ stall: true }]] });
  await assert.rejects(stalled.run("hello", { timeoutMs: 20 }), (error: unknown) => {
    assert.ok(error instanceof RunAbortedError);
    assert.equal(error.reason, "timeout");
    assert.equal(error.result?.stopReason, "aborted");
    return true;
  });
  stalled.dispose();

  const output = judgmentTool();
  const agent = scriptedAgent({
    tools: [output.tool],
    script: [[{ stall: true }], [{ tool: "submit_judgment", args: { status: "cited" } }]],
  });
  const result = await agent.runForOutput("judge", output, { timeoutMs: 20 });
  assert.equal(result.outputAttempts, 2);
  agent.dispose();
});

test("maxTurns and maxToolCalls stop a run", async () => {
  const tool = { name: "noop", label: "noop", description: "", parameters: {}, execute: async () => ({ content: [], details: {} }) };
  const many = Array.from({ length: 10 }, () => ({ tool: "noop", args: {} }));

  const turns = scriptedAgent({ tools: [tool], script: [many] });
  await assert.rejects(turns.run("go", { maxTurns: 3 }), (error: any) => error instanceof RunAbortedError && error.reason === "max_turns");
  turns.dispose();

  const calls = scriptedAgent({ tools: [tool], script: [many] });
  await assert.rejects(calls.run("go", { maxToolCalls: 2 }), (error: any) => {
    assert.ok(error instanceof RunAbortedError);
    assert.equal(error.reason, "max_tool_calls");
    assert.ok(error.result!.trace!.toolCalls.length <= 4);
    return true;
  });
  calls.dispose();
});

test("an abort signal stops the run and is not retried", async () => {
  const controller = new AbortController();
  const agent = scriptedAgent({ script: [[{ stall: true }]] });
  setTimeout(() => controller.abort(), 10);
  const sleeps: number[] = [];
  await assert.rejects(
    agent.run("go", { signal: controller.signal, retry: { delaysMs: [1, 1], sleep: async ms => { sleeps.push(ms); } } }),
    (error: any) => error instanceof RunAbortedError && error.reason === "signal",
  );
  assert.deepEqual(sleeps, []);
  agent.dispose();
});

test("retry backs off after thrown errors and provider-error stops", async () => {
  const sleeps: number[] = [];
  const retries: number[] = [];
  const agent = scriptedAgent({
    script: [[{ throws: new Error("socket hang up") }], [{ providerError: "529 overloaded" }], [{ text: "ok" }]],
  });
  const result = await agent.run("go", {
    retry: { delaysMs: [100, 200, 400], sleep: async ms => { sleeps.push(ms); }, onRetry: info => retries.push(info.retry) },
  });
  assert.equal(result.text, "ok");
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
  assert.deepEqual(retries, [1, 2]);
  agent.dispose();
});

test("exhausted retries surface the last failure", async () => {
  const agent = scriptedAgent({ script: () => [{ providerError: "529 overloaded" }] });
  await assert.rejects(
    agent.run("go", { retry: { delaysMs: [1], sleep: async () => {} } }),
    (error: any) => error instanceof RunFailedError && error.result.errorMessage === "529 overloaded",
  );
  agent.dispose();

  const plain = scriptedAgent({ script: [[{ providerError: "529 overloaded" }]] });
  const result = await plain.run("go");
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "529 overloaded");
  plain.dispose();

  const notRetryable = scriptedAgent({ script: [[{ throws: new Error("401") }], [{ text: "never" }]] });
  await assert.rejects(notRetryable.run("go", { retry: { delaysMs: [1], isRetryable: () => false, sleep: async () => {} } }), /401/);
  notRetryable.dispose();
});

test("PiAgent reports model, busy state, usage, and replays buffered events", async () => {
  const listeners = new Set<(event: any) => void>();
  let release!: () => void;
  const session = {
    model: { provider: "anthropic", id: "claude-haiku-5-5" },
    messages: [] as any[],
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const listener of [...listeners]) listener({ type: "turn_start" });
      await new Promise<void>(resolve => { release = resolve; });
      const usage = (input: number, cost: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { total: cost } });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "toolUse", usage: usage(100, 0.01) });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: "b" }], stopReason: "stop", usage: usage(50, 0.02) });
    },
    async abort() {},
    dispose() {},
  };
  const agent = new PiAgent("chat", session as never, { eventBuffer: 2 });
  assert.equal(agent.model, "anthropic/claude-haiku-5-5");
  assert.equal(agent.isBusy, false);
  const running = agent.run("hi");
  assert.equal(agent.isBusy, true);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const result = await running;
  assert.equal(agent.isBusy, false);
  assert.equal(result.text, "b");
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.usage, { input: 150, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 170, costUsd: 0.03 });
  assert.equal(agent.messageCount, 2);

  const replayed: string[] = [];
  agent.subscribe(event => replayed.push(event.type), { replay: true });
  assert.deepEqual(replayed, ["turn_start"]);
  assert.equal(listeners.size, 2); // buffer + subscriber
  await agent.close();
  assert.equal(listeners.size, 0);
  assert.equal(agent.isDisposed, true);
});

test("formatEvent produces compact trace lines", () => {
  assert.equal(formatEvent({ type: "tool_execution_start", toolName: "submit", args: { a: 1 } } as any), 'tool_call submit args={"a":1}');
  assert.match(
    formatEvent({ type: "turn_end", message: { stopReason: "stop", content: [{ type: "text", text: "abc" }] } } as any)!,
    /^turn stop=stop text=3c thinking=0c$/,
  );
  assert.equal(formatEvent({ type: "message_update" } as any), undefined);
  assert.equal(clip("x".repeat(10), 4), "xxxx…(10 chars)");
});

test("checkModel rejects an unknown model without building an agent", async () => {
  await assert.rejects(checkModel("no-such-provider/no-such-model"));
});
