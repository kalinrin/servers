---
"@modelcontextprotocol/server-filesystem": minor
---

Make `delete_path` move entries to a workspace-local `.mcp-trash` by default, preserving their relative paths and avoiding overwrites. Add `permanent: true` as the explicit opt-in to permanent deletion.
