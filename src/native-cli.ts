#!/usr/bin/env node
import { spawn } from "node:child_process";
import { nativeBinary, nativeEnvironment } from "./native-binary.js";

const child = spawn(nativeBinary(), process.argv.slice(2), {
  stdio: "inherit",
  env: nativeEnvironment(),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`Could not launch the Rust ScriptFS binary: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
