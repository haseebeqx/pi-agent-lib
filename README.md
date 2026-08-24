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
npm install @haseebeqx/pi-agent-lib
```

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

Deployment, TUI integration, multi-agent supervision, and an evaluation framework should be added only after real applications demonstrate a repeated need.
