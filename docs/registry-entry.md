# elizaOS registry entry — STAGED DRAFT

> **Status: staged draft, not yet filed.** This is the content intended to land in
> the elizaOS registry under `packages/registry/entries/third-party/`. The actual
> registry PR is a **post-publish** step (the npm packages must exist first) and is
> **not** part of this build workflow. Keep this file in sync with the package
> metadata so the eventual PR is a copy-paste.

## Entry

- **Package name:** `@tinycloud/eliza-plugin-memory`
- **Description:** elizaOS 2.0 plugin owning the advanced-memory `memoryStorage`
  slot — stores long-term memories and session summaries in a user-owned TinyCloud
  space, making memory a portable, durable system of record.
- **Repository:** https://github.com/TinyCloudLabs/tinycloud-agents
- **Maintainer:** TinyCloudLabs (TinyCloud Labs)
- **License:** MIT

### npm packages

| npm name | role |
| --- | --- |
| `@tinycloud/eliza-plugin-memory` | The elizaOS plugin (the registry entry's package). Owns the `memoryStorage` service slot. |
| `@tinycloud/agent-client` | Shared, host-framework-agnostic client core (TinyCloud `node-sdk` wrapper). A transitive dependency of the plugin; **not** itself an elizaОS plugin and not registered separately. |

### Activation requirements (surface in the entry's notes)

Two mandatory steps for the plugin to take effect (see the package README and
`docs/hydration.md`):

1. List `@tinycloud/eliza-plugin-memory` **before** `@elizaos/plugin-sql` in
   `character.plugins` (first-registered wins the `memoryStorage` slot).
2. Set `character.advancedMemory: true`.

Required config: `TINYCLOUD_PRIVATE_KEY` (a **dedicated, low-value** key — never
the operator's main wallet). Optional: `TINYCLOUD_HOST`, `TINYCLOUD_DB_HANDLE`,
`TINYCLOUD_SPACE_PREFIX`.

### Compatibility

- **elizaOS:** 2.0 line. Peer-pinned to `@elizaos/core@2.0.0-beta.1` until 2.0 GA,
  at which point the entry should be re-pinned to the GA tag.

## Example draft entry JSON

A first-pass shape for the registry entry file (exact schema follows the registry's
own format at filing time — confirm against a current
`packages/registry/entries/third-party/` example before submitting):

```json
{
  "name": "@tinycloud/eliza-plugin-memory",
  "description": "elizaOS plugin owning the advanced-memory memoryStorage slot, backed by a user-owned TinyCloud space (portable, durable system of record for long-term memories and session summaries).",
  "repository": "https://github.com/TinyCloudLabs/tinycloud-agents",
  "maintainer": "TinyCloudLabs",
  "license": "MIT",
  "tags": ["elizaos", "plugin", "tinycloud", "memory", "advanced-memory", "memoryStorage"]
}
```
