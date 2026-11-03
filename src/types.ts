import type {
  AgentSessionEvent,
  InlineExtension,
  ModelRuntime,
  PromptOptions,
  ResourceLoader,
  SessionManager,
  SettingsManager,
  Skill,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunTrace } from "./trace.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CoreToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface CodingResources {
  /** Additional extension files or directories, on top of normal Pi discovery. */
  extensions?: string[];
  /** Additional skill files or directories, on top of normal Pi discovery. */
  skills?: string[];
  /** Inline Pi extensions loaded with the discovered extensions. */
  extensionFactories?: InlineExtension[];
  /** Disable individual resource categories while retaining coding mode. */
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
}

export interface IsolatedResources {
  /** Inline Pi extensions loaded for isolated agents (no discovery). */
  extensionFactories?: InlineExtension[];
  /** Explicit extension file paths loaded for isolated agents (no discovery). */
  extensionPaths?: string[];
  /** Tool names or `*` patterns of extension-registered tools to enable. */
  extensionTools?: string[];
}

export interface AgentOptions {
  /** Name used in traces and diagnostics. */
  name?: string;
  /** `isolated` preserves the original application-agent behavior; `coding` loads normal Pi resources and defaults. */
  mode?: "isolated" | "coding";
  /** Complete system prompt in isolated mode; appended to Pi's coding prompt in coding mode. */
  instructions: string;
  /** Working directory used by coding tools and coding-mode resource discovery. */
  cwd?: string;
  /** Pi tools created with defineTool(). */
  tools?: any[];
  /** Explicit built-in Pi tools. No built-ins are enabled by default in isolated mode. */
  coreTools?: CoreToolName[];
  /** Tools to remove after coding-mode defaults and extension tools are loaded. */
  excludeTools?: string[];
  /** Explicit Pi skills. Isolated mode exposes only these; coding mode adds them to discovered skills. */
  skills?: Skill[];
  /** Normal Pi resource discovery options for coding mode. */
  resources?: CodingResources;
  /** Explicit extensions and tool enablement for isolated mode only (coding mode already has `resources`). */
  isolatedResources?: IsolatedResources;
  /** Fully custom Pi resource loader. Takes precedence over mode-based resource construction. */
  resourceLoader?: ResourceLoader;
  /** Pi settings manager. Coding mode otherwise loads project/global settings. */
  settingsManager?: SettingsManager;
  /** Pi session manager. Defaults to in-memory; pass SessionManager.create(cwd) for persistence. */
  sessionManager?: SessionManager;
  /** Pi agent configuration directory used by coding mode. */
  agentDir?: string;
  /** Existing model runtime to share across agents. */
  runtime?: ModelRuntime;
  /** Resolved Pi model object. */
  model?: any;
  /** Provider/model selector, such as openai/gpt-5.4. */
  modelId?: string;
  thinking?: ThinkingLevel;
  /** Pi's own automatic provider retries (short delays). See RunOptions.retry for longer application backoff. */
  retries?: number;
  onEvent?: (event: AgentSessionEvent) => void;
  /** Receives one compact line per notable event (turns, tool calls, tool errors, provider retries). */
  trace?: (line: string) => void;
  /** Keep the last N session events so late subscribers can replay them with subscribe(listener, { replay: true }). */
  eventBuffer?: number;
}

/** Per-attempt guards. Pi's agent loop has no turn cap, so a looping or stalled model must be stopped explicitly. */
export interface RunLimits {
  /** Abort before turn N+1 starts. */
  maxTurns?: number;
  /** Abort when tool call N+1 (any tool) starts. */
  maxToolCalls?: number;
  /** Abort when call N+1 of the named tool starts. */
  maxToolCallsPerTool?: Record<string, number>;
  /** Abort when the attempt has not finished within this many milliseconds. */
  timeoutMs?: number;
}

export interface RetryInfo {
  /** 1-based retry number about to happen. */
  retry: number;
  delayMs: number;
  error: unknown;
}

/**
 * Application-level backoff on top of Pi's own short provider retries. A retry
 * re-sends the same prompt in the same session. Limit aborts (RunAbortedError)
 * are never retried.
 */
export interface RetryOptions {
  /** Wait before each retry; its length is the number of retries. */
  delaysMs: readonly number[];
  /** Return false to fail immediately. Default: every error except RunAbortedError. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: RetryInfo) => void;
  /** Test seam. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions extends PromptOptions, RunLimits {
  /** Abort the run from outside. */
  signal?: AbortSignal;
  retry?: RetryOptions;
  /**
   * Throw RunFailedError when the final assistant turn ended with a provider
   * error (after Pi's own retries). Default false: the run resolves with
   * stopReason "error". Implied while retry is set, so errors can be retried.
   */
  throwOnError?: boolean;
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export interface RunResult {
  text: string;
  messages: readonly unknown[];
  durationMs: number;
  /** Turns, tool calls, and retries observed during the run (all attempts). */
  trace?: AgentRunTrace;
  /** Stop reason of the last assistant message, such as stop, error, or aborted. */
  stopReason?: string;
  /** Provider error of the last assistant message, when stopReason is error. */
  errorMessage?: string;
  /** Token and cost totals summed over the run's assistant messages. */
  usage?: RunUsage;
  /** provider/model-id of the session when the run finished. */
  model?: string;
  /** Number of attempts, including application-level retries. */
  attempts?: number;
}

export type { AgentSessionEvent, ModelRuntime, PromptOptions, ResourceLoader, SessionManager, SettingsManager, Skill };
