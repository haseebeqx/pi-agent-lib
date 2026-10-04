import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  watchEvents,
  type AgentChange,
  type Conversation,
  type ConversationAbortOptions,
  type HarnessOptions,
  type InputSubmissionDraft,
  type SettledSubmissionRecord,
  type Storage,
  type Submission,
} from "@earendil-works/pi-durable";
import type { RunResult } from "./types.js";

export interface DurableAgentOptions extends Omit<HarnessOptions, "registry"> {
  name?: string;
  /** Ownership transfers to the harness; closing the agent closes this storage. */
  storage: Storage;
  registry?: HarnessOptions["registry"];
  /** Initial root configuration. Reopening preserves the stored configuration. */
  agent?: AgentChange;
  context?: Context;
  /** Resume unfinished work on open. Defaults to true. */
  resume?: boolean;
}

export interface DurablePromptOptions {
  requestId?: string;
  whenBusy?: InputSubmissionDraft["whenBusy"];
  /** Cancels admission/waiting, not already admitted durable work. Use abort() to stop work. */
  context?: Context;
}

export interface DurableRunResult extends RunResult {
  submission: SettledSubmissionRecord;
}

/** An input ended without an answer. Its durable receipt remains available for inspection. */
export class DurableRunError extends Error {
  constructor(readonly submission: SettledSubmissionRecord) {
    super(`Durable submission ${submission.id} was unanswered: ${submission.reason ?? "unknown"}`);
    this.name = "DurableRunError";
  }
}

/** Durable conversations are not AgentSessions; use their native handles for advanced operations. */
export class DurableAgent {
  private closing?: Promise<void>;

  constructor(
    readonly name: string,
    readonly harness: Harness,
    readonly conversation: Conversation,
  ) {}

  submit(text: string, options: DurablePromptOptions = {}): Promise<Submission> {
    this.assertActive();
    return this.conversation.submit({
      type: "input",
      content: text,
      requestId: options.requestId,
      whenBusy: options.whenBusy,
    }, options.context ?? BACKGROUND_CONTEXT);
  }

  async run(text: string, options: DurablePromptOptions = {}): Promise<DurableRunResult> {
    const started = performance.now();
    const context = options.context ?? BACKGROUND_CONTEXT;
    const submission = await (await this.submit(text, options)).wait(context);
    if (submission.status !== "done" || submission.type !== "input") {
      throw new DurableRunError(submission);
    }
    // Read this submission's answer, not the latest transcript entry: queued runs may overlap.
    const answer = await this.conversation.commit(tx => tx.entry(AssistantEntry, submission.answer), context);
    if (!answer) throw new Error(`Durable answer ${submission.answer} is missing`);
    const messages = answer.model ?? [];
    const textParts: string[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "text") textParts.push(part.text);
      }
    }
    return {
      text: textParts.join(""),
      messages,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      submission,
    };
  }

  async prompt(text: string, options?: DurablePromptOptions): Promise<void> {
    await this.run(text, options);
  }

  /** Native durable event stream, not AgentSessionEvent. Caller owns stopping the stream. */
  watchEvents(context: Context = BACKGROUND_CONTEXT) {
    this.assertActive();
    return watchEvents(this.harness, this.conversation.id, context);
  }

  abort(context: Context = BACKGROUND_CONTEXT, options?: ConversationAbortOptions): Promise<void> {
    if (this.closing) return this.closing;
    return this.conversation.abort(context, options);
  }

  /** Close without withdrawing pending work, so it can resume on reopen. */
  close(): Promise<void> {
    if (!this.closing) this.closing = this.harness.close(BACKGROUND_CONTEXT);
    return this.closing;
  }

  dispose(): Promise<void> {
    return this.close();
  }

  private assertActive(): void {
    if (this.closing) throw new Error(`Agent ${this.name} has been disposed`);
  }
}

export async function createDurableAgent(options: DurableAgentOptions): Promise<DurableAgent> {
  const { storage, name, agent, context = BACKGROUND_CONTEXT, resume = true, registry, ...host } = options;
  const harness = await Harness.open(storage, { ...host, registry: registry ?? createRegistry() }, context);
  try {
    const conversation = await harness.root(context, { agent });
    if (resume) harness.resume();
    return new DurableAgent(name ?? "agent", harness, conversation);
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}

export const durableAgent = createDurableAgent;
