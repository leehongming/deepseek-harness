---
description: "Workspace entity registry (ctx.workspaceRegistry) for hosts choosing, mounting, or debugging durable Workspace records, the Project grouping above them, and header-validated session membership."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace

English | [中文](README.zh.md)

## Summary

Use this package to keep an ordered, persistent list of Workspaces (the directories a user works in) with the sessions run in each, and to group those Workspaces into named Projects. Hosts can build a project sidebar, hide sessions from grouping without deleting their histories, and remove a Project or a Workspace without deleting folders, files, or sessions. The two levels are independent: deleting a Project leaves its Workspaces ungrouped. Choose it for GUI or host workflows needing durable grouping; it is invisible to models and adds no prompt or request-context cost, but requires session persistence and storage backends.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package to give the product a Workspace list — named directories the user works in, the sessions that ran in each, a stable order, and a way to hide sessions without losing them or bring them back — and a Project level above it that groups Workspaces into named sections the user manages. The API contracts behind each action live in the implementation section.

### When to use it

Use it when the product shows a persistent Workspace or Project list — a sidebar, session grouping, or automation that names directories and orders them. It is invisible to the model, so it adds no token or request cost. Skip it when there is no grouping surface; nothing else in the harness needs it.

### Setting up

The package needs a session store, a session persistence backend, and the storage rows that keep its records. A minimal composition:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-workspace'
```

With these rows mounted, creating a Workspace or a Project shows up in the list immediately and survives a restart; the first start also groups existing sessions by the directory they ran in. If a required peer is missing, the workspace feature stays unavailable until it is mounted.

### Creating and ordering Workspaces

Create a Workspace from any fully qualified directory that exists: filesystem roots such as `C:\` and ordinary directories are valid. Relative paths, Windows drive-relative paths such as `C:work`, missing paths, and files are rejected without creating a Workspace; creating a Workspace for a directory that already has one returns the existing Workspace unchanged. Rename a Workspace at any time, and move it to any position in the list:

```text
// Host consumer code, after the composition above is loaded:
const workspace = await ctx.workspaceRegistry.create('/path/to/dir', 'My Workspace')
await workspace.setTitle('Renamed')
ctx.workspaceRegistry.list() // shows the Workspace, newest first
```

### Grouping Workspaces into Projects

A Project is a user-managed grouping above Workspaces: a title and an ordered list of member Workspaces, with no directory, files, or sessions of its own. Create one with a unique non-blank title; it is inserted at the front of the Project list, newest created first. Rename it at any time; identity, order, and members stay. Move a Workspace into a Project, or out of every Project, at any time. A Workspace belongs to at most one Project, so moving it from one Project to another drops the old membership in the same durable write, and a Workspace that is in no Project is ungrouped.

```text
// Projects are registry-level records; membership lives on the Project.
const project = await ctx.workspaceRegistry.createProject('Product')
await ctx.workspaceRegistry.renameProject(project.id, 'Product Team')
await ctx.workspaceRegistry.assignWorkspaceToProject(workspace.id, project.id)
await ctx.workspaceRegistry.assignWorkspaceToProject(workspace.id) // back to ungrouped
ctx.workspaceRegistry.listProjects() // newest created first
await ctx.workspaceRegistry.deleteProject(project.id) // members become ungrouped
```

Deleting a Project never deletes its member Workspaces, directories, files, or sessions; those Workspaces simply leave the grouping. Blank and duplicate titles are refused without writing, and a duplicate is compared by exact string, so `Product` and `product` are different titles.

<a id="first-use-workspace"></a>
### First-use Workspace

`initializeDefault(resolveDirectory)` initializes the default Workspace without creating a Session. Initial creation requires an empty Workspace registry and no live, persisted, or archived Session, including Sessions without a working directory. The registry checks persistent history directly; an empty visible sidebar is insufficient.

The directory resolver runs inside the mutation queue only when creation is eligible. It returns an absolute path; the registry creates missing parent directories, canonicalizes the path, rechecks Session history, and commits the Workspace with its initialization marker, titled after the requested directory's final segment rather than the canonical one, so a symlink at that path does not retitle the Workspace after its target. An existing directory is reused; a file conflict or directory failure rejects initialization. The [Host controller](../../api/workspace-controller/README.md#first-use-workspace) supplies the Documents path policy.

The first successful registration records its identity durably. Repeated calls return it without resolving a directory again; renaming keeps that identity, and deleting its registration does not permit another automatic creation. Directory or registration failure leaves initialization unset for retry. Directories created before a later failure remain on disk. Once directory resolution succeeds, caller cancellation does not roll back directory creation or registration. The default Workspace is created ungrouped, and no Project is created automatically. The [historical first-use decision](../../../.agents/notes/archived/feature/2026-09-20-default-workspace.md) explains this lifetime.

### Grouping sessions under a Workspace

A session joins the Workspace of the directory it runs in: create a session in a Workspace's directory and it appears under that Workspace, newest first. A session can only belong to one Workspace. A new session must have a recorded directory that resolves to the Workspace's directory. Already-accounted sessions keep their Workspace and order when their fully qualified recorded path is missing, including a dangling symlink; renaming or reordering the Workspace does not remove that ownership. Missing headers, invalid recorded paths, existing mismatched directories, and filesystem failures other than ENOENT remain excluded. Keeping ownership does not recreate the directory or relax new-session attachment, so a fork can still fail to attach while the directory is missing.

### Hiding and restoring sessions, and removing Workspaces

Hide a session from the grouping when it should stop appearing there: it disappears from the visible list, while its session, history, and place in the Workspace stay intact. A session with running work — its own turn, a running subagent, a background job, or an active reminder — is not hidden underneath that work: the registry refuses with the list of what runs, and a caller that asks to stop the work first has it stopped the way the user's own stop actions do, then hidden. Restore a hidden session when it should appear again: it returns to its recorded position under its Workspace, or to the ungrouped sessions when it belongs to none, and continues the conversation from a regularly ended log. Remove a Workspace when it is no longer needed: it leaves the list, and its folder, files, and session histories are never touched — those sessions become ungrouped. Adding the same directory again afterwards starts a fresh Workspace without the old sessions.

Workspace registration does not establish ownership of its directory, and Project membership is only a grouping above Workspaces. A future destructive filesystem action must be separately named, explicitly confirmed, and enforce ownership and safety checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the feature and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One record per canonical path.** `fs.realpath` is the single uniqueness canon: paths are stored canonicalized, so a symlink to an owned directory collides, and uniqueness is string equality of canonical paths.
- **Membership starts from the recorded account.** The header index validates ordered `sessionIds`; missing-directory candidates retain their account, while other invalid candidates are filtered on read and pruned by the next mutation. The strict canonical-path index used for history bootstrap includes existing directories only.
- **Header-only reads.** Bootstrap and attach validation read `SessionHeader` fields only; event bodies are never loaded.
- **Projects live in their own domain.** Project state is one ordered array in a separate `project` domain, so every Project mutation is one global write and one notification, and no Workspace record carries a grouping field. Workspace ordering, bootstrap, and schemas are unchanged by the Project level.
- **Membership belongs to the Project.** The stored Project record holds its member Workspace ids, so the registry enforces the single-owner invariant across the complete Project set on its write chain, and a Workspace record is identical whether it is grouped or not.
- **Two-write mutations with an explicit marker.** Workspace create and delete persist a `pendingMutation` marker before the record/order pair can diverge, so startup completes exactly the interrupted operation and unmarked divergence fails loud as corruption.
- **Serialized writes.** Registry operations run on one operation chain and Project mutations on their own; entity mutations go through `table.update` on the domain write chain, stamping `updatedAt` and deciding membership at their chain slot.

<a id="api-behavior"></a>
### API behavior

The API has three owners: `WorkspaceRegistry` creates, orders, and deletes Workspaces and Projects, manages Session accounting, and pins, unpins, archives, or restores Sessions; the `Workspace` entity exposes the display title, directory status, and Session projection; the `Project` interface exposes the title, ordered member Workspaces, and timestamps. Pinning requires a known, unarchived Session; archiving clears its pin in the same durable write, and restoring does not restore that pin. A Project create, rename, delete, or membership change writes the whole Project array once; a duplicate title is refused with `ProjectTitleConflictError`, a blank title with `TypeError`, and an unknown target Project with `ProjectNotFoundError`. Workspace existence is checked by the controller before it assigns membership, not by the registry, and assigning a Workspace that already belongs to the target Project changes nothing. Per-method contracts live in [src/index.ts](src/index.ts), [src/entity.ts](src/entity.ts), and [src/project-spec.ts](src/project-spec.ts).

Archive admission is a capability seam over two Host events this package declares and dispatches: `workspace/session-activity` (waterfall) asks the composed providers what still runs for a Session, and `workspace/session-stop` (parallel) asks them to stop it. `archiveSession(sessionId)` asks the activity waterfall once and rejects a non-empty answer with `WorkspaceActiveSessionError`, whose `activity` lists each family with its items — the keys are the providers' own, merged into `SessionActivityKindMap`, which this package leaves empty; `archiveSession(sessionId, { stopActivity: true })` skips the activity check, writes the archive, and then dispatches the stop event, so the durable archive set already gates every wake the stops induce; a rejecting provider is logged and the archive stays. The call resolves once every provider's stop request was issued, while the stopped work settles on its own. Both questions come after the existence check and never for an already archived id. The shipped providers are the Agent registry (the running turn), the job registry seam (owned jobs), the Subagent runtime (running descendants), and the Schedule plugin (active reminders); a composition without providers archives freely.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `WorkspaceRegistry` service, header index, bootstrap, operation serialization, Project API |
| [`src/entity.ts`](src/entity.ts) | Package-private `Workspace` implementation and its single `mutate` write path |
| [`src/spec.ts`](src/spec.ts) | Workspace domain declaration: record schema, registry state, `defineDomain` spec |
| [`src/project-spec.ts`](src/project-spec.ts) | Project domain declaration: ordered record schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public `Workspace` and `Project` interfaces and the `WorkspaceId`/`ProjectId` brands |
| [`src/paths.ts`](src/paths.ts) | The `realpath` uniqueness canon |

### Durable shape

The registry opens the `workspace` domain (version 2): a `workspaces` table keyed by `WorkspaceId` plus one global state holding `workspaceIds` (the authoritative display order), `archivedSessionIds`, `pinnedSessionIds`, the optional `defaultWorkspaceId` first-use identity, and the optional `pendingMutation` marker. Archive and pin sets contain Session id strings, default to empty, and carry no per-entry objects or timestamps; the pin array keeps the most recently pinned id first. Archiving clears the pin in the same global-state write without changing Workspace membership. Unarchive runs no session-existence probe, because dropping an id from the set cannot introduce an unknown one, while archive verifies the session before adding it.

Projects open a separate `project` domain (version 1) with no tables: one global state holding a single `projects` array in display order, newest created first, and initially empty. Each project record carries its id, title, ordered `workspaceIds`, and timestamps. Every Project mutation replaces that array in one write, so an interrupted mutation leaves the previous grouping intact; Project writes never touch the `workspace` domain.

### Lifecycle

On start, the registry opens both domains, completes a marked Workspace mutation if one is pending, validates stored state — duplicate paths, duplicate session accounts, and order drift all fail loud — and, when not yet initialized, bootstraps history from persisted headers before writing the initialized marker last, so an interrupted bootstrap resumes safely. A fresh empty registry is real once initialized; it never re-bootstraps. Project state is validated at open: duplicate project ids, duplicate titles, and one Workspace claimed by two Projects fail loud as corruption, while a member id whose Workspace registration is gone is stale membership — projected away and pruned by the next Project mutation that touches that record.

### Failure and recovery

A Workspace create or delete whose second write fails rolls the cache and the prior order back; when both the operation and its rollback fail, the durable marker still names the interrupted operation and the next startup completes or rolls it back. A committed delete whose marker cleanup fails still reports success, and the next startup clears the marker idempotently. A Project mutation has no second write to reconcile: one global replacement per mutation either commits the complete array or leaves the previous one.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this package's view is not enough: the subsystem reference is the authoritative feature contract, and the Agent Notes record why Workspaces start from session history, how the Project level above them is stored, and why removal is non-destructive.

- [Workspace subsystem](../../../docs/subsystems/workspace.md) — the feature contract for Workspaces, Projects, and their sessions, and the generated API for the workspace service.
- [Workspace package map](../README.md) — the group's single package and its repository position.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — why Workspace and Project records use the domain data form.
- [Project grouping Agent Note](../../../.agents/notes/implemented/architecture/2026-11-03-project-grouping-above-workspaces.md) — why the Project level uses a separate domain with membership on the Project.
- [Workspace UI product-flow Agent Note](../../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md) — how the first start builds Workspaces from session history and how the GUI orders them.
- [historical Workspace registration deletion decision](../../../.agents/notes/archived/feature/2026-07-27-workspace-registration-deletion.md) — why removing a Workspace never deletes its folder or sessions.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace and Project records and session accounts

#### What the model sees

Nothing. `ctx.workspaceRegistry` serves Workspace and Project records to host-side consumers only: the package registers no tools, injects no prompts, and writes no session events, so no request field ever carries this package's data.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the Workspace or Project list is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Removal never deletes data** — removing a Workspace leaves its folder, files, and session histories in place; those sessions become ungrouped, and session deletion or folder removal are separate, absent capabilities. Removing a Project leaves its member Workspaces ungrouped and deletes no Workspace, directory, or session.
- **Project membership is a grouping, not ownership** — assigning a Workspace to a Project establishes no filesystem ownership and grants no access; it only places the Workspace in that section of the list.
- **Project titles are compared as exact strings** — the transport trims surrounding whitespace, but no case folding or Unicode normalization applies, so titles that differ only in case or normalization can coexist.
- **Missing paths retain recorded ownership, not verified symlink history** — a removed symlink and an incorrect but missing absolute cwd cannot be distinguished from existing records; both preserve an already-accounted id. No unaccounted session is assigned by this exception, and an account already removed from storage is not reconstructed.
- **External changes are seen late** — if another process deletes or damages a directory, the Workspace reflects it only at the next refresh or restart.
- **Archive and unarchive enforce different session checks** — a restore only drops an id from the archive set, so an entry whose session is gone still unarchives and leaves no unknown referent; a restore of an id that is not archived resolves without writing, while `archiveSession` rejects a session that is neither live nor persisted.
- **The activity check and the archive write are not one atomic step** — a turn that starts between the providers' answer and the durable write is hidden while running, and every model step whose `agent/pre-step` precedes the write still runs with its tool calls; the API Session Controller's gate ends the first step proposed after the write as `blocked`, so the exposure is bounded by that write's latency, in practice one model step.
- **Re-adding a directory starts fresh** — after removal, adding the same directory again creates a new Workspace with an empty session list; the old sessions do not come back automatically, and the new Workspace starts ungrouped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open: the `create(path, title?)` title parameter

The `title` parameter has no production caller since the gateway's create-by-name branch was removed; a code TODO proposes dropping the parameter and its `@param` clause together ([note](../../../.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md)).

</details>
