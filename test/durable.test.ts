import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { AssistantEntry, MemoryStorage, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  createDurableAgent,
  durableAgent,
  DurableAgent,
  DurableRunError,
  type DurableAgentOptions,
} from "../src/durable.js";

const context = BACKGROUND_CONTEXT;
const modelRef = { provider: "test", modelId: "offline" };
const model: Model<"openai-completions"> = {
  id: modelRef.modelId,
  provider: modelRef.provider,
  name: "Offline test model",
  api: "openai-completions",
  baseUrl: "http://unused.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// Implement only the Models methods used by durable generation. All scheduling,
// transactions, entries and receipts below still use the real Harness/storage.
function fakeModels(stopReason: "stop" | "error" = "stop") {
  const answers: AssistantMessage[] = [];
  const methods: Pick<DurableAgentOptions["models"], "getModel" | "streamSimple"> = {
    getModel(provider, id) {
      return provider === modelRef.provider && id === modelRef.modelId ? model : undefined;
    },
    streamSimple() {
      const number = answers.length + 1;
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "not answer text" },
          { type: "text", text: `answer ${number}` },
          { type: "text", text: "!" },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        ...(stopReason === "error" ? { errorMessage: "offline failure" } : {}),
        timestamp: Date.now(),
      };
      answers.push(message);
      const events = createAssistantMessageEventStream();
      if (stopReason === "error") events.push({ type: "error", reason: "error", error: message });
      else events.push({ type: "done", reason: "stop", message });
      events.end();
      return events;
    },
  };
  return { models: methods as DurableAgentOptions["models"], answers };
}

const testOptions = { timeout: 10_000 };

test("durable run returns its answer text, answer-only messages and durable receipt", testOptions, async t => {
  const fake = fakeModels();
  const agent = await createDurableAgent({
    name: "offline", storage: new MemoryStorage(), models: fake.models, agent: { model: modelRef },
  });
  t.after(() => agent.close());
  assert.equal(agent.name, "offline");
  const result = await agent.run("first", { requestId: "first" });
  assert.equal(result.text, "answer 1!");
  assert.deepEqual(result.messages, [fake.answers[0]]);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(result.submission.status, "done");
  assert.equal(result.submission.type, "input");
  assert.equal(result.submission.requestId, "first");
  assert.equal(result.submission.conversationId, agent.conversation.id);
  assert.ok(result.submission.entry);
  assert.ok(result.submission.answer);
  const stored = await agent.conversation.commit(tx => tx.entry(AssistantEntry, result.submission.answer!), context);
  assert.deepEqual(result.messages, stored?.model);

  const second = await agent.run("second");
  assert.equal(second.text, "answer 2!");
  assert.deepEqual(second.messages, [fake.answers[1]]);
  // A retry of an older receipt must not read the newest transcript answer.
  const replay = await agent.run("first", { requestId: "first" });
  assert.deepEqual(replay.submission, result.submission);
  assert.deepEqual(replay.messages, result.messages);
  assert.equal(replay.text, result.text);
  assert.equal(fake.answers.length, 2);
});

test("requestId deduplicates admission before settlement and prompt awaits an answer", testOptions, async t => {
  const fake = fakeModels();
  const agent = await durableAgent({
    storage: new MemoryStorage(), models: fake.models, agent: { model: modelRef }, resume: false,
  });
  t.after(() => agent.dispose());
  assert.equal(agent.name, "agent");
  assert.equal(durableAgent, createDurableAgent);
  const first = await agent.submit("once", { requestId: "same" });
  const duplicate = await agent.submit("once", { requestId: "same" });
  assert.equal(first.id, duplicate.id);
  assert.equal(fake.answers.length, 0);
  agent.harness.resume();
  assert.deepEqual(await first.wait(context), await duplicate.wait(context));
  assert.equal(fake.answers.length, 1);
  assert.equal(await agent.prompt("next"), undefined);
  assert.equal(fake.answers.length, 2);
});

test("unanswered runs throw DurableRunError containing the stored receipt", testOptions, async t => {
  const fake = fakeModels("error");
  const agent = await createDurableAgent({
    storage: new MemoryStorage(), models: fake.models, agent: { model: modelRef },
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  });
  t.after(() => agent.close());
  let failure: DurableRunError | undefined;
  await assert.rejects(agent.run("fail", { requestId: "failure" }), error => {
    assert.ok(error instanceof DurableRunError);
    failure = error;
    assert.equal(error.name, "DurableRunError");
    assert.equal(error.submission.status, "unanswered");
    assert.equal(error.submission.reason, "model_error");
    assert.equal(error.submission.detail, "offline failure");
    assert.equal(error.submission.requestId, "failure");
    assert.match(error.message, /was unanswered: model_error/);
    return true;
  });
  const submission = await agent.submit("fail", { requestId: "failure" });
  assert.deepEqual(await submission.wait(context), failure!.submission);
  await assert.rejects(agent.prompt("fail", { requestId: "failure" }), DurableRunError);
  assert.equal(fake.answers.length, 1);
});

