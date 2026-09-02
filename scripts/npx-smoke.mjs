import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "raycoder-npx-"));

try {
  exec("pnpm", ["build"], workspaceRoot);
  exec("pnpm", ["pack", "--pack-destination", fixture], packageRoot);
  const tarball = join(fixture, `raycoder-${manifest.version}.tgz`);
  const output = npm(["exec", "--yes", `--package=${tarball}`, "--", "raycoder", "--version"], fixture).trim();
  if (output !== manifest.version) throw new Error(`Unexpected npx version: ${output}`);
  console.log(`PASS npx installed and executed raycoder ${output}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${command}.cmd`, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function npm(args, cwd) {
  return process.platform === "win32"
    ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], { cwd, encoding: "utf8" })
    : execFileSync("npm", args, { cwd, encoding: "utf8" });
}
