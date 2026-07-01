// Friendly random agent-name generator (adjective + noun). The generated name
// is a prefill suggestion in the create form — the user can edit or replace it.

const ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "curious", "gentle", "golden", "happy",
  "keen", "lucky", "mellow", "nimble", "quiet", "rapid", "sunny", "swift",
  "vivid", "witty", "bright", "bold",
];

const NOUNS = [
  "otter", "falcon", "maple", "comet", "willow", "pixel", "harbor", "meadow",
  "ember", "cove", "quartz", "cedar", "raven", "lark", "delta", "onyx",
  "river", "summit", "atlas", "orbit",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// e.g. "swift-otter". Lowercase, hyphenated — reads well and slugifies cleanly.
export function randomAgentName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
