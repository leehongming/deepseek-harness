---
description: "The workspace group map: durable Workspace records, the Projects that group them, header-validated session membership, and the family's single package, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/workspace

English | [中文](README.zh.md)

## Summary

The workspace family lets a host product keep an ordered list of named Workspaces — durable directory records — with the sessions run in each, and an ordered set of Projects that group those Workspaces into named sections. Users can browse projects, workspaces, and sessions, hide a session without deleting it, and remove a Workspace or a Project without deleting folders, files, or session history. Choose this family for a persistent workspace and project surface; it requires session storage and a persistence backend, and it does not expose tools, prompts, or session events to the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workspace`](workspace/README.md) | Provides named, ordered Workspaces with the sessions that ran in each directory, and the Projects that group them | `ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Workspace subsystem](../../docs/subsystems/workspace.md) — the authoritative feature contract for workspaces, projects, and their sessions.
- [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the storage design behind Workspace and Project records.
- [Workspace UI product-flow Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md) — how the first start builds Workspaces from session history and how the GUI orders them.
- [historical Workspace registration deletion decision](../../.agents/notes/archived/feature/2026-07-27-workspace-registration-deletion.md) — why removing a Workspace never deletes its folder or sessions.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
