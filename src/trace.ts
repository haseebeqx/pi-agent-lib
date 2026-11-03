import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AgentToolCallTrace {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError: boolean;
  durationMs?: number;
}

export interface AgentRunTrace {
  eventCounts: Record<string, number>;
  toolCalls: AgentToolCallTrace[];
  turns: number;
  /** Pi's own automatic provider retries (auto_retry_start events). */
  retries: number;
  /** Stop reason of the last assistant turn, such as stop, toolUse, error or aborted. */
  stopReason?: string;
  /** Provider error message of the last assistant turn, when it failed. */
  errorMessage?: string;
}

export function emptyTrace(): AgentRunTrace {
  return { eventCounts: {}, toolCalls: [], turns: 0, retries: 0 };
}

/** Build a listener that folds session events into a trace. */
export function createTraceCollector(trace: AgentRunTrace): (event: AgentSessionEvent) => void {
  const starts = new Map<string, { name: string; args: unknown; started: number }>();
  return event => {
    trace.eventCounts[event.type] = (trace.eventCounts[event.type] ?? 0) + 1;
    if (event.type === "turn_end") {
      trace.turns += 1;
      const message = (event as any).message;
      if (message?.role === "assistant") {
        trace.stopReason = message.stopReason;
        trace.errorMessage = message.errorMessage;
      }
    }
    if (event.type === "auto_retry_start") trace.retries += 1;
    if (event.type === "tool_execution_start") {
      starts.set(event.toolCallId, { name: event.toolName, args: event.args, started: performance.now() });
    }
    if (event.type === "tool_execution_end") {
      const start = starts.get(event.toolCallId);
      trace.toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        args: start?.args,
        result: event.result,
        isError: event.isError,
        durationMs: start ? roundMs(performance.now() - start.started) : undefined,
      });
      starts.delete(event.toolCallId);
    }
  };
}

/** Shorten any value to a single readable string of at most `max` characters. */
export function clip(value: unknown, max = 300): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
}

export interface FormatEventOptions {
  /** Maximum characters for tool arguments, results, and errors. Default 300. */
  clip?: number;
}

/**
 * Format the notable session events (turns, tool calls, tool errors, retries)
 * as one compact line each. Returns undefined for events not worth tracing.
 */
export function formatEvent(event: AgentSessionEvent, options: FormatEventOptions = {}): string | undefined {
  const max = options.clip ?? 300;
  const e = event as any;
  switch (event.type) {
    case "tool_execution_start":
      return `tool_call ${e.toolName} args=${clip(e.args, max)}`;
    case "tool_execution_end":
      return `tool_result ${e.toolName} error=${Boolean(e.isError)} result=${clip(toolResultText(e.result), max)}`;
    case "turn_end": {
      const message = e.message ?? {};
      const parts: any[] = Array.isArray(message.content) ? message.content : [];
      const length = (type: string) => parts
        .filter(part => part?.type === type)
        .reduce((total, part) => total + String(part.text ?? part.thinking ?? "").length, 0);
      return `turn stop=${message.stopReason ?? "?"} text=${length("text")}c thinking=${length("thinking")}c` +
        (message.errorMessage ? ` error=${clip(message.errorMessage, max)}` : "");
    }
    case "auto_retry_start":
      return `provider_retry ${e.attempt}/${e.maxAttempts} in ${Math.round(e.delayMs / 1000)}s: ${clip(e.errorMessage, max)}`;
    default:
      return undefined;
  }
}

function toolResultText(result: any): unknown {
  if (Array.isArray(result?.content)) {
    const text = result.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("");
    if (text) return text;
  }
  return result;
}

export function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
