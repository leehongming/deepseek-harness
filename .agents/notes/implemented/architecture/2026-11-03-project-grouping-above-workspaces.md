# Agent Note: Project grouping above Workspaces lives in its own storage domain

Status: implemented

English | [中文](2026-11-03-project-grouping-above-workspaces.zh.md)

## Problem

The sidebar hierarchy was Workspace and Session: a durable directory record and the Sessions run in it. Users need to group Workspaces durably into user-named sections, and the level above Workspaces determines several contracts at once. Storing the grouping on the Workspace record would change the workspace domain schema, make a membership move a second write across domains with its own reconciliation, and require the workspace bootstrap and ordering paths to carry grouping state. Storing a many-to-many relation would allow one Workspace in two sections when the product needs exactly one, and would still need a single-owner invariant. A Project also must survive a deleted Workspace registration and must never delete a Workspace, directory, or Session.

## Decision

A Project is a durable entity in a separate `project` storage domain (version 1): one global singleton holding one ordered array of `{ id, title, workspaceIds, createdAt, updatedAt }` records, no tables, and an empty initial array. Every create, rename, delete, or membership change replaces that array in one domain write and emits one `domain/changed` put, so a Project mutation is atomic and becomes visible at one commit point. The array order is the display order, newest created first.

Workspace records carry no project id. The grouping is absent from the workspace schema, ordering, bootstrap, and pending-mutation paths, so creating or deleting a Workspace never writes Project state. Membership is stored on the Project record, which keeps a Workspace record identical whether it is grouped or ungrouped, and lets the registry enforce the single-owner invariant across the complete Project set on one Project write chain. A member id whose Workspace registration is gone is stale membership, not corruption: `listProjects()` and `getProject()` filter it from the projection, and the next Project mutation prunes it from the records that mutation touches. Stored state that repeats a project id, repeats a title, or claims one Workspace under two Projects fails loud at startup as corruption.

Titles are unique by exact string at the durable boundary and must be non-blank; a duplicate rejects with `ProjectTitleConflictError` and a blank title with `TypeError`. `createProject(title)` inserts an empty Project at the front, `renameProject(id, title)` keeps identity, order, and members, `deleteProject(id)` removes the record and leaves its member Workspaces ungrouped, and `assignWorkspaceToProject(workspaceId, projectId?)` appends a Workspace to the target Project and drops its membership elsewhere in the same write, or ungroups it when the target is omitted. None of these operations moves, renames, or deletes a Workspace, directory, or Session.

The wire surface keeps the same ownership split: `WorkspaceController` gains the four owner-only Project verbs, the follow baseline carries `projects`, and a `{ type: 'projects' }` increment publishes a changed list; a non-owner's Project carries only the member Workspaces that caller's access admits. The Client adds a `project` grouping mode with project sections and an ungrouped bucket, made the sidebar default.

## Alternatives considered

**A `projectId` field on the Workspace record.** It puts the grouping into the workspace domain schema, so one membership move becomes two writes across domains — the Workspace record and the Project order — and needs a new pending-mutation reconciliation path for the pair. It also makes every Workspace write carry grouping state that describes no directory fact, and changes the bootstrap projection that reconstructs Workspaces from Session headers.

**A membership join table keyed by Workspace id.** This makes many-to-many trivial but loses single-owner enforcement: uniqueness would need a second index or a cross-row invariant that identical user mutations could violate, and member display order would need its own sequence column instead of one array.

**Store the membership on Workspaces as an ordered array.** A Workspace can then appear in several Projects when the product needs exactly one section per Workspace, and a single-owner rule would still have to be enforced across all affected records on a multi-record write.

**Derive Projects from Workspace paths.** Projects are user-named and independent of directories. A path-derived grouping cannot name arbitrary Workspace sets, cannot group Workspaces whose directories are unrelated, and cannot keep a stable identity through a rename.

## Consequences

Project mutations are single, atomic writes, and the workspace domain is untouched: no schema version bump, no new pending-mutation recovery path, and no change to ordering or bootstrap. The cost is a cross-domain read projection: project views filter member ids against the live Workspace set, and stale membership stays in storage until a later Project mutation prunes the records it touches; that residue is bounded and produces no wrong projection. Single-owner enforcement sits on one write chain, so two concurrent assignments serialize instead of producing a Workspace in two Projects. Deleting a Project stays a single write that leaves every Workspace, directory, and Session intact, which extends the "removal never deletes data" guarantee to the new level.

Verification covers the registry (atomic create/rename/delete/assign, single-owner enforcement, stale-id filtering and pruning, duplicate and blank titles, loud validation of corrupt stored state), the controller and feed (the four verbs, project error codes, baseline and `projects` increment, access filtering), and the Client tree and browser (project mode, ungrouped bucket, membership moves, persisted expansion).
