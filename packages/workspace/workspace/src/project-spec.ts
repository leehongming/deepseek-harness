/**
 * The project domain declaration: the durable grouping above Workspaces. All
 * project state lives in the global singleton as one ordered array, so create,
 * rename, delete, and membership changes are each one atomic write and one
 * `domain/changed` notification. The array order is the display order (newest
 * created first).
 * @module @deepseek-ai/dsh-workspace/src/project-spec
 */

import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectId, WorkspaceId } from './types.ts'

/** Project id schema at the durable boundary; branding has no runtime representation. */
const projectId = z.string().transform(value => value as ProjectId)

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

/**
 * Durable shape of one project record. `workspaceIds` is the membership
 * account in project order; timestamps are ISO-8601 strings.
 */
export const projectRecord = z.object({
  id: projectId,
  title: z.string(),
  workspaceIds: z.array(workspaceId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored project record, inferred from {@link projectRecord}. */
export type ProjectRecord = z.infer<typeof projectRecord>

/**
 * Durable project domain state: every project in display order. The array is
 * the only stored value, so no two-write mutation marker is needed.
 */
export const projectDomainState = z.object({
  projects: z.array(projectRecord),
})

/** Durable registry state inferred from {@link projectDomainState}. */
export type ProjectDomainState = z.infer<typeof projectDomainState>

/**
 * The project domain spec: the `projects` global singleton and no tables. The
 * registry opens this through `ctx.storageDomain`; the spec object is the
 * single source of the domain's identity, version, and schema.
 */
export const projectDomainSpec = defineDomain({
  name: 'project',
  version: 1,
  global: {
    schema: projectDomainState,
    initial: { projects: [] },
  },
  tables: {},
})
