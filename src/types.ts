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
  retries?: number;
  onEvent?: (event: AgentSessionEvent) => void;
}

export interface RunResult {
  text: string;
  messages: readonly unknown[];
  durationMs: number;
}

export type { AgentSessionEvent, ModelRuntime, PromptOptions, ResourceLoader, SessionManager, SettingsManager, Skill };
