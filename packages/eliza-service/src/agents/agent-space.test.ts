// agent-space scheme tests (M2.1).

import { describe, expect, it } from "bun:test";
import {
  AGENTS_SPACE,
  DEFAULT_AGENT_PATH_PREFIX,
  dbHandleFor,
  pathPrefixFor,
  slugifyAgentName,
} from "./agent-space.js";

describe("constants", () => {
  it("space is 'agents' and default prefix is 'default/'", () => {
    expect(AGENTS_SPACE).toBe("agents");
    expect(DEFAULT_AGENT_PATH_PREFIX).toBe("default/");
  });
});

describe("slugifyAgentName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyAgentName("Research Bot")).toBe("research-bot");
    expect(slugifyAgentName("My_Agent 2!!")).toBe("my-agent-2");
  });

  it("falls back to 'agent' for empty/punctuation-only names", () => {
    expect(slugifyAgentName("")).toBe("agent");
    expect(slugifyAgentName("!!!")).toBe("agent");
  });
});

describe("pathPrefixFor", () => {
  it("index 0 → default/ regardless of name", () => {
    expect(pathPrefixFor(0, "Whatever")).toBe("default/");
  });

  it("index > 0 → slugified name prefix", () => {
    expect(pathPrefixFor(1, "Research Bot")).toBe("research-bot/");
    expect(pathPrefixFor(2, "")).toBe("agent/");
  });
});

describe("dbHandleFor", () => {
  it("appends 'memory.db' to the prefix", () => {
    expect(dbHandleFor("default/")).toBe("default/memory.db");
    expect(dbHandleFor("research-bot/")).toBe("research-bot/memory.db");
  });
});
