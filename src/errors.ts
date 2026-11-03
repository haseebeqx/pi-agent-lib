import type { RunResult } from "./types.js";

export type RunAbortReason = "max_turns" | "max_tool_calls" | "timeout" | "signal";

/**
 * A run stopped by one of its own limits (turns, tool calls, timeout) or by
 * its abort signal. Distinguishes "we stopped it" from a provider failure.
 * Never retried by RunOptions.retry.
 */
export class RunAbortedError extends Error {
  readonly reason: RunAbortReason;
  /** What the run produced before it was stopped. */
  result?: RunResult;

  constructor(reason: RunAbortReason, message: string, result?: RunResult) {
    super(message);
    this.name = "RunAbortedError";
    this.reason = reason;
    this.result = result;
  }
}

/** The final assistant turn ended with a provider error (after Pi's own retries). */
export class RunFailedError extends Error {
  readonly result: RunResult;

  constructor(result: RunResult) {
    super(`Agent run failed: ${result.errorMessage ?? "provider error"}`);
    this.name = "RunFailedError";
    this.result = result;
  }
}

/** A run with an output tool finished every attempt without a valid output. */
export class OutputError extends Error {
  readonly toolName: string;
  readonly attempts: number;
  /** Calls of the output tool in the last attempt (valid and rejected). */
  readonly calls: number;
  /** Validation messages of rejected calls in the last attempt. */
  readonly rejections: readonly string[];
  /** Result of the last attempt, when it produced one. */
  readonly result?: RunResult;
  readonly cause?: unknown;

  constructor(options: {
    toolName: string;
    attempts: number;
    calls: number;
    rejections: readonly string[];
    result?: RunResult;
    cause?: unknown;
  }) {
    const reason = options.cause instanceof Error
      ? options.cause.message
      : options.rejections.length > 0
        ? `last rejection: ${options.rejections[options.rejections.length - 1]}`
        : `${options.toolName} was not called`;
    const trace = options.result?.trace;
    const summary = trace
      ? ` [last attempt: ${trace.turns} turn(s), ${trace.toolCalls.length} tool call(s), ${options.calls} ${options.toolName} call(s), stop=${trace.stopReason ?? "?"}]`
      : "";
    super(`No valid ${options.toolName} output after ${options.attempts} attempt(s): ${reason}${summary}`);
    this.name = "OutputError";
    this.toolName = options.toolName;
    this.attempts = options.attempts;
    this.calls = options.calls;
    this.rejections = options.rejections;
    this.result = options.result;
    this.cause = options.cause;
  }
}
