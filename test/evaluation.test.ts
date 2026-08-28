import assert from "node:assert/strict";
import test from "node:test";
import { PiAgent } from "../src/agent.js";
import {
  agentValidator,
  assertAgentEvals,
  noToolErrors,
  outputIncludes,
  runAgentEvals,
  toolCalled,
} from "../src/evaluation.js";

function fakeAgent(runIndex: number, options: { toolError?: boolean; delayMs?: number } = {}): PiAgent {
  const listeners = new Set<(event: any) => void>();
  const emit = (event: any) => listeners.forEach(listener => listener(event));
  const session = {
    messages: [] as any[],
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
      emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "inspect", args: { runIndex } });
      emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "inspect", result: { ok: true }, isError: options.toolError ?? false });
      const message = { role: "assistant", content: [{ type: "text", text: runIndex === 0 ? "validated" : "try again" }] };
      this.messages.push(message);
      emit({ type: "turn_end", turnIndex: 0, message, toolResults: [] });
      emit({ type: "message_end", message });
    },
    async abort() {},
    dispose() {},
  };
  return new PiAgent("fake", session as never);
}

test("runAgentEvals repeats isolated runs, captures traces, and applies a pass-rate threshold", async () => {
  const report = await runAgentEvals({
    name: "smoke",
    runs: 2,
    minimumPassRate: 0.5,
    createAgent: ({ runIndex }) => fakeAgent(runIndex),
    cases: [{
      name: "inspection",
      prompt: ({ runIndex }) => `inspect run ${runIndex}`,
      validators: [outputIncludes("validated"), toolCalled("inspect"), noToolErrors()],
    }],
  });

  assert.equal(report.passed, true);
  assert.equal(report.cases[0].passedRuns, 1);
  assert.equal(report.cases[0].passRate, 0.5);
  assert.equal(report.cases[0].attempts[0].trace.turns, 1);
  assert.deepEqual(report.cases[0].attempts[0].trace.toolCalls[0].args, { runIndex: 0 });
  assert.doesNotThrow(() => assertAgentEvals(report));
});

test("validator exceptions and tool failures become useful failed reports", async () => {
  const report = await runAgentEvals({
    createAgent: ({ runIndex }) => fakeAgent(runIndex, { toolError: true }),
    cases: [{
      name: "failure",
      prompt: "work",
      validators: [
        noToolErrors(),
        agentValidator("mechanical check", () => { throw new Error("artifact missing"); }),
      ],
    }],
  });

  assert.equal(report.passed, false);
  assert.match(report.cases[0].attempts[0].validations[0].message ?? "", /inspect/);
  assert.match(report.cases[0].attempts[0].validations[1].message ?? "", /artifact missing/);
  assert.throws(() => assertAgentEvals(report), /failure: 0\/1 passed.*artifact missing/s);
});

test("run timeouts fail the attempt and abort safely", async () => {
  const report = await runAgentEvals({
    timeoutMs: 5,
    createAgent: ({ runIndex }) => fakeAgent(runIndex, { delayMs: 30 }),
    cases: [{ name: "bounded", prompt: "work", validators: [] }],
  });

  assert.equal(report.passed, false);
  assert.match(report.cases[0].attempts[0].error ?? "", /timed out after 5ms/);
});

test("invalid suites are rejected before agents run", async () => {
  await assert.rejects(() => runAgentEvals({
    concurrency: 0,
    createAgent: ({ runIndex }) => fakeAgent(runIndex),
    cases: [{ name: "case", prompt: "work", validators: [] }],
  }), /concurrency must be a positive integer/);
});
