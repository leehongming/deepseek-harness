/** Reconnect-safe Workspace and Project baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Project, Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  projectDomainState,
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  ProjectView,
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

/** The frames the feed produces: every follow frame except `replace`, which only access filtering sends. */
type WorkspaceFeedFrame = Exclude<WorkspaceFollowFrame, { readonly type: 'replace' }>

/** The fields one project row contributes to its wire projection, from an entity or a stored record. */
type ProjectSource = Pick<Project, 'id' | 'title' | 'workspaceIds' | 'createdAt' | 'updatedAt'>

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Project one durable Project, or its stored record, into its Remote value.
 * @param project - authoritative registry entity or durable record.
 * @param registeredWorkspaceIds - current Workspace identities; when given,
 *   member ids absent from it are dropped, because a deleted Workspace leaves
 *   the stored record's membership stale until that record's next write.
 * @returns detached Project projection for Remote consumers.
 */
export function projectView(
  project: ProjectSource,
  registeredWorkspaceIds?: ReadonlySet<WorkspaceId>,
): ProjectView {
  return {
    projectId: project.id,
    title: project.title,
    workspaceIds: registeredWorkspaceIds === undefined
      ? [...project.workspaceIds]
      : project.workspaceIds.filter(workspaceId => registeredWorkspaceIds.has(workspaceId)),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Owns Workspace and Project domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private knownIds: Set<string>
  private order: readonly string[]
  private archived: readonly string[]
  private pinned: readonly string[]
  private projects: readonly ProjectView[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.knownIds = new Set(baseline.map(workspace => String(workspace.id)))
    this.order = baseline.map(workspace => String(workspace.id))
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    this.projects = this.projectViews(ctx.workspaceRegistry.listProjects())
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all active Workspaces, archived and pinned Session identities, and every Project.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspaceView),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
      projects: this.projectViews(this.ctx.workspaceRegistry.listProjects()),
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    signal.throwIfAborted()
    const follower = new WorkspaceFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /**
   * Project durable project rows against the registry's current Workspace set.
   * @param projects - registry projections or stored records in display order.
   * @returns detached projections whose membership names only registered Workspaces.
   */
  private projectViews(projects: readonly ProjectSource[]): ProjectView[] {
    const registered = new Set(this.ctx.workspaceRegistry.list().map(workspace => workspace.id))
    return projects.map(project => projectView(project, registered))
  }

  private changed(change: DomainChanged): void {
    if (change.domain === 'project') {
      if (change.table !== '' || change.operation !== 'put') return
      const state = projectDomainState.parse(change.value)
      const projects = this.projectViews(state.projects)
      if (sameProjects(this.projects, projects)) return
      this.projects = projects
      this.publish({ type: 'projects', projects })
      return
    }
    if (change.domain !== 'workspace') return
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(this.order, nextOrder)
      for (const id of state.workspaceIds) {
        if (this.knownIds.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        this.knownIds.add(id)
        this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
      }
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!this.knownIds.delete(change.key)) return
      this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
      return
    }
    if (!this.knownIds.has(change.key)) return
    this.publish({
      type: 'upsert',
      workspace: changedWorkspaceView(change.key, change.value),
    })
  }

  private publish(frame: Exclude<WorkspaceFeedFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameProjects(left: readonly ProjectView[], right: readonly ProjectView[]): boolean {
  return left.length === right.length && left.every((project, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && project.projectId === candidate.projectId
      && project.title === candidate.title
      && project.updatedAt === candidate.updatedAt
      && sameStrings(project.workspaceIds, candidate.workspaceIds)
  })
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFeedFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFeedFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
