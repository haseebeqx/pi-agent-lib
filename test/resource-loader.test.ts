import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { codingResourceLoader, isolatedResourceLoader, isolatedResourceLoaderWithExtensions } from "../src/resource-loader.js";

test("isolated loader exposes only explicit instructions and skills", () => {
  const skill = {
    name: "research",
    description: "Research carefully",
    filePath: "/tmp/research/SKILL.md",
    baseDir: "/tmp/research",
    sourceInfo: {
      path: "/tmp/research/SKILL.md",
      source: "custom",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  } as const;
  const loader = isolatedResourceLoader("You are a researcher.", [skill]);

  assert.equal(loader.getSystemPrompt(), "You are a researcher.");
  assert.deepEqual(loader.getSkills().skills, [skill]);
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
});

test("isolated loader with explicit extensions loads exactly those and nothing discovered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-lib-"));
  const agentDir = path.join(root, "agent");
  try {
    // A discovery-location extension that must NOT be loaded in isolated mode.
    await mkdir(path.join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(root, ".pi", "extensions", "stray.ts"),
      "export default (pi) => { pi.registerTool({ name: 'stray_tool', label: 'Stray', description: 'd', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'no' }] }) }); }\n",
    );
    const explicit = path.join(root, "explicit.ts");
    await writeFile(
      explicit,
      "export default (pi) => { pi.registerTool({ name: 'explicit_tool', label: 'Explicit', description: 'd', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'yes' }] }) }); }\n",
    );
    const loader = await isolatedResourceLoaderWithExtensions({
      cwd: root,
      agentDir,
      instructions: "You are a researcher.",
      settingsManager: SettingsManager.inMemory(),
      resources: {
        extensionFactories: [(pi: any) => {
          pi.registerTool({ name: "inline_tool", label: "Inline", description: "d", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
        }],
        extensionPaths: [explicit],
        extensionTools: ["inline_tool", "explicit_tool"],
      },
    });

    const extensions = loader.getExtensions();
    assert.equal(extensions.extensions.length, 2);
    assert.deepEqual(extensions.errors, []);
    assert.equal(loader.getSystemPrompt(), "You are a researcher.");
    assert.equal(loader.getSystemPromptSource(), undefined);
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.deepEqual(loader.getAppendSystemPromptSources(), []);
    assert.deepEqual(loader.getSkills().skills, []);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding loader discovers Pi context and appends application instructions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-lib-"));
  const agentDir = path.join(root, "agent");
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Project conventions\n\nRun focused tests.\n");
    const loader = await codingResourceLoader({
      cwd: root,
      agentDir,
      instructions: "Verify the change before finishing.",
      settingsManager: SettingsManager.inMemory(),
      resources: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
    });

    assert.match(loader.getAgentsFiles().agentsFiles[0]?.content ?? "", /Project conventions/);
    assert.deepEqual(loader.getAppendSystemPrompt(), ["Verify the change before finishing."]);
    assert.equal(loader.getSystemPrompt(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
