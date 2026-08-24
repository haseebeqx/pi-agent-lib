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
import { codingResourceLoader, isolatedResourceLoader } from "./resource-loader.js";
import type { AgentOptions, RunResult } from "./types.js";

/** A small lifecycle-safe wrapper around one Pi AgentSession. */
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
  const mode = options.mode ?? "isolated";
  const settingsManager = options.settingsManager ?? (mode === "coding"
    ? SettingsManager.create(cwd, options.agentDir)
    : SettingsManager.inMemory());
  if (options.retries !== undefined || mode === "isolated") {
    const retries = options.retries ?? 3;
    settingsManager.applyOverrides({ retry: { enabled: retries > 0, maxRetries: retries } });
  }
  const resourceLoader = options.resourceLoader ?? (mode === "coding"
    ? await codingResourceLoader({
        cwd,
        instructions: options.instructions,
        agentDir: options.agentDir,
        settingsManager,
        resources: options.resources,
        skills: options.skills,
      })
    : isolatedResourceLoader(options.instructions, options.skills));
  const selectedTools = options.coreTools === undefined && mode === "coding"
    ? undefined
    : [...(options.coreTools ?? []), ...customTools.map(tool => tool.name)];

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

  if (options.onEvent) session.subscribe(options.onEvent);
  return new PiAgent(options.name ?? "agent", session);
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
