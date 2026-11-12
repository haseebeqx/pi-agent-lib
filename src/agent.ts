import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model.js";
import { codingResourceLoader, isolatedResourceLoader, isolatedResourceLoaderWithExtensions } from "./resource-loader.js";
import { RunAbortedError, RunFailedError, type RunAbortReason } from "./errors.js";
import { runForOutput, type OutputRunOptions, type OutputRunResult, type OutputTool } from "./output.js";
import { createTraceCollector, emptyTrace, formatEvent, roundMs } from "./trace.js";
import type { AgentOptions, RunLimits, RunOptions, RunResult, RunUsage } from "./types.js";

/** A small lifecycle-safe wrapper around one Pi AgentSession. */
export class PiAgent {
  readonly name: string;
  readonly session: AgentSession;
  private disposed = false;
  private active = 0;
  private readonly unsubscribers = new Set<() => void>();
  private readonly buffer: AgentSessionEvent[] = [];
  private readonly bufferSize: number;

  constructor(name: string, session: AgentSession, options: { eventBuffer?: number } = {}) {
    this.name = name;
    this.session = session;
    this.bufferSize = options.eventBuffer ?? 0;
    if (this.bufferSize > 0) {
      this.unsubscribers.add(session.subscribe(event => {
        this.buffer.push(event);
        if (this.buffer.length > this.bufferSize) this.buffer.shift();
      }));
    }
  }

  /** provider/model-id of the session's current model, when one is selected. */
  get model(): string | undefined {
    return modelLabel((this.session as any).model);
  }

  /** True while a prompt or run is in flight. */
  get isBusy(): boolean {
    return this.active > 0 || Boolean((this.session as any).isStreaming);
  }

