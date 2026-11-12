import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, PiAgent, isolatedSettingsManager } from "../src/agent.js";

test("PiAgent returns text and messages from a run", async () => {
  const listeners = new Set<(event: any) => void>();
  const session = {
    messages: [] as any[],
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
      this.messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() {},
    dispose() {},
  };

  const agent = new PiAgent("test", session as never);
  const result = await agent.run("work");

  assert.equal(result.text, "done");
  assert.equal(result.messages.length, 1);
  const second = await agent.run("more work");
  assert.equal(second.messages.length, 1);
  agent.dispose();
  assert.throws(() => agent.prompt("again"), /has been disposed/);
});

test("isolated agent activates extension-registered tools only when named in extensionTools", async () => {
  const factory = (toolName: string) => (pi: any) => {
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: "test tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  };

  const enabled = await createAgent({
    instructions: "Test agent.",
    isolatedResources: {
      extensionFactories: [factory("probe_tool")],
      extensionTools: ["probe_tool"],
    },
  });
  assert.ok(enabled.session.getActiveToolNames().includes("probe_tool"));
  enabled.dispose();

  const unlisted = await createAgent({
    instructions: "Test agent.",
    isolatedResources: {
      extensionFactories: [factory("probe_tool")],
    },
  });
  assert.ok(!unlisted.session.getActiveToolNames().includes("probe_tool"));
  unlisted.dispose();

  const plain = await createAgent({ instructions: "Test agent." });
  assert.deepEqual(plain.session.getActiveToolNames(), []);
  plain.dispose();
});

test("isolatedSettingsManager inherits the user's saved default model from global settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-lib-settings-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "prov", defaultModel: "model-a" }),
  );
  // A project setting with a different default must not leak into the
  // isolated agent: only the user's global default is inherited.
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ defaultProvider: "prov", defaultModel: "model-b" }),
  );

  const settings = isolatedSettingsManager(cwd, agentDir);
  assert.equal(settings.getDefaultProvider(), "prov");
  assert.equal(settings.getDefaultModel(), "model-a");
});

test("isolatedSettingsManager has no default model when the user has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-lib-settings-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  mkdirSync(agentDir);
  mkdirSync(cwd);

  const settings = isolatedSettingsManager(cwd, agentDir);
  assert.equal(settings.getDefaultProvider(), undefined);
  assert.equal(settings.getDefaultModel(), undefined);
});
