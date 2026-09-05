import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");

describe("release workflow", () => {
  it("keeps the npm OIDC registry bridge pinned", () => {
    expect(workflow).toMatch(/permissions:\s*[\s\S]*?id-token:\s*write/u);
    expect(workflow).toMatch(/uses:\s*actions\/setup-node@[0-9a-f]{40}\s*#\s*v\d/u);
    expect(workflow).toMatch(/registry-url:\s*https:\/\/registry\.npmjs\.org/u);
    expect(workflow).toMatch(/package-manager-cache:\s*false/u);
  });

  it("publishes only after uploading the verified artifact", () => {
    const upload = workflow.indexOf("actions/upload-artifact@");
    const publish = workflow.indexOf("pnpm release:publish:rc");
    expect(upload).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(upload);
  });
});
