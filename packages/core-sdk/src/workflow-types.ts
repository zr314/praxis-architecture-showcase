/** Leaf Workflow identities shared by execution and Authority contracts. */
export type WorkflowTaskKindV1 = 'agent' | 'tool' | 'verification' | 'compensation' | 'subworkflow'

export type VersionedWorkflowRefV1 = Readonly<{
  id: string
  version: number
  digest?: `sha256:${string}`
}>
