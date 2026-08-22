import type {
  AgentSessionEvent,
  ModelRuntime,
  PromptOptions,
  Skill,
} from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CoreToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface AgentOptions {
  /** Name used in traces and diagnostics. */
  name?: string;
  /** The complete system prompt. Ambient Pi resources are disabled by default. */
  instructions: string;
  /** Working directory used by coding tools. */
  cwd?: string;
  /** Pi tools created with defineTool(). */
  tools?: any[];
  /** Explicit built-in Pi tools. No built-ins are enabled by default. */
  coreTools?: CoreToolName[];
  /** Explicit Pi skills. Global and project skills are not discovered. */
  skills?: Skill[];
  /** Existing model runtime to share across agents. */
  runtime?: ModelRuntime;
  /** Resolved Pi model object. */
  model?: any;
  /** Provider/model selector, such as openai/gpt-5.4. */
  modelId?: string;
  thinking?: ThinkingLevel;
  retries?: number;
  onEvent?: (event: AgentSessionEvent) => void;
}

export interface RunResult {
  text: string;
  messages: readonly unknown[];
  durationMs: number;
}

export type { AgentSessionEvent, ModelRuntime, PromptOptions, Skill };
