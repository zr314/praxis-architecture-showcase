import assert from 'node:assert/strict'
import test from 'node:test'
import { systemsRecapCases } from '../apps/runtime/src/evaluation/recap/systemsCases.js'

test('async task answers match independent tick simulation including held cleanup slots', () => {
  for (const target of systemsRecapCases()[0]!.targets) {
    const policy = JSON.parse(target.files['policy.json']!)
    const inputs = JSON.parse(target.files['jobs.json']!) as {
      id: string
      duration: number
      outcome: string
      cleanup: number
    }[]
    const jobs = inputs.map((j) => ({
      id: j.id,
      start: null as number | null,
      outcome: 'not_started',
      end: null as number | null,
      cleanupEnd: null as number | null,
    }))
    let failed = false
    let returnAt = -1
    for (let t = 0; t < 100; t++) {
      for (const [i, j] of jobs.entries())
        if (j.start !== null && j.end === null && t === j.start + inputs[i]!.duration) {
          j.outcome = inputs[i]!.outcome
          j.end = t
          j.cleanupEnd = t + inputs[i]!.cleanup
          failed ||= j.outcome === 'failed'
        }
      if (failed && policy.mode === 'fail_fast')
        for (const [i, j] of jobs.entries())
          if (j.start !== null && j.end === null) {
            j.outcome = 'cancelled'
            j.end = t
            j.cleanupEnd = t + inputs[i]!.cleanup
          }
      let active = jobs.filter(
        (j) => j.start !== null && (j.cleanupEnd === null || j.cleanupEnd > t),
      ).length
      if (!(failed && policy.mode === 'fail_fast'))
        for (const j of jobs)
          if (j.start === null && active < policy.maxConcurrent) {
            j.start = t
            active++
          }
      if (
        !active &&
        (jobs.every((j) => j.start !== null) || (failed && policy.mode === 'fail_fast'))
      ) {
        returnAt = t
        break
      }
    }
    assert.deepEqual({ jobs, returnAt, error: failed }, target.expected)
  }
})

test('meeting answers match exhaustive grid search with half-open intervals, buffers and policy ranking', () => {
  for (const target of systemsRecapCases()[1]!.targets) {
    const policy = JSON.parse(target.files['policy.json']!)
    const calendar = JSON.parse(target.files['calendar.json']!) as {
      days: number[]
      attendees: {
        id: string
        availability: number[]
        busy: { day: number; start: number; end: number }[]
      }[]
    }
    const slots: { day: number; start: number; end: number }[] = []
    for (const day of calendar.days)
      for (let start = 0; start < 1440; start += 15) {
        const end = start + policy.duration
        if (
          calendar.attendees.every(
            (a) =>
              start >= a.availability[0]! &&
              end <= a.availability[1]! &&
              !(a.id === 'C' && start < 750 && end > 720) &&
              a.busy.every(
                (b) => b.day !== day || end <= b.start || start >= b.end + policy.bufferAfter,
              ),
          )
        )
          slots.push({ day, start, end })
      }
    const rank = (day: number) =>
      policy.ranking === 'preferred_day_first' && !policy.preferredDays.includes(day) ? 1 : 0
    slots.sort((a, b) => rank(a.day) - rank(b.day) || a.day - b.day || a.start - b.start)
    assert.deepEqual({ slots: slots.slice(0, 3) }, target.expected)
  }
})
