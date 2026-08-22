import assert from "node:assert/strict";
import test from "node:test";
import { PiAgent } from "../src/agent.js";

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
