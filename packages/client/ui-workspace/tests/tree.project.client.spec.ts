import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ProjectId, ProjectView, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  type ArchivedFilter,
  deriveProjectTree, owningProjectKey, UNGROUPED_KEY,
} from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt, retainedBy: {},
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const withMain = (state: SessionListState, id: SessionId): SessionListState => ({
  ...state,
  byId: {
    ...state.byId,
    [id]: { ...state.byId[id]!, retainedBy: { ...state.byId[id]!.retainedBy, mainView: 1 } },
  },
})
const workspace = (id: string, sessionIds: string[] = [], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const project = (id: string, title: string, workspaceIds: readonly string[] = []): ProjectView => ({
  projectId: id as ProjectId, title, workspaceIds: workspaceIds.map(wid),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const noStatuses: SessionStatusSnapshot = new Map()
const rowState = (options: {
  pinned?: readonly string[]
  archived?: readonly string[]
  archivedFilter?: ArchivedFilter
} = {}) => ({
  pinnedSessionIds: (options.pinned ?? []).map(sid),
  archivedSessionIds: (options.archived ?? []).map(sid),
  archivedFilter: options.archivedFilter ?? 'default' as const,
})
const noRows = rowState()
const view = (
  expandedGroups: readonly string[] = [],
  ungroupedOrder?: readonly string[],
  projectExpansion?: Readonly<Record<string, boolean>>,
) => ({
  expandedGroups,
  ...(ungroupedOrder === undefined ? {} : { ungroupedOrder }),
  ...(projectExpansion === undefined ? {} : { projectExpansion }),
})

describe('owningProjectKey', () => {
  it('resolves the owning project or nothing for an unassigned Workspace', () => {
    const projects = [project('p1', 'One', ['alpha']), project('p2', 'Two', ['beta'])]
    expect(owningProjectKey(projects, wid('alpha'))).toBe('p1')
    expect(owningProjectKey(projects, wid('beta'))).toBe('p2')
    expect(owningProjectKey(projects, wid('loose'))).toBeUndefined()
  })
})

describe('deriveProjectTree', () => {
  it('buckets Workspace groups into project sections and one unassigned bucket', () => {
    const workspaces = [workspace('a', ['sa']), workspace('b', ['sb']), workspace('loose', ['sl'])]
    const projects = [project('p1', 'First', ['a']), project('p2', 'Second', ['b'])]
    const nodes = deriveProjectTree(
      list(summary('sa', 3), summary('sb', 2), summary('sl', 1)),
      workspaces, projects, noRows, noStatuses, view(),
    )
    expect(nodes.map(node => [node.key, node.title, node.workspaceCount])).toEqual([
      ['p1', 'First', 1], ['p2', 'Second', 1], [UNGROUPED_KEY, '', 1],
    ])
    expect(nodes[0]?.workspaces.map(group => group.key)).toEqual(['a'])
    expect(nodes[2]?.projectId).toBeUndefined()
    expect(nodes[2]?.workspaces.map(group => group.label)).toEqual(['loose'])
    // Folded projects keep their count but render no Workspace rows.
    const folded = deriveProjectTree(
      list(summary('sa', 3)), workspaces, projects, noRows, noStatuses, view([], undefined, { p1: false }),
    )
    expect(folded[0]).toMatchObject({ expanded: false, workspaceCount: 1, workspaces: [] })
  })

  it('keeps project display order and the global Workspace order inside each project', () => {
    const workspaces = [workspace('first'), workspace('second'), workspace('third')]
    const projects = [
      project('older', 'Older', ['third', 'first']),
      project('newer', 'Newer', ['second']),
    ]
    const nodes = deriveProjectTree(list(), workspaces, projects, noRows, noStatuses, view())
    expect(nodes.map(node => node.key)).toEqual(['older', 'newer'])
    // Membership order never decides what the section renders first.
    expect(nodes[0]?.workspaces.map(group => group.key)).toEqual(['first', 'third'])
  })

  it('ignores membership ids whose Workspace no longer exists', () => {
    const workspaces = [workspace('alive')]
    const projects = [project('p1', 'Stale', ['alive', 'deleted'])]
    const nodes = deriveProjectTree(list(), workspaces, projects, noRows, noStatuses, view())
    expect(nodes.map(node => node.workspaceCount)).toEqual([1])
    expect(nodes[0]?.workspaces.map(group => group.key)).toEqual(['alive'])
  })

  it('renders a Workspace claimed by two projects only under the first project', () => {
    const workspaces = [workspace('shared')]
    const projects = [project('first', 'First', ['shared']), project('second', 'Second', ['shared'])]
    const nodes = deriveProjectTree(list(), workspaces, projects, noRows, noStatuses, view())
    expect(nodes.map(node => node.workspaceCount)).toEqual([1, 0])
    expect(nodes[0]?.workspaces.map(group => group.key)).toEqual(['shared'])
  })

  it('keeps a project with no Workspace visible so it can still be managed', () => {
    const nodes = deriveProjectTree(list(), [], [project('empty', 'Empty')], noRows, noStatuses, view())
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ key: 'empty', workspaceCount: 0, workspaces: [] })
  })

  it('marks the section holding the current Session', () => {
    const workspaces = [workspace('owned', ['s1']), workspace('loose', ['s2'])]
    const projects = [project('p1', 'One', ['owned'])]
    const sessions = withMain(list(summary('s1', 2), summary('s2', 1)), sid('s1'))
    const nodes = deriveProjectTree(sessions, workspaces, projects, noRows, noStatuses, view())
    expect(nodes[0]).toMatchObject({ key: 'p1', containsCurrent: true })
    expect(nodes[1]).toMatchObject({ key: UNGROUPED_KEY, containsCurrent: false })

    const unassignedCurrent = withMain(list(summary('s1', 2), summary('s2', 1)), sid('s2'))
    const unassignedNodes = deriveProjectTree(unassignedCurrent, workspaces, projects, noRows, noStatuses, view())
    expect(unassignedNodes[0]).toMatchObject({ key: 'p1', containsCurrent: false })
    expect(unassignedNodes[1]).toMatchObject({ key: UNGROUPED_KEY, containsCurrent: true })
  })

  it('keeps Sessions outside every Workspace in the unassigned bucket', () => {
    const sessions = list(summary('stray', 1))
    const nodes = deriveProjectTree(sessions, [], [], noRows, noStatuses, view([UNGROUPED_KEY]))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.projectId).toBeUndefined()
    expect(nodes[0]?.workspaces.map(group => group.workspaceId)).toEqual([undefined])
    expect(nodes[0]?.workspaces[0]?.sessions.map(session => session.id)).toEqual([sid('stray')])
  })

  it('drops sections without a visible Workspace under the archived-only filter', () => {
    const workspaces = [workspace('active', ['sa']), workspace('archived', ['sb']), workspace('silent', ['sc'])]
    const projects = [
      project('p1', 'Has archive', ['archived']),
      project('p2', 'No archive', ['active']),
      project('p3', 'Empty', []),
    ]
    const sessions = list(summary('sa', 3), summary('sb', 2), summary('sc', 1))
    const nodes = deriveProjectTree(
      sessions, workspaces, projects, rowState({ archived: ['sb'], archivedFilter: 'only' }), noStatuses, view(),
    )
    expect(nodes.map(node => node.key)).toEqual(['p1'])
    expect(nodes[0]?.workspaces.map(group => group.key)).toEqual(['archived'])
  })

  it('renders the unassigned bucket only when it holds something', () => {
    const nodes = deriveProjectTree(list(), [workspace('owned')], [project('p1', 'One', ['owned'])], noRows, noStatuses, view())
    expect(nodes.map(node => node.key)).toEqual(['p1'])
  })

  it('follows the archived filter for the unassigned bucket too', () => {
    const sessions = list(summary('stray', 1))
    const only = deriveProjectTree(
      sessions, [], [], rowState({ archivedFilter: 'only' }), noStatuses, view(),
    )
    expect(only).toEqual([])
    const shown = deriveProjectTree(
      sessions, [], [], rowState({ archivedFilter: 'show' }), noStatuses, view(),
    )
    expect(shown.map(node => node.key)).toEqual([UNGROUPED_KEY])
  })
})
