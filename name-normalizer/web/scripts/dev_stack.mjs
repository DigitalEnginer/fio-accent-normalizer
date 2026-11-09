import { spawn } from "node:child_process";
import { resolve } from "node:path";

const children = new Set();

function start(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stopAll() {
  for (const child of children) child.kill();
}

process.once("SIGINT", () => {
  stopAll();
  process.exit(130);
});
process.once("SIGTERM", () => {
  stopAll();
  process.exit(143);
});
process.once("exit", stopAll);

const proxy = start(process.execPath, [
  resolve("scripts/openai_proxy_server.mjs"),
]);

for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:8767/health");
    if (response.ok) break;
  } catch {
    // The proxy normally becomes ready within a few iterations.
  }
  if (proxy.exitCode !== null) throw new Error("OPENAI_PROXY_START_FAILED");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

const web = start(process.execPath, [
  resolve("node_modules/vinext/dist/cli.js"),
  "dev",
]);

web.once("exit", (code) => {
  proxy.kill();
  process.exit(code ?? 1);
});

