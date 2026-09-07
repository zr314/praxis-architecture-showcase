import type { RecapCase } from './cases.js'

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** Original deterministic simulations inspired by cancellation and scheduling failure classes.
 * They test rule transfer, not execution of Python/ICS implementations from Terminal-Bench.
 */
export function systemsRecapCases(): readonly RecapCase[] {
  const cancellationRules = [
    'All jobs are ready at t=0; start them in input order while slots are free.',
    'A job holds its slot through its cleanup, including after success, failure or cancellation.',
    'A running job reaches its outcome at start+duration; cleanup starts immediately and lasts cleanup ticks.',
    'Read current policy.json: mode=fail_fast cancels all other running jobs at the first failure and never starts queued jobs after that failure.',
    'Jobs already cleaning up are not cancelled again. Their original outcome and cleanup end stay unchanged.',
    'mode=drain never cancels siblings and starts queued jobs as slots become free even after failures.',
    'At each timestamp process natural outcomes first, then failure-triggered cancellation, then cleanup completions, then dispatch queued jobs.',
    'A naturally completed job at the failure timestamp keeps its outcome. Each started job runs cleanup exactly once.',
    'Return after every started job has finished cleanup. Report error=true if any job failed.',
    'Output field end is the time the job succeeds, fails, or is cancelled; for cancellation it is the cancellation timestamp. start, end and cleanupEnd are all null only for not_started jobs.',
    'Write answer.json as {"jobs":[{"id":string,"start":number|null,"outcome":"ok"|"failed"|"cancelled"|"not_started","end":number|null,"cleanupEnd":number|null}],"returnAt":number,"error":boolean}. Preserve input job order.',
  ].join('\n')
  const jobs = [
    { id: 'a', duration: 4, outcome: 'failed', cleanup: 3 },
    { id: 'b', duration: 7, outcome: 'ok', cleanup: 2 },
    { id: 'c', duration: 2, outcome: 'ok', cleanup: 1 },
    { id: 'd', duration: 1, outcome: 'failed', cleanup: 1 },
    { id: 'e', duration: 3, outcome: 'ok', cleanup: 2 },
    { id: 'f', duration: 1, outcome: 'ok', cleanup: 1 },
  ]
  const job = (
    id: string,
    start: number | null,
    outcome: string,
    end: number | null,
    cleanupEnd: number | null,
  ) => ({ id, start, outcome, end, cleanupEnd })
  const scheduleRules = [
    'Find all valid meetings at a 15-minute start grid using UTC minutes since midnight. The meeting must fit within every attendee availability window.',
    'Busy intervals and the proposed meeting are half-open [start,end); touching endpoints do not overlap.',
    'For each attendee extend the end of each existing busy interval by policy.bufferAfter minutes before checking conflicts. Never extend the start.',
    'Attendee C is additionally unavailable [720,750) each day for lunch; lunch does not receive a buffer.',
    'Read current policy.json for duration, bufferAfter, and ranking. Never reuse historical values without checking.',
    'ranking=preferred_day_first sorts valid candidates by membership of preferredDays first, then by ascending day, then start.',
    'ranking=earliest_first sorts by ascending day then start; preferredDays is informational only in this mode.',
    'Do not sacrifice hard constraints for preferences. Return the first three ranked valid candidates, including overlapping alternatives.',
    'Write answer.json as {"slots":[{"day":number,"start":number,"end":number},...]}. Return fewer than three if fewer exist.',
  ].join('\n')
  const calendar = {
    days: [1, 2, 3],
    attendees: [
      {
        id: 'A',
        availability: [540, 840],
        busy: [
          { day: 1, start: 600, end: 660 },
          { day: 2, start: 540, end: 600 },
          { day: 3, start: 660, end: 720 },
        ],
      },
      {
        id: 'B',
        availability: [600, 1020],
        busy: [
          { day: 1, start: 660, end: 720 },
          { day: 2, start: 780, end: 840 },
          { day: 3, start: 600, end: 630 },
        ],
      },
      {
        id: 'C',
        availability: [540, 1020],
        busy: [
          { day: 1, start: 780, end: 840 },
          { day: 2, start: 675, end: 720 },
          { day: 3, start: 825, end: 855 },
        ],
      },
    ],
  }
  return [
    {
      id: 'async-cleanup',
      learning: {
        files: {
          'rules.txt': cancellationRules,
          'policy.json': json({ mode: 'fail_fast', maxConcurrent: 2 }),
          'incidents.txt':
            'A previous implementation released slots before cleanup finished and cancelled cleaning-up jobs a second time. It also started queued jobs after a fail-fast error. Cleanup completion, not outcome time, controls slot reuse and return time.',
        },
        prompt:
          'Study rules.txt, policy.json and incidents.txt. Explain reusable cancellation and cleanup rules and pitfalls. No future jobs are available.',
      },
      targets: [
        {
          id: 'reuse',
          files: {
            'rules.txt': cancellationRules,
            'policy.json': json({ mode: 'fail_fast', maxConcurrent: 2 }),
            'jobs.json': json(jobs),
          },
          prompt: 'Simulate jobs.json under the current rules and policy and write answer.json.',
          expected: {
            jobs: [
              job('a', 0, 'failed', 4, 7),
              job('b', 0, 'cancelled', 4, 6),
              ...['c', 'd', 'e', 'f'].map((id) => job(id, null, 'not_started', null, null)),
            ],
            returnAt: 7,
            error: true,
          },
        },
        {
          id: 'updated',
          files: {
            'rules.txt': cancellationRules,
            'policy.json': json({ mode: 'drain', maxConcurrent: 2 }),
            'jobs.json': json(jobs),
          },
          prompt: 'Simulate jobs.json under the current rules and policy and write answer.json.',
          expected: {
            jobs: [
              job('a', 0, 'failed', 4, 7),
              job('b', 0, 'ok', 7, 9),
              job('c', 7, 'ok', 9, 10),
              job('d', 9, 'failed', 10, 11),
              job('e', 10, 'ok', 13, 15),
              job('f', 11, 'ok', 12, 13),
            ],
            returnAt: 15,
            error: true,
          },
        },
      ],
    },
    {
      id: 'meeting-constraints',
      learning: {
        files: {
          'rules.txt': scheduleRules,
          'policy.json': json({
            duration: 45,
            bufferAfter: 15,
            ranking: 'preferred_day_first',
            preferredDays: [3],
          }),
          'incidents.txt':
            'A prior solver made preferences into hard constraints, incorrectly rejected touching endpoints, and skipped overlapping alternative meeting slots. Another solver applied cleanup buffers before existing meetings instead of after them.',
        },
        prompt:
          'Study rules.txt, policy.json and incidents.txt. Explain reusable scheduling rules and pitfalls. No future calendars are available.',
      },
      targets: [
        {
          id: 'reuse',
          files: {
            'rules.txt': scheduleRules,
            'policy.json': json({
              duration: 45,
              bufferAfter: 15,
              ranking: 'preferred_day_first',
              preferredDays: [3],
            }),
            'calendar.json': json(calendar),
          },
          prompt:
            'Find the requested ranked slots in calendar.json using current rules and policy; write answer.json.',
          expected: {
            slots: [
              { day: 3, start: 750, end: 795 },
              { day: 3, start: 765, end: 810 },
              { day: 3, start: 780, end: 825 },
            ],
          },
        },
        {
          id: 'updated',
          files: {
            'rules.txt': scheduleRules,
            'policy.json': json({
              duration: 30,
              bufferAfter: 0,
              ranking: 'earliest_first',
              preferredDays: [3],
            }),
            'calendar.json': json(calendar),
          },
          prompt:
            'Find the requested ranked slots in calendar.json using current rules and policy; write answer.json.',
          expected: {
            slots: [
              { day: 1, start: 750, end: 780 },
              { day: 2, start: 600, end: 630 },
              { day: 2, start: 615, end: 645 },
            ],
          },
        },
      ],
    },
  ]
}
