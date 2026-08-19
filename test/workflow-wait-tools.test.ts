import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'
import {
  WorkflowHumanTaskToolV1,
  WorkflowTimerToolV1,
} from '../apps/runtime/src/workflow/workflowWaitTools.js'

test('human task pauses a live Workflow and resumes its durable node after approval', async () => {
  const fixture = await createFixture()
  try {
    const tool = new WorkflowHumanTaskToolV1(fixture.orchestrator, fixture.workflowId)
    const resultPromise = tool.execute(
      request('workflow.human_task', { question: 'Approve this action?' }),
    )
    const task = await waitFor(async () => {
      const [candidate] = await fixture.authority.listHumanTasks(fixture.workflowId, ['waiting'])
      return candidate
    })
    assert.equal((await fixture.authority.get(fixture.workflowId)).state, 'waiting')
    await fixture.authority.resolveHumanTask(task.humanTaskId, 'allowed', { actor: 'tester' })
    const result = await resultPromise
    assert.equal(result.ok, true)
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(projection.state, 'running')
    assert.equal(projection.nodes.find(({ nodeId }) => nodeId === task.nodeId)?.state, 'succeeded')
  } finally {
    await fixture.close()
  }
})

test('timer persists, fires once, and releases the waiting Tool', async () => {
  const fixture = await createFixture()
  try {
    const result = await new WorkflowTimerToolV1(fixture.orchestrator, fixture.workflowId).execute(
      request('workflow.timer', { purpose: 'Brief wait', delayMs: 20 }),
    )
    assert.equal(result.ok, true)
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(projection.spec.nodes.filter(({ kind }) => kind === 'timer').length, 1)
    assert.equal(
      projection.nodes.find(({ nodeId }) => nodeId.startsWith('timer-'))?.state,
      'succeeded',
    )
    assert.deepEqual(await fixture.authority.fireDueTimers(), [])
  } finally {
    await fixture.close()
  }
})

test('waiting human and timer nodes survive authority reconstruction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-wait-restart-'))
  let authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    let orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await start(orchestrator)
    const human = await orchestrator.admitHumanTask(projection.workflowId, {
      question: 'Continue?',
    })
    const timer = await orchestrator.admitTimer(
      projection.workflowId,
      '2026-08-06T00:00:01.000Z',
      { purpose: 'resume' },
      '2026-08-06T00:00:00.000Z',
    )
    authority.close()

    authority = new SqliteWorkflowAuthorityV1(root)
    await authority.initialize()
    orchestrator = new WorkflowOrchestratorV1(authority)
    await authority.resolveHumanTask(human.humanTask.humanTaskId, 'allowed', { actor: 'restart' })
    assert.equal((await authority.fireDueTimers('2026-08-06T00:00:01.000Z')).length, 1)
    const recovered = await orchestrator.get(projection.workflowId)
    assert.equal(recovered.nodes.find(({ nodeId }) => nodeId === human.nodeId)?.state, 'succeeded')
    assert.equal(recovered.nodes.find(({ nodeId }) => nodeId === timer.nodeId)?.state, 'succeeded')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('expired HumanTask is resolved once by the restart-safe wake pump primitive', async () => {
  const fixture = await createFixture()
  try {
    const admitted = await fixture.orchestrator.admitHumanTask(
      fixture.workflowId,
      { question: 'Respond before deadline.' },
      '2026-08-06T00:00:01.000Z',
      '2026-08-06T00:00:00.000Z',
    )
    assert.deepEqual(await fixture.authority.expireDueHumanTasks('2026-08-06T00:00:00.999Z'), [])
    assert.equal(
      (await fixture.authority.expireDueHumanTasks('2026-08-06T00:00:01.000Z')).length,
      1,
    )
    assert.deepEqual(await fixture.authority.expireDueHumanTasks('2026-08-06T00:00:02.000Z'), [])
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(projection.nodes.find(({ nodeId }) => nodeId === admitted.nodeId)?.state, 'failed')
  } finally {
    await fixture.close()
  }
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-wait-tool-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  await authority.initialize()
  await registerBuiltinAgentProfilesV1(authority)
  const orchestrator = new WorkflowOrchestratorV1(authority)
  const projection = await start(orchestrator)
  return {
    authority,
    orchestrator,
    workflowId: projection.workflowId,
    close: async () => {
      authority.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function start(orchestrator: WorkflowOrchestratorV1) {
  const projection = await orchestrator.start({
    sessionId: 'session-wait',
    parentRunId: 'run-wait',
    objective: 'Wait durably.',
    modePolicy: 'auto',
    cwd: 'D:/praxis',
    rootGrant: {
      tools: ['*'],
      skills: ['*'],
      mcpServers: ['*'],
      workspace: 'write',
      network: true,
      mayDelegate: true,
    },
  })
  const claim = await orchestrator.claimRoot(projection.workflowId, 'root-wait')
  await orchestrator.markRunning(claim)
  return projection
}

function request(name: string, input: Record<string, unknown>) {
  return { name, input, cwd: 'D:/praxis', signal: new AbortController().signal }
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('WAIT_TIMEOUT')
}
