import type { ReviewCriterionProjectionV1, ReviewPlanProjectionV1 } from '@praxis/core-sdk'

/** Runtime-owned interpretation of the review boundary, not a new model-authored plan. */
export function reviewScopeContextV1(plan: ReviewPlanProjectionV1, itemId?: string) {
  return {
    kind: itemId === undefined ? 'final' : 'item',
    currentItemId: itemId ?? null,
    wholeTaskCompletionRequired: itemId === undefined,
    items: plan.items.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      criterionIds: item.criterionIds,
    })),
    criteria: plan.criteria
      .filter(({ status }) => status === 'active')
      .map(({ id, description }) => ({ id, description })),
  }
}

/** A successful predicate must not silently inherit the model's broader prose claim. */
export function mechanicalProofBoundaryV1(criterion: ReviewCriterionProjectionV1) {
  if (criterion.kind !== 'mechanical') return undefined
  const check = criterion.check
  const proves =
    check.checker === 'file_rule'
      ? check.rule.kind === 'exists'
        ? 'The prepared workspace path exists.'
        : 'The prepared file bytes match the supplied digest.'
      : check.checker === 'content_digest'
        ? 'A supplied artifact matches the supplied digest.'
        : check.checker === 'registered_check'
          ? 'The Host-registered check returned a configured successful exit code for its declared contract.'
          : 'A matching Runtime-recorded receipt or result exists and reports success.'
  return {
    criterionId: criterion.id,
    check,
    proves,
    doesNotProve:
      'The natural-language criterion or original task is satisfied beyond this predicate. A candidate-supplied expected digest is not an independent correctness oracle.',
  }
}
