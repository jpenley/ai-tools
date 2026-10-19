Extracted from Factory Floor worktree codex/mcp-file-git-access (base a2a8302). File/Git implementations, hashes, path and credential safeguards, read-only lazy-fetch prevention and full-mode signing restrictions are preserved.

The package has no Factory Floor runtime dependency. It owns its tool contracts, fixed registry, MCP framing, executable discovery and read-only recognition of engine links declared by a repository. Engine-link creation and studio task orchestration remain in Factory Floor.

Tests exercise real stdio MCP calls and local temporary Git repositories. No model service, live studio, browser or external remote is needed.