  /** Messages in the session history. */
  get messageCount(): number {
    return this.session.messages?.length ?? 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Pi-compatible prompt method for incremental adoption in existing projects. */
  prompt(text: string, options?: PromptOptions): Promise<void> {
    this.assertActive();
    this.active += 1;
    let pending: Promise<void>;
    try {
      pending = this.session.prompt(text, options);
    } catch (error) {
      this.active -= 1;
      throw error;
    }
    return pending.finally(() => { this.active -= 1; });
  }

  /**
   * Run a prompt and return the useful result instead of Promise<void>.
   * Limits apply per attempt; `retry` re-sends the prompt after a thrown
   * error or a provider-error stop.
   */
  async run(text: string, options: RunOptions = {}): Promise<RunResult> {
    this.assertActive();
    const {
      signal, retry, throwOnError, maxTurns, maxToolCalls, maxToolCallsPerTool, timeoutMs, ...promptOptions
    } = options;
    const limits: RunLimits = { maxTurns, maxToolCalls, maxToolCallsPerTool, timeoutMs };
    const started = performance.now();
    const firstMessage = this.session.messages.length;
    const trace = emptyTrace();
    const stopTrace = this.session.subscribe(createTraceCollector(trace));
    const finish = (attempts: number): RunResult => {
      const messages = this.session.messages.slice(firstMessage);
      const last = lastAssistant(messages);
      return {
        text: lastAssistantText(messages),
        messages,
        durationMs: roundMs(performance.now() - started),
        trace,
        stopReason: last?.stopReason,
        errorMessage: last?.errorMessage,
        usage: sumUsage(messages),
        model: this.model,
        attempts,
      };
    };
    this.active += 1;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.attempt(text, promptOptions, limits, signal);
          const result = finish(attempt);
          if ((throwOnError || retry) && result.stopReason === "error") throw new RunFailedError(result);
          return result;
        } catch (error) {
          if (error instanceof RunAbortedError) {
            error.result = finish(attempt);
            throw error;
          }
          const retryable = retry?.isRetryable ?? (() => true);
          if (!retry || attempt > retry.delaysMs.length || signal?.aborted || !retryable(error)) throw error;
          const delayMs = retry.delaysMs[attempt - 1];
          retry.onRetry?.({ retry: attempt, delayMs, error });
          await (retry.sleep ?? sleep)(delayMs);
          if (signal?.aborted) throw new RunAbortedError("signal", "Agent run aborted by signal", finish(attempt));
          this.assertActive();
        }
      }
    } finally {
      stopTrace();
      this.active -= 1;
    }
  }

  /** Run until the model submits a valid output through an outputTool() registered on this agent. */
  runForOutput<T>(text: string, output: OutputTool<T>, options?: OutputRunOptions): Promise<OutputRunResult<T>> {
    return runForOutput(this, text, output, options);
  }

  /**
   * Subscribe to session events. With `replay`, the buffered events
   * (AgentOptions.eventBuffer) are delivered first. Listeners are removed
   * automatically on dispose().
   */
  subscribe(listener: (event: AgentSessionEvent) => void, options: { replay?: boolean } = {}): () => void {
    this.assertActive();
    if (options.replay) for (const event of [...this.buffer]) listener(event);
    const unsubscribe = this.session.subscribe(listener);
    const remove = () => {
      if (!this.unsubscribers.delete(remove)) return;
      unsubscribe();
    };
    this.unsubscribers.add(remove);
    return remove;
  }

  /** Events kept by AgentOptions.eventBuffer, oldest first. */
  recentEvents(): readonly AgentSessionEvent[] {
    return [...this.buffer];
  }

  abort(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.session.abort();
  }

  /** Abort any in-flight work, remove listeners, and dispose the session. Idempotent; never throws. */
  async close(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.abort();
    } catch {
      // A failed abort must not prevent disposal.
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of [...this.unsubscribers]) {
      try {
        unsubscribe();
      } catch {
        // Continue releasing the rest.
      }
    }
    this.unsubscribers.clear();
    this.session.dispose();
  }

  private async attempt(text: string, options: PromptOptions, limits: RunLimits, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RunAbortedError("signal", "Agent run aborted by signal");
    let tripped: { reason: RunAbortReason; message: string } | undefined;
    let onTripped: (() => void) | undefined;
    const trippedPromise = new Promise<void>(resolve => { onTripped = resolve; });
    const trip = (reason: RunAbortReason, message: string) => {
      if (tripped) return;
      tripped = { reason, message };
      // Give abort() a grace period to settle the prompt; a stalled stream must not hang the run.
      Promise.resolve()
        .then(() => this.session.abort())
        .catch(() => undefined)
        .then(() => setTimeout(() => onTripped?.(), ABORT_GRACE_MS).unref?.());
    };
    let turns = 0;
    let toolCalls = 0;
    const perTool = new Map<string, number>();
    const guarded = limits.maxTurns !== undefined || limits.maxToolCalls !== undefined || limits.maxToolCallsPerTool !== undefined;
    const stopGuard = guarded ? this.session.subscribe(event => {
      if (event.type === "turn_start") {
        turns += 1;
        if (limits.maxTurns !== undefined && turns > limits.maxTurns) {
          trip("max_turns", `Agent run reached ${limits.maxTurns} turns without finishing`);
        }
      }
      if (event.type === "tool_execution_start") {
        toolCalls += 1;
        const count = (perTool.get(event.toolName) ?? 0) + 1;
        perTool.set(event.toolName, count);
        const toolMax = limits.maxToolCallsPerTool?.[event.toolName];
        if (toolMax !== undefined && count > toolMax) {
          trip("max_tool_calls", `Agent called ${event.toolName} ${count} times in one run (limit ${toolMax})`);
        } else if (limits.maxToolCalls !== undefined && toolCalls > limits.maxToolCalls) {
          trip("max_tool_calls", `Agent made ${toolCalls} tool calls in one run (limit ${limits.maxToolCalls})`);
        }
      }
    }) : undefined;
    const timer = limits.timeoutMs !== undefined
      ? setTimeout(() => trip("timeout", `Agent run did not finish within ${limits.timeoutMs}ms`), limits.timeoutMs)
      : undefined;
    const onAbort = () => trip("signal", "Agent run aborted by signal");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([this.session.prompt(text, options), trippedPromise]);
    } catch (error) {
      if (!tripped) throw error;
    } finally {
      stopGuard?.();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (tripped) throw new RunAbortedError(tripped.reason, tripped.message);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`Agent ${this.name} has been disposed`);
  }
}

const ABORT_GRACE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Format a Pi model object (or selector string) as provider/model-id. */
export function modelLabel(model: any): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  const id = model.id ?? model.modelId ?? model.name;
  if (!id) return undefined;
  return model.provider ? `${model.provider}/${id}` : String(id);
}

