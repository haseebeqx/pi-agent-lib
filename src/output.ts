import { defineTool } from "@earendil-works/pi-coding-agent";
import { OutputError, RunAbortedError } from "./errors.js";
import type { RunOptions, RunResult } from "./types.js";

export interface OutputToolOptions<T> {
  /** Tool name the model calls, such as submit_judgment. */
  name: string;
  label?: string;
  description?: string;
  /** JSON Schema or TypeBox schema of the tool arguments. */
  parameters: any;
  /**
   * Turn raw arguments into the typed output; throw to reject them. The
   * error message goes back to the model as a tool error so it can correct
   * itself in the same run. A zod schema's `parse` works directly.
   */
  validate?: (value: unknown) => T;
  /** Tool reply to the first valid call. */
  acceptedMessage?: string;
  /** Tool reply to every later valid call (the latest valid call wins). */
  repeatedMessage?: string;
}

/**
 * A structured-output tool and the slot it fills. Create one per agent and
 * register `tool` in the agent's tools. Not safe to share across agents that
 * run concurrently.
 */
export interface OutputTool<T> {
  readonly name: string;
  /** The Pi tool to pass in AgentOptions.tools. */
  readonly tool: ReturnType<typeof defineTool>;
  /** Latest valid output since the last reset(). */
  readonly value: T | undefined;
  readonly hasValue: boolean;
  /** Calls since the last reset(), valid and rejected. */
  readonly calls: number;
  /** Validation messages of rejected calls since the last reset(). */
  readonly rejections: readonly string[];
  reset(): void;
}

export function outputTool<T = unknown>(options: OutputToolOptions<T>): OutputTool<T> {
  let value: T | undefined;
  let hasValue = false;
  let calls = 0;
  let rejections: string[] = [];
  const accepted = options.acceptedMessage ?? "Recorded. Nothing else is needed.";
  const repeated = options.repeatedMessage ??
    `Already recorded. STOP: do not call ${options.name} or any other tool again. End your turn now.`;

  const tool = defineTool({
    name: options.name,
    label: options.label ?? options.name,
    description: options.description ?? `Submit the final structured result. Call this exactly once.`,
    parameters: options.parameters,
    async execute(_toolCallId: string, args: unknown) {
      calls += 1;
      let validated: T;
      try {
        validated = options.validate ? options.validate(args) : args as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejections.push(message);
        throw new Error(`Invalid ${options.name} arguments: ${message}. Fix them and call ${options.name} again.`);
      }
      const wasRecorded = hasValue;
      value = validated;
      hasValue = true;
      return { content: [{ type: "text" as const, text: wasRecorded ? repeated : accepted }], details: undefined };
    },
  } as any);

  return {
    name: options.name,
    tool,
    get value() { return value; },
    get hasValue() { return hasValue; },
    get calls() { return calls; },
    get rejections() { return rejections; },
    reset() {
      value = undefined;
      hasValue = false;
      calls = 0;
      rejections = [];
    },
  };
}

export interface OutputRunOptions extends RunOptions {
  /** Prompt sent when an attempt ends without a valid output. Default names the tool. */
  nudge?: string;
  /** Nudge attempts after the first. Default 1 (two attempts total). */
  maxNudges?: number;
  /**
   * Valid-or-rejected calls of the output tool allowed per attempt before the
   * attempt is aborted (a looping model). Default 3. A valid output already
   * recorded is kept when the limit trips.
   */
  maxOutputCalls?: number;
}

export interface OutputRunResult<T> extends RunResult {
  output: T;
  /** Attempts used, including nudges. */
  outputAttempts: number;
}

/** Minimal agent surface runForOutput needs; PiAgent satisfies it. */
export interface OutputRunTarget {
  run(text: string, options?: RunOptions): Promise<RunResult>;
}

/**
 * Run a prompt until the model submits a valid output through `output`'s
 * tool. Each attempt is one run() with the given limits; an attempt without
 * a valid output is followed by a nudge in the same session. A limit abort
 * keeps an already recorded valid output. Provider errors are not nudged:
 * they propagate (after RunOptions.retry, when set).
 */
export async function runForOutput<T>(
  agent: OutputRunTarget,
  prompt: string,
  output: OutputTool<T>,
  options: OutputRunOptions = {},
): Promise<OutputRunResult<T>> {
  const { nudge, maxNudges = 1, maxOutputCalls = 3, ...runOptions } = options;
  const attempts = maxNudges + 1;
  const nudgeText = nudge ?? `You did not submit a valid result. Call ${output.name} exactly once with valid arguments.`;
  const limits = {
    ...runOptions,
    maxToolCallsPerTool: { [output.name]: maxOutputCalls, ...runOptions.maxToolCallsPerTool },
  };
  let lastResult: RunResult | undefined;
  let lastAbort: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    output.reset();
    lastAbort = undefined;
    let result: RunResult | undefined;
    try {
      result = await agent.run(attempt === 1 ? prompt : nudgeText, limits);
    } catch (error) {
      if (!(error instanceof RunAbortedError)) throw error;
      if (error.reason === "signal") throw error;
      result = error.result;
      lastAbort = error;
    }
    lastResult = result;
    if (output.hasValue) {
      const base: RunResult = result ?? { text: "", messages: [], durationMs: 0 };
      return { ...base, output: output.value as T, outputAttempts: attempt };
    }
  }
  throw new OutputError({
    toolName: output.name,
    attempts,
    calls: output.calls,
    rejections: output.rejections,
    result: lastResult,
    cause: lastAbort,
  });
}
