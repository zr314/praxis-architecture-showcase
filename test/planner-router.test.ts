import assert from 'node:assert/strict'
import test from 'node:test'
import { isRuntimeError } from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../apps/runtime/src/longLivedExecutionPolicy.js'
import { PlannerRouter, normalizePlannerModeV1 } from '../apps/runtime/src/planner/plannerRouter.js'
import type { Planner } from '../apps/runtime/src/planner-api/index.js'

test('PlannerRouter defaults to auto and always selects the unified implementation', async () => {
  const calls: string[] = []
  const unified: Planner = { execute: async () => void calls.push('unified') }
  const router = new PlannerRouter()

  assert.deepEqual(router.route(), {
    mode: 'auto',
    enabled: true,
    access: 'workspace_write',
    childBudget: {
      maxChildRuns: LONG_LIVED_EXECUTION_POLICY_V1.maxChildRuns,
      maxParallelChildren: LONG_LIVED_EXECUTION_POLICY_V1.maxParallelChildren,
      maxDepth: LONG_LIVED_EXECUTION_POLICY_V1.maxDepth,
    },
  })
  await router.select(unified, 'solo').execute({} as never)
  await router.select(unified, 'workflow').execute({} as never)
  assert.deepEqual(calls, ['unified', 'unified'])
})

test('solo is a policy override that removes child authority without changing implementation', () => {
  assert.deepEqual(new PlannerRouter({ mode: 'solo' }).route().childBudget, {
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  })
})

test('legacy public values migrate to the new policies', () => {
  assert.equal(normalizePlannerModeV1('direct'), 'solo')
  assert.equal(normalizePlannerModeV1('supervisor'), 'workflow')
  assert.equal(new PlannerRouter({ mode: 'supervisor' }).defaultMode(), 'workflow')
})

test('PlannerRouter rejects unknown configuration instead of inferring a mode', () => {
  for (const input of [{ mode: 'invalid' }, { supervisorPreview: 'test' }, { unknown: true }]) {
    assert.throws(
      () => new PlannerRouter(input as never),
      (error) => isRuntimeError(error) && error.code === 'PLANNER_ROUTER_CONFIG_INVALID',
    )
  }
})
