import { describe, expect, it } from "vitest";
import {
  assertExpectedChannel,
  assertMatchingPublishedChannels,
  parsePublishedChannel,
} from "./release-channels.mjs";

const artifact = {
  version: "1.0.0-rc.3",
  "dist.integrity": "sha512-example",
  "dist.shasum": "abc123",
};

describe("release channel verification", () => {
  it("accepts direct and nested npm view output for one immutable artifact", () => {
    const latest = parsePublishedChannel("latest", JSON.stringify([artifact]));
    const next = parsePublishedChannel("next", JSON.stringify({
      version: artifact.version,
      dist: { integrity: artifact["dist.integrity"], shasum: artifact["dist.shasum"] },
    }));

    expect(assertMatchingPublishedChannels([latest, next], artifact.version)).toEqual({
      version: artifact.version,
      integrity: artifact["dist.integrity"],
      shasum: artifact["dist.shasum"],
    });
  });

  it("rejects an unexpected version before promotion", () => {
    const next = parsePublishedChannel("next", JSON.stringify(artifact));
    expect(() => assertExpectedChannel(next, "1.0.0-rc.4")).toThrow("next points to 1.0.0-rc.3");
  });

  it("rejects channels backed by different artifact fingerprints", () => {
    const latest = parsePublishedChannel("latest", JSON.stringify(artifact));
    const next = parsePublishedChannel("next", JSON.stringify({ ...artifact, "dist.shasum": "different" }));
    expect(() => assertMatchingPublishedChannels([latest, next], artifact.version)).toThrow("do not serve the same");
  });

  it("rejects malformed registry responses without echoing their contents", () => {
    expect(() => parsePublishedChannel("next", JSON.stringify({ version: artifact.version }))).toThrow(
      "npm did not return version and artifact fingerprints",
    );
  });

  it("rejects ambiguous npm view arrays", () => {
    expect(() => parsePublishedChannel("next", JSON.stringify([artifact, artifact]))).toThrow(
      "npm returned an ambiguous descriptor",
    );
  });
});
