import {
  isChildBootstrapFailure,
  readChildBootstrapProfileFromProcess,
} from '../../apps/runtime/src/subagent/childBootstrapProfile.js'

try {
  const profile = readChildBootstrapProfileFromProcess()
  if (!profile) throw new Error('Bootstrap profile was not requested.')
  process.stdout.write(
    `${JSON.stringify({
      parentRunId: profile.parentRunId,
      childRunId: profile.childRunId,
      workspace: profile.workspace,
      frozen: Object.isFrozen(profile) && Object.isFrozen(profile.workspace),
      launchEnvironmentScrubbed:
        process.env.PRAXIS_CHILD_BOOTSTRAP === undefined &&
        process.env.PRAXIS_CHILD_BOOTSTRAP_KEY === undefined,
    })}\n`,
  )
} catch (error) {
  process.stderr.write(
    `${isChildBootstrapFailure(error) ? error.code : 'BOOTSTRAP_PROBE_FAILED'}\n`,
  )
  process.exitCode = 1
}
