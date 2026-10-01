#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { ScriptFsStartupError, startScriptFs } from "./runtime/podman.js";
import { checkPodman } from "./runtime/podman-check.js";
import type { ScriptFsSession } from "./types.js";

const configPath = process.argv[2];
if (
  !configPath ||
  process.argv.includes("--help") ||
  process.argv.includes("-h")
) {
  console.log("Usage: scriptfs /path/to/config.json\n       scriptfs --check");
  process.exit(configPath ? 0 : 1);
}

const abortController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => abortController.abort());
}

let session: ScriptFsSession | undefined;
let failure: unknown;
try {
  if (configPath === "--check") {
    await checkPodman(abortController.signal);
    console.log("Podman is installed and its Linux runtime is ready.");
  } else {
    const config = await loadConfig(configPath);
    await checkPodman(abortController.signal);
    session = await startScriptFs(config, {
      signal: abortController.signal,
    });
    for (const [name, mountPoint] of session.mounts) {
      console.log(`${name}: ${mountPoint}`);
    }
    console.log("scriptfs is running; press Ctrl+C to stop");

    await waitForSession(session, abortController.signal);
  }
} catch (error) {
  failure = error;
  if (error instanceof ScriptFsStartupError) {
    session = error.session;
  }
} finally {
  if (session) {
    await stopUntilComplete(session);
  }
}

if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
}

async function waitForSession(
  session: ScriptFsSession,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const keepAlive = setInterval(() => undefined, 60_000);
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      session.wait(),
    ]);
  } finally {
    clearInterval(keepAlive);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function stopUntilComplete(session: ScriptFsSession): Promise<void> {
  for (;;) {
    try {
      await session.stop();
      return;
    } catch (error) {
      console.error(
        `Cleanup failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
