import { PiAgent } from "./agent.js";

/** One scripted model action within a run. */
export type ScriptStep =
  /** A turn in which the model calls a tool; the real tool's execute() runs. */
  | { tool: string; args: unknown }
  /** A turn in which the model replies with text and stops. */
  | { text: string }
  /** A turn that ends with a provider error (stopReason "error"). */
  | { providerError: string }
  /** session.prompt() throws, like a network or auth failure. */
  | { throws: unknown }
  /** A stalled model: waits until the run is aborted (to exercise timeouts). */
  | { stall: true };

export interface ScriptContext {
  prompt: string;
  /** 0-based index of the prompt/run on this agent. */
  runIndex: number;
}

export interface ScriptedAgentOptions {
  name?: string;
  /** Tools the script may call, usually the same ones the real agent gets. */
  tools?: any[];
  /** Steps per run, in order, or a function choosing them from the prompt. */
  script: ScriptStep[][] | ((context: ScriptContext) => ScriptStep[]);
  /** Session events to retain for subscribe(listener, { replay: true }). */
  eventBuffer?: number;
}

/**
 * A PiAgent backed by a scripted session instead of a model: deterministic
 * tests and offline stubs that call the real tools' execute() exactly as the
 * model would, emit the same session events, and honor run limits, retries,
 * and output tools.
 */
export class ScriptedAgent extends PiAgent {
  /** Every prompt text received, in order (including nudges and retries). */
  readonly prompts: string[];

  constructor(options: ScriptedAgentOptions) {
    const prompts: string[] = [];
    super(options.name ?? "scripted", createScriptedSession(options, prompts) as never, { eventBuffer: options.eventBuffer });
    this.prompts = prompts;
  }
}

export function scriptedAgent(options: ScriptedAgentOptions): ScriptedAgent {
  return new ScriptedAgent(options);
}

function createScriptedSession(options: ScriptedAgentOptions, prompts: string[]) {
  const listeners = new Set<(event: any) => void>();
  const tools = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event);
  };
  let aborted = false;
  let wakeStalled: (() => void) | undefined;
  let callId = 0;

  const session = {
    messages: [] as any[],
    model: { provider: "scripted", id: options.name ?? "scripted" },
    isStreaming: false,
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async abort() {
      aborted = true;
      wakeStalled?.();
    },
    dispose() {
      listeners.clear();
    },
    getActiveToolNames() {
      return [...tools.keys()];
    },
    async prompt(text: string) {
      const runIndex = prompts.length;
      prompts.push(text);
      const steps = typeof options.script === "function"
        ? options.script({ prompt: text, runIndex })
        : options.script[runIndex];
      if (!steps) throw new Error(`Scripted agent has no script for run ${runIndex + 1}`);
      aborted = false;
      session.isStreaming = true;
      session.messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      emit({ type: "agent_start" });
      try {
        let ended = false;
        for (const step of steps) {
          if (aborted) break;
          if ("throws" in step) throw step.throws;
          emit({ type: "turn_start" });
          if ("stall" in step) {
            await new Promise<void>(resolve => {
              wakeStalled = resolve;
              if (aborted) resolve();
            });
            wakeStalled = undefined;
            endTurn({ role: "assistant", content: [], stopReason: "aborted" }, []);
            ended = true;
            break;
          }
          if ("text" in step) {
            endTurn({ role: "assistant", content: [{ type: "text", text: step.text }], stopReason: "stop" }, []);
            ended = true;
            break;
          }
          if ("providerError" in step) {
            endTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: step.providerError }, []);
            ended = true;
            break;
          }
          const id = `call_${++callId}`;
          const assistant = {
            role: "assistant",
            content: [{ type: "toolCall", id, name: step.tool, arguments: step.args }],
            stopReason: "toolUse",
          };
          session.messages.push(assistant);
          emit({ type: "tool_execution_start", toolCallId: id, toolName: step.tool, args: step.args });
          const tool = tools.get(step.tool);
          let result: any;
          let isError = false;
          try {
            if (!tool) throw new Error(`Tool ${step.tool} not found`);
            result = await tool.execute(id, step.args, undefined, undefined, undefined);
          } catch (error) {
            isError = true;
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
          }
          emit({ type: "tool_execution_end", toolCallId: id, toolName: step.tool, result, isError });
          const toolResult = { role: "toolResult", toolCallId: id, toolName: step.tool, content: result?.content ?? [], isError };
          session.messages.push(toolResult);
          emit({ type: "turn_end", message: assistant, toolResults: [toolResult] });
        }
        if (aborted && !ended) {
          endTurn({ role: "assistant", content: [], stopReason: "aborted" }, []);
        } else if (!ended) {
          emit({ type: "turn_start" });
          endTurn({ role: "assistant", content: [], stopReason: "stop" }, []);
        }
      } finally {
        session.isStreaming = false;
        emit({ type: "agent_end", messages: [] });
      }
    },
  };

  function endTurn(message: any, toolResults: any[]) {
    session.messages.push(message);
    emit({ type: "message_end", message });
    emit({ type: "turn_end", message, toolResults });
  }

  return session;
}
