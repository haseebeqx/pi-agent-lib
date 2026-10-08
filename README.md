# pi-agent-lib

A deliberately small library that makes the [Pi SDK](https://pi.dev) easy to use for application agents.

It is not a new agent framework. Pi remains the engine; this package provides a small, opinionated application boundary around it.

## Why this exists

AI can generate a thin Pi wrapper quickly. The value of this package is not the amount of code it replaces; it is the shared contract and maintained set of decisions it provides:

- **A stable application API** so agent code is not coupled directly to session setup details.
- **Two deliberate operating modes**: isolated application agents and full Pi coding agents with normal resources and settings.
- **Lifecycle ownership** for sessions, cancellation, cleanup, shared model state, and one-shot agents.
- **Observability hooks** through session events, named agents, run results, and duration metadata, with runtime-level event routing for multi-agent applications.
- **Explicit capabilities**: tools and skills must be deliberately granted rather than discovered implicitly.
- **An incremental escape hatch** through the underlying Pi session when an application needs lower-level control.

If all you need is a few lines around `createAgentSession`, using Pi directly may be the better choice. This library is intended for applications that want consistent isolation, lifecycle behavior, observability hooks, and conventions across one or more agents without adopting a larger framework.

The package deliberately stays small. Its goal is not to hide Pi or accumulate orchestration features prematurely, but to turn recurring application-level decisions into a tested, documented interface.

## Install

```bash
npm install @haseebeqx/pi-agent-lib @earendil-works/pi-coding-agent
```

`@earendil-works/pi-coding-agent` is a peer dependency (requires `>=0.99.1`), so you control which
Pi version you run against — npm installs it automatically if it is not already in your project.

## Create an agent

```ts
import { agent, defineTool } from "@haseebeqx/pi-agent-lib";
import { Type } from "typebox";

const lookup = defineTool({
  name: "lookup",
  label: "Lookup",
  description: "Look up a topic",
  parameters: Type.Object({ topic: Type.String() }),
  async execute(_id, { topic }) {
    return {
      content: [{ type: "text", text: `Information about ${topic}` }],
      details: {},
    };
  },
});

const researcher = await agent({
  name: "researcher",
  instructions: "Research the user's topic and report evidence clearly.",
  tools: [lookup],
});

try {
  const result = await researcher.run("Research SQLite WAL mode");
  console.log(result.text);
} finally {
  researcher.dispose();
}
```

Pi selects the first authenticated model unless `model` or `modelId` is supplied.

## Coding agents

`codingAgent()` provides normal Pi coding-agent behavior programmatically. It loads Pi's global and project settings, extensions, skills, prompt templates, and `AGENTS.md` context; uses the standard coding prompt and tools; and appends your instructions to that prompt.

```ts
import { codingAgent } from "@haseebeqx/pi-agent-lib";

const coder = await codingAgent({
  instructions: "Make the requested code change and run focused tests.",
  cwd: process.cwd(),
  modelId: "openai/gpt-5.4",
  thinking: "high",
});
```

Custom application tools are added alongside Pi's built-in and extension tools:

```ts
const coder = await codingAgent({
  cwd: process.cwd(),
  instructions: "Finish by submitting the structured report.",
  tools: [submitReport],
  excludeTools: ["bash"],
});
```

Use `resources` to add resource paths or disable individual discovery categories. Advanced applications can inject `resourceLoader`, `settingsManager`, and `sessionManager` directly.

## Durable agents (experimental)

Use the optional `@haseebeqx/pi-agent-lib/durable` entry point for
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations that survive process restarts. The normal entry point does not load these dependencies.
The adapter supports versions `>1.0.0` and is tested against the latest durable dependencies;
it requires Node.js `>=22.19.0`.

```bash
npm install @earendil-works/pi-durable@latest @earendil-works/pi-ai@latest @earendil-works/chord@latest
```

```ts
import { durableAgent } from "@haseebeqx/pi-agent-lib/durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const models = createModels();
models.setProvider(openaiProvider()); // OPENAI_API_KEY
const researcher = await durableAgent({
  name: "researcher",
  storage: await openNodeSqliteStorage("./research.sqlite"),
  models,
  agent: {
    model: { provider: "openai", modelId: "gpt-5.4" },
    instructions: "Research the user's topic and report evidence clearly.",
  },
});

try {
  const result = await researcher.run("Research SQLite WAL mode", {
    requestId: "research-sqlite-1", // retrying this ID reuses the durable submission
  });
  console.log(result.text);
} finally {
  await researcher.dispose();
}
```

Reopening the same storage preserves the root conversation and its configuration, and resumes
unfinished work by default (`resume: false` disables automatic resume on open). `agent` supplies
initial configuration only; use `researcher.conversation.configure()` to change an existing agent.
Reinstall the same registry extensions and supply models on every open. One process must own a
storage at a time. The agent owns its harness and storage; always await `close()` or `dispose()`.
Closing preserves pending work; `abort()` explicitly stops it.

`submit()` returns a native durable submission for admission without waiting. `run()` waits for
that submission's answer and returns its text, answer messages, duration, and durable receipt.
An unanswered input throws `DurableRunError` with its receipt. Prompt options support `requestId`,
`whenBusy`, and a Chord `context`; cancelling a wait does not abort already admitted work.

This is a separate API, not an `AgentSession` or `SessionManager` adapter. Use native durable
`registry`, `settings`, and `env` options for tools and execution environments, and
`watchEvents()` for native durable events (stop the returned stream when finished).
Pi session tools, skills, resource discovery, and `AgentSessionEvent` callbacks are not translated.
The `harness` and `conversation` handles remain available for advanced control.
Supply models from the current pi-ai runtime; the older 0.99.1 runtime
used by existing session agents is not compatible with the durable model interface.

## Several agents

Use an agent runtime to share model setup, defaults, events, cancellation, and cleanup:

```ts
import { createAgentRuntime } from "@haseebeqx/pi-agent-lib";

const agents = await createAgentRuntime({
  modelId: "openai/gpt-5.4",
  thinking: "high",
  onEvent(name, event) {
    console.log(name, event.type);
  },
});

try {
  const plan = await agents.run({
    name: "planner",
    instructions: "Create a plan.",
  }, "Plan the requested change");

  const worker = await agents.agent({
    name: "worker",
    instructions: "Execute the supplied plan.",
    coreTools: ["read", "edit", "write", "bash"],
  });
  await worker.prompt(plan.text);
} finally {
  agents.dispose();
}
```

`agents.run()` is for one-shot work. `agents.agent()` creates a reusable session.

## Test and validate agents

`runAgentEvals()` runs black-box cases against a fresh agent each time, captures Pi tool/turn/retry traces, and separates agent failures from validation failures. Repeated runs and pass-rate thresholds make nondeterministic behavior explicit instead of hiding it in a single green run.

```ts
import {
  agentValidator,
  assertAgentEvals,
  codingAgent,
  noToolErrors,
  runAgentEvals,
  toolCalled,
} from "@haseebeqx/pi-agent-lib";
import { access } from "node:fs/promises";

const report = await runAgentEvals({
  name: "fixer smoke tests",
  runs: 3,
  minimumPassRate: 2 / 3,
  timeoutMs: 10 * 60_000,
  createAgent: ({ runIndex }) => codingAgent({
    cwd: fixtureDirectories[runIndex], // prepare one isolated fixture per run
    instructions: "Make the requested change and verify it.",
  }),
  cases: [{
    name: "writes the required report",
    prompt: "Diagnose the fixture and write report.json.",
    validators: [
      toolCalled("read"),
      noToolErrors(),
      agentValidator("report exists", async ({ runIndex }) => {
        try {
          await access(`${fixtureDirectories[runIndex]}/report.json`);
          return true;
        } catch {
          return "report.json was not created";
        }
      }),
    ],
  }],
});

assertAgentEvals(report); // throws a CI-friendly summary when the threshold fails
```

Validators receive the final `RunResult` and an `AgentRunTrace`, so applications can check output, tool arguments/results, artifacts, test commands, profiler evidence, or domain-specific mechanical gates. Built-ins include `outputIncludes`, `outputMatches`, `toolCalled`, `noToolErrors`, and `durationAtMost`. Validator exceptions are recorded as failed checks rather than losing the rest of the report. `PiAgent` satisfies the small `AgentEvalTarget` contract directly; larger application pipelines can expose the same `run`/optional lifecycle interface. Set `concurrency` only when cases use independent fixtures; the fixture-safe default is one.

This layer deliberately does not force an LLM judge or a sandbox vendor. A validator may call a judge model when semantic grading is appropriate, while deterministic tests and application-owned isolation remain first-class.

## Isolated application agents

`agent()` remains isolated by default for backward compatibility. It does not discover global or repository-local Pi resources, and built-in tools remain explicit. `isolatedAgent()` is the descriptive alias:

```ts
import { isolatedAgent } from "@haseebeqx/pi-agent-lib";

const researcher = await isolatedAgent({
  instructions: "Research the supplied topic.",
  coreTools: ["read"],
  skills: [researchSkill],
});
```

You can also select behavior with `mode: "coding" | "isolated"`.

## Existing Pi applications

`PiAgent` intentionally provides `prompt()`, `subscribe()`, `abort()`, and `dispose()` so existing Pi SDK code can adopt the library incrementally. The underlying session remains available as `agent.session` as an escape hatch.

## Scope

The library focuses on:

- isolated application agents and full Pi coding agents
- normal Pi resource discovery with application instructions appended
- custom resource, settings, and session manager injection
- explicit and extension-provided tools and skills
- shared model runtime and model selection
- event subscription and useful run results
- shared multi-agent defaults and cleanup

Deployment, TUI integration, and multi-agent supervision remain outside the package until real applications demonstrate a repeated need. The evaluation API stays intentionally runner-agnostic: sandbox and fixture ownership belong to the application.
