---
name: release
description: Prepare and cut a Hermetic release when the user asks for one — recommend a semver bump from the changes since the last tag, draft notes, confirm unless --auto, then run bun run release.
---

# Release

Read and follow [the shared release workflow](../../../.claude/skills/release/SKILL.md). Its body is the source of truth for the release steps, the version rules and the confirmation gate. Use Codex's available file and shell tools in place of the Claude-specific `allowed-tools` metadata, and ask the confirmation question in plain chat where `AskUserQuestion` is not available.
