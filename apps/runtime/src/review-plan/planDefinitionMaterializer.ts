import {
  canonicalDigestV1,
  validatePlanCreateInputV1,
  type PlanCreateInputV1,
} from '@praxis/core-sdk'
import type {
  MaterializedPlanDefinitionV1,
  PlanDefinitionMaterializerV1,
} from './planControlPorts.js'

export class CanonicalPlanDefinitionMaterializerV1 implements PlanDefinitionMaterializerV1 {
  async materialize(input: {
    sessionId: string
    objective: string
    criteria: PlanCreateInputV1['acceptanceCriteria']
    items: PlanCreateInputV1['items']
    reviewPolicy?: PlanCreateInputV1['reviewPolicy']
  }): Promise<MaterializedPlanDefinitionV1> {
    const definition = validatePlanCreateInputV1({
      objective: input.objective,
      acceptanceCriteria: input.criteria,
      items: input.items,
      ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
    })
    return Object.freeze({
      input: definition,
      definitionDigest: canonicalDigestV1({ sessionId: input.sessionId, definition }),
    })
  }
}
