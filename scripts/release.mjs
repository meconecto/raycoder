import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const artifactsRoot = join(workspaceRoot, "artifacts");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const command = process.argv[2] ?? "artifact";
const tarball = join(artifactsRoot, `raycoder-${manifest.version}.tgz`);

if (command === "artifact") {
  mkdirSync(artifactsRoot, { recursive: true });
  exec("pnpm", ["build"], workspaceRoot);
  exec("pnpm", ["pack", "--pack-destination", artifactsRoot], packageRoot);
  console.log(`Created immutable release candidate artifact: ${tarball}`);
} else if (command === "publish-rc") {
  if (!/-rc\.\d+$/u.test(manifest.version)) throw new Error(`Expected an RC version, found ${manifest.version}`);
  exec("npm", ["publish", tarball, "--tag", "next", "--access", "public"], workspaceRoot);
} else if (command === "promote") {
  if (!/-rc\.\d+$/u.test(manifest.version)) throw new Error(`Expected an RC version, found ${manifest.version}`);
  exec("npm", ["dist-tag", "add", `${manifest.name}@${manifest.version}`, "latest"], workspaceRoot);
} else {
  throw new Error("Usage: node scripts/release.mjs artifact|publish-rc|promote");
}

function exec(executable, args, cwd) {
  if (process.platform === "win32" && (executable === "pnpm" || executable === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${executable}.cmd`, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(executable, args, { cwd, stdio: "inherit" });
}
