import {
  createExtensionRuntime,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

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
