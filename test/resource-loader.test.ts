import assert from "node:assert/strict";
import test from "node:test";
import { isolatedResourceLoader } from "../src/resource-loader.js";

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
