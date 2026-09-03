import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const artifactsRoot = join(workspaceRoot, "artifacts");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const command = process.argv[2] ?? "artifact";
const tarball = join(artifactsRoot, `raycoder-${manifest.version}.tgz`);
const checksum = `${tarball}.sha256`;

if (command === "artifact") {
  mkdirSync(artifactsRoot, { recursive: true });
  if (existsSync(tarball) || existsSync(checksum)) throw new Error(`Release artifact already exists; refusing to overwrite ${tarball}`);
  exec("pnpm", ["security:check"], workspaceRoot);
  exec("pnpm", ["build"], workspaceRoot);
  exec("pnpm", ["pack", "--pack-destination", artifactsRoot], packageRoot);
  exec("pnpm", ["security:check", tarball], workspaceRoot);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(checksum, `${digest}  raycoder-${manifest.version}.tgz\n`, "utf8");
  console.log(`Created immutable release candidate artifact: ${tarball}\nSHA-256: ${digest}`);
} else if (command === "publish-rc") {
  if (!/-rc\.\d+$/u.test(manifest.version)) throw new Error(`Expected an RC version, found ${manifest.version}`);
  verifyChecksum();
  exec("npm", ["publish", tarball, "--tag", "next", "--access", "public"], workspaceRoot);
} else if (command === "promote") {
  if (!/-rc\.\d+$/u.test(manifest.version)) throw new Error(`Expected an RC version, found ${manifest.version}`);
  exec("npm", ["dist-tag", "add", `${manifest.name}@${manifest.version}`, "latest"], workspaceRoot);
} else {
  throw new Error("Usage: node scripts/release.mjs artifact|publish-rc|promote");
}

function verifyChecksum() {
  if (!existsSync(tarball) || !existsSync(checksum)) throw new Error("Release tarball or checksum is missing");
  const expected = readFileSync(checksum, "utf8").trim().split(/\s+/u)[0];
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (expected !== actual) throw new Error(`Release checksum mismatch: expected ${expected}, found ${actual}`);
}

function exec(executable, args, cwd) {
  if (process.platform === "win32" && (executable === "pnpm" || executable === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(executable, args, { cwd, stdio: "inherit" });
}
