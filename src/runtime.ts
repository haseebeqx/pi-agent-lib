import { ModelRuntime, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgent, PiAgent } from "./agent.js";
import { resolveModel } from "./model.js";
import type { AgentOptions, RunResult, ThinkingLevel } from "./types.js";

export interface AgentRuntimeOptions {
  model?: any;
  modelId?: string;
  thinking?: ThinkingLevel;
  retries?: number;
  cwd?: string;
  onEvent?: (agentName: string, event: AgentSessionEvent) => void;
}

export type RuntimeAgentOptions = Omit<AgentOptions, "runtime">;

/** Shared defaults and model state for applications that create several agents. */
export class AgentRuntime {
  readonly modelRuntime: ModelRuntime;
  private readonly agents = new Set<PiAgent>();

  private constructor(
    modelRuntime: ModelRuntime,
    private readonly options: AgentRuntimeOptions,
    private readonly defaultModel: any,
  ) {
    this.modelRuntime = modelRuntime;
  }

  static async create(options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
    const modelRuntime = await ModelRuntime.create();
    const defaultModel = options.model ?? resolveModel(modelRuntime, options.modelId);
    return new AgentRuntime(modelRuntime, options, defaultModel);
  }

  async agent(options: RuntimeAgentOptions): Promise<PiAgent> {
    const name = options.name ?? "agent";
    const instance = await createAgent({
      ...options,
      name,
      cwd: options.cwd ?? this.options.cwd,
      runtime: this.modelRuntime,
      model: options.model ?? (options.modelId ? undefined : this.defaultModel),
      modelId: options.modelId,
      thinking: options.thinking ?? this.options.thinking,
      retries: options.retries ?? this.options.retries,
      onEvent: event => {
        this.options.onEvent?.(name, event);
        options.onEvent?.(event);
      },
    });
    this.agents.add(instance);
    return instance;
  }

  /** Create, run, and dispose a one-shot agent. */
  async run(options: RuntimeAgentOptions, prompt: string): Promise<RunResult> {
    const instance = await this.agent(options);
    try {
      return await instance.run(prompt);
    } finally {
      instance.dispose();
      this.agents.delete(instance);
    }
  }

  async abort(): Promise<void> {
    await Promise.allSettled([...this.agents].map(agent => agent.abort()));
  }

  dispose(): void {
    for (const agent of this.agents) agent.dispose();
    this.agents.clear();
  }
}

export const createAgentRuntime = AgentRuntime.create;
