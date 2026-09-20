import path from "node:path";
import picomatch from "picomatch";
import type { HideRule, OverlayRule, ProviderRule } from "../types.js";

export interface CompiledProviderRule {
  rule: ProviderRule;
  matches(path: string): boolean;
  root: string;
  exposeRoot: boolean;
}

export interface CompiledRules {
  providers: CompiledProviderRule[];
  hidden(path: string): boolean;
}

export function normalizeVirtualPath(input: string): string {
  if (input.split("/").includes("..")) {
    throw new Error(`Invalid virtual path: ${input}`);
  }
  const normalized = path.posix.normalize(`/${input}`).slice(1);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Invalid virtual path: ${input}`);
  }
  return normalized;
}

export function compileRules(rules: readonly OverlayRule[]): CompiledRules {
  const hideMatchers = rules
    .filter((rule): rule is HideRule => "hide" in rule)
    .map((rule) => picomatch(normalizeVirtualPath(rule.match), { dot: true }));

  const providers = rules
    .filter((rule): rule is ProviderRule => "provider" in rule)
    .map((rule) => {
      const match = normalizeVirtualPath(rule.match);
      const root = normalizeVirtualPath(rule.root ?? staticPrefix(match));
      const matcher = picomatch(match, { dot: true });
      return {
        rule,
        matches: (candidate: string) =>
          matcher(candidate) || (rule.root !== undefined && candidate === root),
        root,
        exposeRoot: rule.root !== undefined || rule.opaque === true,
      };
    });

  return {
    providers,
    hidden: (candidate) => {
      const normalized = normalizeVirtualPath(candidate);
      return hideMatchers.some((matches) => matches(normalized));
    },
  };
}

export function rootChildForDirectory(
  root: string,
  directory: string,
): string | undefined {
  const normalizedRoot = normalizeVirtualPath(root);
  const normalizedDirectory = normalizeVirtualPath(directory);
  const relative = path.posix.relative(normalizedDirectory, normalizedRoot);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split("/")[0];
}

export function staticChildForDirectory(
  pattern: string,
  directory: string,
): string | undefined {
  const normalizedPattern = normalizeVirtualPath(pattern);
  const patternDirectory = path.posix.dirname(normalizedPattern);
  const parentPattern = patternDirectory === "." ? "" : patternDirectory;
  const child = path.posix.basename(normalizedPattern);
  const scanned = picomatch.scan(child, { nonegate: true });
  if (scanned.isGlob || picomatch.scan(normalizedPattern).negated) {
    return undefined;
  }

  const normalizedDirectory = normalizeVirtualPath(directory);
  return (
    parentPattern === ""
      ? normalizedDirectory === ""
      : picomatch(parentPattern, { dot: true })(normalizedDirectory)
  )
    ? unescapeLiteral(scanned.base)
    : undefined;
}

function staticPrefix(pattern: string): string {
  const scanned = picomatch.scan(pattern);
  if (scanned.negated) return "";
  const base = unescapeLiteral(scanned.base);
  return scanned.isGlob ? base : path.posix.dirname(base);
}

function unescapeLiteral(pattern: string): string {
  // scan's unescape option also removes escaped literal backslashes.
  return pattern.replace(/\\(.)/gs, "$1");
}
