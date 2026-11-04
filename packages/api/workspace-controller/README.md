---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, group them into Projects, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, `pinned`, and `projects` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The controller injects `remoteAccess` and registers the `workspace` resource kind with the default field `workspaceId` through `typert.resources`. `workspace/follow` reads no resource, so its call touches the `global` resource: a Peer whose principal is not the owner may follow it only when its principal kind's policy in [`dsh-api-remote-access`](../remote-access/README.md) binds a `global` role listing the action. For that caller, the baseline, `upsert` frames, and `order` ids keep only the Workspaces `ctx.remoteAccess.allows()` admits as `workspace` resources, and only the Session ids it admits as `session` resources, within each Workspace and in the archived and pinned sets, so `workspace` and `session` roles list the same action. A Project frame keeps only the member Workspace ids that same access admits. The stream tracks the Workspaces it delivered. When one is no longer admitted at its next change or in a new order, the stream sends a `replace` increment carrying the complete filtered state instead of a `remove`, because a removed id is never resurrected on the Client; `replace` is an ordinary increment that the Client applies like an opening baseline, not the start of a new generation, so it neither reports an error nor reconnects; once access returns, the Workspace reappears through an ordinary `upsert`. A `remove` frame reports a deletion and reaches only a caller that received that Workspace. Owner frames are unfiltered.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, the Project list, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="project-grouping"></a>
### Project grouping

A Project is a user-managed grouping above Workspaces: durable registry state with a stable id, a unique non-blank title, and an ordered member list, where one Workspace belongs to at most one Project and Workspaces outside every Project stay ungrouped. The registry orders Projects newest created first and validates titles on its write chain. Deleting a Project leaves its Workspace registrations, directories, and Sessions untouched and returns them to the ungrouped set. Membership changes never move, rename, or delete a Workspace or a Session. The [Workspace registry](../../workspace/workspace/README.md) owns the durable project domain; this package projects it onto the wire.

Four Remote methods own the mutations. `workspace/createProject` and `workspace/renameProject` answer the changed Project and fail as `gateway/bad-request` for a blank trimmed title or `project/name-conflict`, whose details name the title in use; `workspace/renameProject` also fails as `project/not-found` for an unknown Project. `workspace/deleteProject` answers `{ deleted: true }` and fails as `project/not-found`. `workspace/assignWorkspaceProject` validates the Workspace as `workspace/not-found`, then moves it into the named Project — dropping any previous Project membership in the same write — or ungroups it when the request omits `projectId`; it answers the complete Project list. The baseline carries `projects`, and each project write emits one `{ type: 'projects', projects }` increment carrying the complete list, so a Client never merges per-project deltas and a write whose projection equals the delivered list emits nothing.

The Client service exposes `workspaces.createProject(title)`, `workspaces.renameProject(projectId, title)`, `workspaces.deleteProject(projectId)`, and `workspaces.assignWorkspaceProject(workspaceId, projectId?)`. `ClientWorkspaceModel` installs the baseline Project list and applies each unary result to its local state: a created Project arrives first, a rename replaces its row, a delete drops it, and an assignment installs the returned complete list. A pushed list or a later Project request supersedes an older reply, and an unchanged list keeps the previous snapshot identity.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
