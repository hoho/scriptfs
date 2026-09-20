import type { NodeMetadata, ScriptFsProvider } from "./types.js";

export function defineProvider<Options = unknown, Handle = unknown>(
  provider: ScriptFsProvider<Options, Handle>,
): ScriptFsProvider<Options, Handle> {
  return provider;
}

export function fileMetadata(
  overrides: Omit<Partial<NodeMetadata>, "kind"> = {},
): NodeMetadata {
  return {
    kind: "file",
    mode: 0o644,
    ...overrides,
  };
}

export function directoryMetadata(
  overrides: Omit<Partial<NodeMetadata>, "kind"> = {},
): NodeMetadata {
  return {
    kind: "directory",
    mode: 0o755,
    ...overrides,
  };
}
