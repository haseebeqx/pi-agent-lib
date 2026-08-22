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
import { isolatedResourceLoader } from "./resource-loader.js";
import type { AgentOptions, RunResult } from "./types.js";

/** A small lifecycle-safe wrapper around one isolated Pi AgentSession. */
export class PiAgent {
  readonly name: string;
  readonly session: AgentSession;
  private disposed = false;

  constructor(name: string, session: AgentSession) {
    this.name = name;
    this.session = session;
  }

  /** Pi-compatible prompt method for incremental adoption in existing projects. */
  prompt(text: string, options?: PromptOptions): Promise<void> {
    this.assertActive();
    return this.session.prompt(text, options);
  }

  /** Run a prompt and return the useful result instead of Promise<void>. */
  async run(text: string, options?: PromptOptions): Promise<RunResult> {
    this.assertActive();
    const started = performance.now();
    const firstMessage = this.session.messages.length;
    await this.session.prompt(text, options);
    const messages = this.session.messages.slice(firstMessage);
    return {
      text: lastAssistantText(messages),
      messages,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.assertActive();
    return this.session.subscribe(listener);
  }

  abort(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.session.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`Agent ${this.name} has been disposed`);
  }
}

export async function createAgent(options: AgentOptions): Promise<PiAgent> {
  const cwd = options.cwd ?? process.cwd();
  const runtime = options.runtime ?? await ModelRuntime.create();
  const model = options.model ?? resolveModel(runtime, options.modelId);
  const customTools = options.tools ?? [];
  const coreTools = options.coreTools ?? [];
  const resourceLoader = isolatedResourceLoader(options.instructions, options.skills);

  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: options.thinking ?? "medium",
    resourceLoader,
    tools: [...coreTools, ...customTools.map(tool => tool.name)] as any,
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: (options.retries ?? 3) > 0, maxRetries: options.retries ?? 3 },
    }),
  });

  if (options.onEvent) session.subscribe(options.onEvent);
  return new PiAgent(options.name ?? "agent", session);
}

/** Short alias for createAgent(). */
export const agent = createAgent;

function lastAssistantText(messages: readonly any[]): string {
  const message = [...messages].reverse().find(item => item?.role === "assistant");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}