/**
 * Settings for isolated agents: in-memory, so no project settings, tools or
 * session state leak into the agent - but the default model saved in the
 * user's own Pi settings is inherited, so an agent built without a modelId
 * runs the same model Pi itself would pick. Without this the session falls
 * back to the first model with valid credentials, which may be a billed API
 * model the user no longer uses.
 */
export function isolatedSettingsManager(cwd: string, agentDir?: string): SettingsManager {
  const settings = SettingsManager.inMemory();
  try {
    const user = SettingsManager.create(cwd, agentDir);
    const global = user.getGlobalSettings();
    const overrides: Record<string, string | undefined> = {};
    if (global.defaultProvider) overrides.defaultProvider = global.defaultProvider;
    if (global.defaultModel) overrides.defaultModel = global.defaultModel;
    if (Object.keys(overrides).length > 0) {
      settings.applyOverrides(overrides as Parameters<SettingsManager["applyOverrides"]>[0]);
    }
  } catch {
    // unreadable settings: leave the session's own model fallback in place
  }
  return settings;
}

export async function createAgent(options: AgentOptions): Promise<PiAgent> {
  const cwd = options.cwd ?? process.cwd();
  const runtime = options.runtime ?? await ModelRuntime.create();
  const model = options.model ?? resolveModel(runtime, options.modelId);
  const customTools = options.tools ?? [];
  const mode = options.mode ?? "isolated";
  const settingsManager = options.settingsManager ?? (mode === "coding"
    ? SettingsManager.create(cwd, options.agentDir)
    : isolatedSettingsManager(cwd, options.agentDir));
  if (options.retries !== undefined || mode === "isolated") {
    const retries = options.retries ?? 3;
    settingsManager.applyOverrides({ retry: { enabled: retries > 0, maxRetries: retries } });
  }
  const isolatedResources = mode === "isolated" ? options.isolatedResources : undefined;
  const resourceLoader = options.resourceLoader ?? (mode === "coding"
    ? await codingResourceLoader({
        cwd,
        instructions: options.instructions,
        agentDir: options.agentDir,
        settingsManager,
        resources: options.resources,
        skills: options.skills,
      })
    : isolatedResources && (isolatedResources.extensionFactories?.length || isolatedResources.extensionPaths?.length)
      ? await isolatedResourceLoaderWithExtensions({
          cwd,
          instructions: options.instructions,
          skills: options.skills,
          agentDir: options.agentDir,
          settingsManager,
          resources: isolatedResources,
        })
      : isolatedResourceLoader(options.instructions, options.skills));
  const extensionTools = mode === "isolated" ? (options.isolatedResources?.extensionTools ?? []) : [];
  const selectedTools = options.coreTools === undefined && mode === "coding"
    ? undefined
    : [...(options.coreTools ?? []), ...customTools.map(tool => tool.name), ...extensionTools];

  const { session } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: options.thinking ?? (mode === "isolated" ? "medium" : undefined),
    resourceLoader,
    tools: selectedTools as any,
    excludeTools: options.excludeTools,
    customTools,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    settingsManager,
  });

  const instance = new PiAgent(options.name ?? "agent", session, { eventBuffer: options.eventBuffer });
  if (options.onEvent) instance.subscribe(options.onEvent);
  if (options.trace) {
    const trace = options.trace;
    instance.subscribe(event => {
      const line = formatEvent(event);
      if (line) trace(line);
    });
  }
  return instance;
}

/** Short alias for createAgent(). */
export const agent = createAgent;

/** Create an agent with normal Pi coding resources, settings, prompt, and tool defaults. */
export function codingAgent(options: AgentOptions): Promise<PiAgent> {
  return createAgent({ ...options, mode: "coding" });
}

/** Create an agent with only explicitly supplied instructions, skills, and tools. */
export function isolatedAgent(options: AgentOptions): Promise<PiAgent> {
  return createAgent({ ...options, mode: "isolated" });
}

function lastAssistant(messages: readonly any[]): any {
  return [...messages].reverse().find(item => item?.role === "assistant");
}

function sumUsage(messages: readonly any[]): RunUsage | undefined {
  let total: RunUsage | undefined;
  for (const message of messages) {
    const usage = message?.role === "assistant" ? message.usage : undefined;
    if (!usage) continue;
    total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    total.costUsd += usage.cost?.total ?? 0;
  }
  return total;
}

function lastAssistantText(messages: readonly any[]): string {
  const message = lastAssistant(messages);
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}
