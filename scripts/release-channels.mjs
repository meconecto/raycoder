const channelNames = ["latest", "next"];

export function parsePublishedChannel(tag, output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for the ${tag} channel`, { cause: error });
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error(`npm returned an ambiguous descriptor for the ${tag} channel`);
    [value] = value;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`npm returned an invalid descriptor for the ${tag} channel`);
  }
  const direct = value;
  const dist = typeof direct.dist === "object" && direct.dist !== null && !Array.isArray(direct.dist)
    ? direct.dist
    : {};
  const version = direct.version;
  const integrity = direct["dist.integrity"] ?? dist.integrity;
  const shasum = direct["dist.shasum"] ?? dist.shasum;
  if (typeof version !== "string" || typeof integrity !== "string" || typeof shasum !== "string") {
    throw new Error(`npm did not return version and artifact fingerprints for the ${tag} channel`);
  }
  return { tag, version, integrity, shasum };
}

export function assertExpectedChannel(channel, expectedVersion) {
  if (channel.version !== expectedVersion) {
    throw new Error(`npm ${channel.tag} points to ${channel.version}; expected ${expectedVersion}`);
  }
}

export function assertMatchingPublishedChannels(channels, expectedVersion) {
  const byTag = new Map(channels.map((channel) => [channel.tag, channel]));
  for (const tag of channelNames) {
    const channel = byTag.get(tag);
    if (channel === undefined) throw new Error(`Missing npm ${tag} channel descriptor`);
    assertExpectedChannel(channel, expectedVersion);
  }
  const latest = byTag.get("latest");
  const next = byTag.get("next");
  if (latest.integrity !== next.integrity || latest.shasum !== next.shasum) {
    throw new Error("npm latest and next do not serve the same immutable artifact");
  }
  return { version: expectedVersion, integrity: latest.integrity, shasum: latest.shasum };
}
