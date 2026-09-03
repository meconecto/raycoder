import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const forbidden = [
  { label: "raycoder metadata", pattern: /(^|\/)\.raycoder(\/|$)/iu },
  { label: "release artifact", pattern: /^artifacts\//iu },
  { label: "environment file", pattern: /(^|\/)\.env(?:\.|$)/iu, allow: /(^|\/)\.env\.example$/iu },
  { label: "private key", pattern: /\.(?:pem|key|p12|pfx)$/iu },
  { label: "private session document", pattern: /^docs\/session[^/]*\.md$/iu },
];

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).split("\0").filter(Boolean);

check("tracked repository", tracked);

for (const argument of process.argv.slice(2)) {
  const tarball = resolve(workspaceRoot, argument);
  if (!existsSync(tarball)) throw new Error(`Tarball does not exist: ${tarball}`);
  const entries = execFileSync("tar", ["-tf", tarball], { cwd: workspaceRoot, encoding: "utf8" })
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^package\//u, ""))
    .filter(Boolean);
  check(`package ${tarball}`, entries);
}

console.log(`PASS repository hygiene (${tracked.length} tracked files)`);

function check(source, paths) {
  const violations = [];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    for (const rule of forbidden) {
      if (rule.pattern.test(normalized) && !(rule.allow?.test(normalized) ?? false)) {
        violations.push(`${normalized} (${rule.label})`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Forbidden files found in ${source}:\n${violations.join("\n")}`);
  }
}
