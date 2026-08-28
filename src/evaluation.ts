import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunResult } from "./types.js";

/** Minimal structural contract; PiAgent satisfies it and applications may wrap a larger agent pipeline. */
export interface AgentEvalTarget {
  run(prompt: string): Promise<RunResult>;
  subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
  abort?(): Promise<void>;
  dispose?(): void;
}

export interface AgentEvalContext {
  caseName: string;
  runIndex: number;
}

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
  retries: number;
}

export interface AgentValidationContext extends AgentEvalContext {
  result: RunResult;
  trace: AgentRunTrace;
}

export interface ValidationResult {
  passed: boolean;
  message?: string;
  details?: unknown;
}

export type ValidationOutcome = boolean | string | ValidationResult | void;

export interface AgentValidator {
  name: string;
  validate(context: AgentValidationContext): ValidationOutcome | Promise<ValidationOutcome>;
}

export interface AgentEvalCase {
  name: string;
  prompt: string | ((context: AgentEvalContext) => string | Promise<string>);
  validators: AgentValidator[];
  /** Overrides the suite-level number of independent runs. */
  runs?: number;
  /** Overrides the suite-level required fraction of passing runs (0..1). */
  minimumPassRate?: number;
  timeoutMs?: number;
}

export interface AgentEvalOptions {
  name?: string;
  cases: AgentEvalCase[];
  /** A fresh agent must be returned for every case run. */
  createAgent(context: AgentEvalContext): AgentEvalTarget | Promise<AgentEvalTarget>;
  runs?: number;
  minimumPassRate?: number;
  /** Maximum independent case runs in flight. Defaults to one for fixture safety. */
  concurrency?: number;
  timeoutMs?: number;
  onRunComplete?: (attempt: AgentEvalAttempt) => void | Promise<void>;
}

export interface AgentValidationReport extends ValidationResult {
  name: string;
}

export interface AgentEvalAttempt extends AgentEvalContext {
  passed: boolean;
  durationMs: number;
  result?: RunResult;
  trace: AgentRunTrace;
  validations: AgentValidationReport[];
  error?: string;
}

export interface AgentEvalCaseReport {
  name: string;
  passed: boolean;
  runs: number;
  passedRuns: number;
  passRate: number;
  minimumPassRate: number;
  attempts: AgentEvalAttempt[];
}

export interface AgentEvalReport {
  name: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cases: AgentEvalCaseReport[];
}

/** Run repeatable black-box evaluations against fresh Pi agents. */
export async function runAgentEvals(options: AgentEvalOptions): Promise<AgentEvalReport> {
  validateOptions(options);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const jobs = options.cases.flatMap((testCase, caseIndex) =>
    Array.from({ length: testCase.runs ?? options.runs ?? 1 }, (_, runIndex) => ({ testCase, caseIndex, runIndex })),
  );
  const attempts = options.cases.map(() => [] as AgentEvalAttempt[]);
  let nextJob = 0;

  const worker = async () => {
    while (true) {
      const jobIndex = nextJob++;
      const job = jobs[jobIndex];
      if (!job) return;
      const attempt = await runAttempt(options, job.testCase, job.runIndex);
      attempts[job.caseIndex].push(attempt);
      await options.onRunComplete?.(attempt);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 1, jobs.length || 1) }, worker));

  const cases = options.cases.map((testCase, index): AgentEvalCaseReport => {
    const caseAttempts = attempts[index].sort((left, right) => left.runIndex - right.runIndex);
    const passedRuns = caseAttempts.filter(attempt => attempt.passed).length;
    const minimumPassRate = testCase.minimumPassRate ?? options.minimumPassRate ?? 1;
    const passRate = caseAttempts.length === 0 ? 0 : passedRuns / caseAttempts.length;
    return {
      name: testCase.name,
      passed: passRate >= minimumPassRate,
      runs: caseAttempts.length,
      passedRuns,
      passRate,
      minimumPassRate,
      attempts: caseAttempts,
    };
  });
  const finishedAt = new Date().toISOString();
  return {
    name: options.name ?? "agent evaluations",
    passed: cases.every(testCase => testCase.passed),
    startedAt,
    finishedAt,
    durationMs: roundMs(performance.now() - started),
    cases,
  };
}

/** Throw an assertion-style error containing all failed cases and checks. */
export function assertAgentEvals(report: AgentEvalReport): void {
  if (report.passed) return;
  const failures = report.cases.filter(testCase => !testCase.passed).map(testCase => {
    const attempts = testCase.attempts.filter(attempt => !attempt.passed).map(attempt => {
      const reasons = attempt.validations.filter(validation => !validation.passed)
        .map(validation => `${validation.name}${validation.message ? `: ${validation.message}` : ""}`);
      return `run ${attempt.runIndex + 1} (${reasons.join("; ") || attempt.error || "failed"})`;
    });
    return `${testCase.name}: ${testCase.passedRuns}/${testCase.runs} passed; ${attempts.join(", ")}`;
  });
  throw new Error(`Agent evaluation failed\n${failures.map(failure => `- ${failure}`).join("\n")}`);
}

