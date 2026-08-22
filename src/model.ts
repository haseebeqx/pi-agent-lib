import {
  ModelRuntime,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create();
}

export function resolveModel(runtime: ModelRuntime, modelId?: string): any {
  if (!modelId) return undefined;
  const resolved = resolveCliModel({ cliModel: modelId, modelRuntime: runtime });
  if (resolved.error) throw new Error(resolved.error);
  return resolved.model;
}
