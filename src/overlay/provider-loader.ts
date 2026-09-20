import { pathToFileURL } from "node:url";
import type { ProviderReference, ScriptFsProvider } from "../types.js";
import { createProxyProvider } from "./proxy-provider.js";

export type ProviderLoader = (
  reference: ProviderReference,
) => Promise<ScriptFsProvider>;

export function createProviderLoader(): ProviderLoader {
  const cache = new Map<string, Promise<Record<string, unknown>>>();

  return async (reference) => {
    if (!("module" in reference)) {
      return createProxyProvider(reference);
    }
    const specifier = isFilePath(reference.module)
      ? pathToFileURL(reference.module).href
      : reference.module;
    let loaded = cache.get(specifier);
    if (!loaded) {
      loaded = import(specifier) as Promise<Record<string, unknown>>;
      cache.set(specifier, loaded);
    }

    const module = await loaded;
    const exportName = reference.export ?? "default";
    const provider = module[exportName];
    if (!provider || typeof provider !== "object") {
      throw new TypeError(
        `Provider export "${exportName}" from ${reference.module} is not an object`,
      );
    }
    return provider;
  };
}

function isFilePath(specifier: string): boolean {
  return specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier);
}