/** Define a named deterministic or model-based validator. */
export function agentValidator(
  name: string,
  validate: AgentValidator["validate"],
): AgentValidator {
  return { name, validate };
}

export function outputIncludes(expected: string): AgentValidator {
  return agentValidator(`output includes ${JSON.stringify(expected)}`, ({ result }) =>
    result.text.includes(expected) || `Expected output to include ${JSON.stringify(expected)}`,
  );
}

export function outputMatches(expected: RegExp): AgentValidator {
  return agentValidator(`output matches ${expected}`, ({ result }) => {
    expected.lastIndex = 0;
    return expected.test(result.text) || `Expected output to match ${expected}`;
  });
}

export function toolCalled(name: string, options: { atLeast?: number; atMost?: number } = {}): AgentValidator {
  return agentValidator(`tool ${name} call count`, ({ trace }) => {
    const count = trace.toolCalls.filter(call => call.name === name).length;
    const atLeast = options.atLeast ?? 1;
    const atMost = options.atMost ?? Number.POSITIVE_INFINITY;
    return count >= atLeast && count <= atMost
      ? true
      : `Expected ${name} calls in ${atLeast}..${atMost === Number.POSITIVE_INFINITY ? "∞" : atMost}, received ${count}`;
  });
}

export function noToolErrors(): AgentValidator {
  return agentValidator("no tool errors", ({ trace }) => {
    const failed = trace.toolCalls.filter(call => call.isError);
    return failed.length === 0 || `Tool calls failed: ${failed.map(call => call.name).join(", ")}`;
  });
}

export function durationAtMost(maximumMs: number): AgentValidator {
  return agentValidator(`duration at most ${maximumMs}ms`, ({ result }) =>
    result.durationMs <= maximumMs || `Run took ${result.durationMs}ms`,
  );
}

async function runAttempt(options: AgentEvalOptions, testCase: AgentEvalCase, runIndex: number): Promise<AgentEvalAttempt> {
  const context = { caseName: testCase.name, runIndex };
  const started = performance.now();
  const trace = emptyTrace();
  let instance: AgentEvalTarget | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    instance = await options.createAgent(context);
    unsubscribe = instance.subscribe?.(createTraceCollector(trace));
    const prompt = typeof testCase.prompt === "function" ? await testCase.prompt(context) : testCase.prompt;
    const result = await runWithTimeout(instance, prompt, testCase.timeoutMs ?? options.timeoutMs);
    const validations: AgentValidationReport[] = [];
    for (const validator of testCase.validators) {
      try {
        const outcome = await validator.validate({ ...context, result, trace });
        validations.push(normalizeValidation(validator.name, outcome));
      } catch (error) {
        validations.push({ name: validator.name, passed: false, message: errorMessage(error) });
      }
    }
    return {
      ...context,
      passed: validations.every(validation => validation.passed),
      durationMs: roundMs(performance.now() - started),
      result,
      trace,
      validations,
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      ...context,
      passed: false,
      durationMs: roundMs(performance.now() - started),
      trace,
      validations: [{ name: "agent run", passed: false, message }],
      error: message,
    };
  } finally {
    unsubscribe?.();
    instance?.dispose?.();
  }
}

async function runWithTimeout(agent: AgentEvalTarget, prompt: string, timeoutMs?: number): Promise<RunResult> {
  if (timeoutMs === undefined) return agent.run(prompt);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void agent.abort?.().catch(() => {});
      reject(new Error(`Agent run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([agent.run(prompt), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createTraceCollector(trace: AgentRunTrace): (event: AgentSessionEvent) => void {
  const starts = new Map<string, { name: string; args: unknown; started: number }>();
  return event => {
    trace.eventCounts[event.type] = (trace.eventCounts[event.type] ?? 0) + 1;
    if (event.type === "turn_end") trace.turns += 1;
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

function normalizeValidation(name: string, outcome: ValidationOutcome): AgentValidationReport {
  if (outcome === undefined || outcome === true) return { name, passed: true };
  if (outcome === false) return { name, passed: false };
  if (typeof outcome === "string") return { name, passed: false, message: outcome };
  return { name, ...outcome };
}

function emptyTrace(): AgentRunTrace {
  return { eventCounts: {}, toolCalls: [], turns: 0, retries: 0 };
}

function validateOptions(options: AgentEvalOptions): void {
  if (options.cases.length === 0) throw new Error("Agent evaluations require at least one case");
  positiveInteger(options.runs ?? 1, "runs");
  positiveInteger(options.concurrency ?? 1, "concurrency");
  rate(options.minimumPassRate ?? 1, "minimumPassRate");
  const names = new Set<string>();
  for (const testCase of options.cases) {
    if (!testCase.name.trim()) throw new Error("Agent evaluation case names cannot be empty");
    if (names.has(testCase.name)) throw new Error(`Duplicate agent evaluation case: ${testCase.name}`);
    names.add(testCase.name);
    positiveInteger(testCase.runs ?? 1, `${testCase.name}.runs`);
    rate(testCase.minimumPassRate ?? 1, `${testCase.name}.minimumPassRate`);
    if (testCase.timeoutMs !== undefined && testCase.timeoutMs <= 0) throw new Error(`${testCase.name}.timeoutMs must be positive`);
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function rate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
