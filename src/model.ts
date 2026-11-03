import {
  ModelRuntime,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create();
}

let shared: Promise<ModelRuntime> | undefined;

/**
 * One model runtime per process, created on first use. Use it instead of
 * createModelRuntime() when many short-lived agents are built (for example a
 * fresh agent per item) so each does not reload models and credentials.
 * Pass `{ refresh: true }` to drop the cached runtime, such as after a login.
 */
export function sharedModelRuntime(options: { refresh?: boolean } = {}): Promise<ModelRuntime> {
  if (options.refresh || !shared) {
    const created = ModelRuntime.create();
    shared = created;
    created.catch(() => {
      if (shared === created) shared = undefined;
    });
  }
  return shared;
}

export function resolveModel(runtime: ModelRuntime, modelId?: string): any {
  if (!modelId) return undefined;
  const resolved = resolveCliModel({ cliModel: modelId, modelRuntime: runtime });
  if (resolved.error) throw new Error(resolved.error);
  return resolved.model;
}

export interface ModelCheck {
  /** The resolved Pi model object. */
  model: any;
  /** provider/model-id. */
  label: string;
}

/**
 * Fail fast on a bad model selector or missing credentials without building
 * an agent or spending a model call. Throws with a readable message.
 */
export async function checkModel(modelId: string, runtime?: ModelRuntime): Promise<ModelCheck> {
  const modelRuntime = runtime ?? await sharedModelRuntime();
  const model = resolveModel(modelRuntime, modelId);
  if (!model) throw new Error(`Model "${modelId}" could not be resolved`);
  const provider: string = model.provider;
  const authenticated = modelRuntime.hasConfiguredAuth(provider) ||
    (await modelRuntime.checkAuth(provider)) !== undefined;
  if (!authenticated) {
    throw new Error(`No credentials for provider "${provider}" (model "${modelId}"). Log in with Pi or set the provider's API key.`);
  }
  return { model, label: `${provider}/${model.id}` };
}