test("JSONL reopen preserves configuration and pending work, with opt-in/default resume", testOptions, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-durable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeModels();
  const initial = await createDurableAgent({
    storage: await openNodeJsonlStorage(directory, context), models: fake.models, resume: false,
    agent: { model: modelRef, instructions: "original", cwd: "/original" },
  });
  t.after(() => initial.close());
  await initial.conversation.configure({ instructions: "persisted", cwd: "/persisted" }, context);
  const pending = await initial.submit("survives close", { requestId: "persisted-input" });
  const pendingRecord = await pending.status(context);
  assert.notEqual(pendingRecord.status, "done");
  const conversationId = initial.conversation.id;
  await initial.close();
  assert.equal(fake.answers.length, 0);

  const paused = await createDurableAgent({
    storage: await openNodeJsonlStorage(directory, context), models: fake.models, resume: false,
    agent: { model: { provider: "wrong", modelId: "wrong" }, instructions: "replacement", cwd: "/wrong" },
  });
  t.after(() => paused.close());
  assert.equal(paused.conversation.id, conversationId);
  const configuration = await paused.conversation.agent(context);
  assert.deepEqual(configuration.model, modelRef);
  assert.equal(configuration.instructions, "persisted");
  assert.equal(configuration.cwd, "/persisted");
  const restored = await paused.submit("survives close", { requestId: "persisted-input" });
  assert.equal(restored.id, pending.id);
  assert.deepEqual(await restored.status(context), pendingRecord);
  assert.equal(fake.answers.length, 0);
  await paused.close();

  // Omitting resume resumes unfinished work without a fresh input admission.
  const reopened = await createDurableAgent({
    storage: await openNodeJsonlStorage(directory, context), models: fake.models,
  });
  t.after(() => reopened.close());
  const resumedSubmission = await reopened.harness.submission(pending.id, context);
  assert.ok(resumedSubmission);
  const receipt = await resumedSubmission.wait(context);
  assert.equal(receipt.status, "done");
  assert.equal(fake.answers.length, 1);
  const replay = await reopened.run("survives close", { requestId: "persisted-input" });
  assert.equal(replay.submission.id, pending.id);
  assert.equal(replay.submission.status, "done");
  assert.equal(replay.text, "answer 1!");
  assert.equal(fake.answers.length, 1);
  const closing = reopened.close();
  assert.equal(reopened.close(), closing);
  assert.equal(reopened.dispose(), closing);
  await closing;
  assert.throws(() => reopened.submit("late"), /has been disposed/);
  await assert.rejects(reopened.run("late"), /has been disposed/);
  await assert.rejects(reopened.prompt("late"), /has been disposed/);
  assert.throws(() => reopened.watchEvents(), /has been disposed/);
  await reopened.abort();
});

test("close/dispose share asynchronous completion and guard immediately while closing", async () => {
  let finish!: () => void;
  let closes = 0;
  let aborts = 0;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const harness = {
    close(received: typeof context) {
      assert.equal(received, context);
      closes++;
      return completion;
    },
  } as unknown as Harness;
  const conversation = {
    async abort() { aborts++; },
  } as unknown as Conversation;
  const agent = new DurableAgent("closing", harness, conversation);
  await agent.abort();
  assert.equal(aborts, 1);
  const closing = agent.dispose();
  assert.equal(closing, completion);
  assert.equal(agent.close(), closing);
  assert.equal(agent.dispose(), closing);
  assert.equal(agent.abort(), closing);
  assert.equal(closes, 1);
  assert.equal(aborts, 1);
  let settled = false;
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.throws(() => agent.submit("late"), /Agent closing has been disposed/);
  assert.throws(() => agent.watchEvents(), /has been disposed/);
  await assert.rejects(agent.run("late"), /has been disposed/);
  await assert.rejects(agent.prompt("late"), /has been disposed/);
  finish();
  await closing;
  assert.equal(settled, true);
  assert.equal(agent.close(), closing);
  await agent.abort();
  assert.equal(closes, 1);
  assert.equal(aborts, 1);
});
