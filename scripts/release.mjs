import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExpectedChannel,
  assertMatchingPublishedChannels,
  parsePublishedChannel,
} from "./release-channels.mjs";

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
  assertExpectedChannel(readPublishedChannel("next"), manifest.version);
  exec("npm", ["dist-tag", "add", `${manifest.name}@${manifest.version}`, "latest"], workspaceRoot);
  verifyPublishedChannels();
} else if (command === "verify-tags") {
  verifyPublishedChannels();
} else {
  throw new Error("Usage: node scripts/release.mjs artifact|publish-rc|promote|verify-tags");
}

function verifyPublishedChannels() {
  const verified = assertMatchingPublishedChannels(
    [readPublishedChannel("latest"), readPublishedChannel("next")],
    manifest.version,
  );
  console.log(`Verified npm latest and next at ${verified.version} (${verified.integrity}; ${verified.shasum})`);
}

function readPublishedChannel(tag) {
  const output = execOutput(
    "npm",
    ["view", `${manifest.name}@${tag}`, "version", "dist.integrity", "dist.shasum", "--json"],
    workspaceRoot,
  );
  return parsePublishedChannel(tag, output);
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

function execOutput(executable, args, cwd) {
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  if (process.platform === "win32" && (executable === "pnpm" || executable === "npm")) {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], options);
  }
  return execFileSync(executable, args, options);
}
