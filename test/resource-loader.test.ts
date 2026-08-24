import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { codingResourceLoader, isolatedResourceLoader } from "../src/resource-loader.js";

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
