import {
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  type SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { CodingResources } from "./types.js";

/**
 * Create a reproducible Pi resource loader. It never discovers user-global or
 * repository-local extensions, prompts, themes, context files, or skills.
 */
export function isolatedResourceLoader(instructions: string, skills: Skill[] = []): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** Build Pi's normal coding-agent resource loader and append application instructions to its prompt. */
export async function codingResourceLoader(options: {
  cwd: string;
  instructions: string;
  agentDir?: string;
  settingsManager: SettingsManager;
  resources?: CodingResources;
  skills?: Skill[];
}): Promise<DefaultResourceLoader> {
  const explicitSkills = options.skills ?? [];
  const resources = options.resources ?? {};
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager: options.settingsManager,
    additionalExtensionPaths: resources.extensions,
    additionalSkillPaths: resources.skills,
    extensionFactories: resources.extensionFactories,
    noExtensions: resources.noExtensions,
    noSkills: resources.noSkills,
    noPromptTemplates: resources.noPromptTemplates,
    noThemes: resources.noThemes,
    noContextFiles: resources.noContextFiles,
    appendSystemPrompt: options.instructions ? [options.instructions] : [],
    skillsOverride: explicitSkills.length
      ? current => ({ ...current, skills: [...current.skills, ...explicitSkills] })
      : undefined,
  });
  await loader.reload();
  return loader;
}
