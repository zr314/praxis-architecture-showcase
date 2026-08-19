import { redactDiagnosticData } from '@praxis/core-sdk'
import { resolve } from 'node:path'
import { canonicalGrantPath } from '../security/pathSafety.js'

export type PolicyGrant = {
  workspace: string
  tool: string
  rule: string
  target?: string
  grantedAt: string
  expiresAt?: string
  pluginId?: string
}

export type PolicyAuditRecord = {
  workspace: string
  tool: string
  rule: string
  decision: 'allow' | 'allow_once' | 'allow_always' | 'deny' | 'ask'
  target?: string
  data?: Record<string, unknown>
}

export type PolicyRequest = Pick<PolicyAuditRecord, 'workspace' | 'tool' | 'rule' | 'target'>

export interface PolicyStore {
  loadGrants(): Promise<PolicyGrant[]>
  saveGrants(grants: PolicyGrant[]): Promise<void>
  appendAudit(record: PolicyAuditRecord): Promise<void>
}

/** Owns narrowly-scoped durable grants and redacted decision records. */
export class PolicyEngine {
  private grants: PolicyGrant[] = []

  constructor(private readonly store: PolicyStore) {}

  async initialize(): Promise<void> {
    this.grants = await this.store.loadGrants()
  }

  allows(request: Pick<PolicyRequest, 'workspace' | 'tool' | 'rule'>): boolean {
    const now = Date.now()
    return this.grants.some(
      (grant) =>
        grant.workspace === request.workspace &&
        grant.tool === request.tool &&
        grant.rule === request.rule &&
        (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now),
    )
  }

  async grant(request: PolicyRequest): Promise<void> {
    if (!this.allows(request)) {
      this.grants = [...this.grants, { ...request, grantedAt: new Date().toISOString() }]
      await this.store.saveGrants(this.grants.map((grant) => ({ ...grant })))
    }
    await this.record({ ...request, decision: 'allow_always' })
  }

  async grantExpiring(
    request: PolicyRequest,
    options: { expiresAt: string; pluginId?: string },
  ): Promise<void> {
    if (!Number.isFinite(Date.parse(options.expiresAt))) {
      throw new TypeError('expiresAt must be an ISO timestamp.')
    }
    const normalized = normalizeRequest(request)
    this.grants = [
      ...this.grants.filter(
        (grant) =>
          !(
            grant.workspace === normalized.workspace &&
            grant.tool === normalized.tool &&
            grant.rule === normalized.rule
          ),
      ),
      {
        ...normalized,
        grantedAt: new Date().toISOString(),
        expiresAt: options.expiresAt,
        ...(options.pluginId ? { pluginId: options.pluginId } : {}),
      },
    ]
    await this.store.saveGrants(this.grants.map((grant) => ({ ...grant })))
    await this.record({ ...normalized, decision: 'allow_always' })
  }

  async revoke(filter: {
    workspace?: string
    tool?: string
    rule?: string
    pluginId?: string
  }): Promise<number> {
    const before = this.grants.length
    this.grants = this.grants.filter(
      (grant) =>
        !(
          (filter.workspace === undefined || grant.workspace === resolve(filter.workspace)) &&
          (filter.tool === undefined || grant.tool === filter.tool) &&
          (filter.rule === undefined || grant.rule === filter.rule) &&
          (filter.pluginId === undefined || grant.pluginId === filter.pluginId)
        ),
    )
    await this.store.saveGrants(this.grants.map((grant) => ({ ...grant })))
    return before - this.grants.length
  }

  async migrate(): Promise<{ version: 2; removedExpired: number }> {
    const now = Date.now()
    const before = this.grants.length
    this.grants = this.grants
      .filter((grant) => grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now)
      .map((grant) => ({
        ...grant,
        workspace: resolve(grant.workspace),
        ...(grant.target ? { target: canonicalGrantPath(grant.workspace, grant.target) } : {}),
      }))
    await this.store.saveGrants(this.grants.map((grant) => ({ ...grant })))
    return { version: 2, removedExpired: before - this.grants.length }
  }

  async record(record: PolicyAuditRecord): Promise<void> {
    await this.store.appendAudit({
      workspace: record.workspace,
      tool: record.tool,
      rule: record.rule,
      decision: record.decision,
      ...(record.target === undefined ? {} : { target: record.target }),
      ...(record.data === undefined ? {} : { data: redactPolicyAuditData(record.data) }),
    })
  }
}

function normalizeRequest(request: PolicyRequest): PolicyRequest {
  const workspace = resolve(request.workspace)
  return {
    ...request,
    workspace,
    ...(request.target ? { target: canonicalGrantPath(workspace, request.target) } : {}),
  }
}

function redactPolicyAuditData(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactDiagnosticData(data)
  for (const key of ['command', 'input', 'payload', 'arguments', 'content', 'path'])
    delete redacted[key]
  return redacted
}
