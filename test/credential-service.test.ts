import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatProvider } from '@praxis/core-sdk'
import { CredentialService } from '../apps/runtime/src/credentials/credentialService.js'
import type { RuntimeExtensions } from '../apps/runtime/src/extensions/index.js'
import { RuntimeKernel } from '../apps/runtime/src/framework/runtimeKernel.js'
import { KimiProvider } from '../apps/runtime/src/providers/kimiProvider.js'
import { MockProvider } from '../apps/runtime/src/providers/mockProvider.js'
import { NoopTraceService } from '../apps/runtime/src/trace/index.js'

function createService() {
  const providers = new Map<string, ChatProvider>([
    ['kimi', new KimiProvider('')],
    ['mock', new MockProvider()],
  ])
  return new CredentialService((id) => providers.get(id))
}

test('reports authenticated state owned by the resolved Provider', async () => {
  const service = createService()

  assert.equal((await service.status('mock')).status, 'authenticated')
})

test('logout explicitly overrides only the selected Provider state', async () => {
  const service = createService()

  await service.logout('kimi')

  assert.equal((await service.status('kimi')).status, 'unauthenticated')
  assert.equal((await service.status('mock')).status, 'authenticated')
})

test('login clears the logout override and returns Kimi setup instructions', async () => {
  const service = createService()
  await service.logout('kimi')

  const result = await service.login('kimi')

  assert.match(result.loginId, /^login-/)
  assert.deepEqual(result.action, {
    action: 'device_code',
    deviceCode: 'Enter an API key in the TUI or set MOONSHOT_API_KEY in the Runtime environment.',
  })
  assert.equal(result.state.status, 'unauthenticated')
})

test('login applies and stores an API key without restarting the Provider', async () => {
  const provider = new KimiProvider('')
  const credentials = new Map<string, string>()
  const service = new CredentialService((id) => (id === 'kimi' ? provider : undefined), {
    store: {
      async get(providerId, name) {
        const value = credentials.get(`${providerId}/${name}`)
        return value
          ? {
              provider: providerId,
              name,
              value,
              updatedAt: new Date(0).toISOString(),
            }
          : undefined
      },
      async set(credential) {
        credentials.set(`${credential.provider}/${credential.name}`, credential.value)
      },
      async delete(providerId, name) {
        for (const key of [...credentials.keys()]) {
          if (
            key.startsWith(`${providerId}/`) &&
            (name === undefined || key === `${providerId}/${name}`)
          ) {
            credentials.delete(key)
          }
        }
      },
      async list() {
        return []
      },
      async protectionStatus() {
        return { encrypted: true, backend: 'test-encrypted-store', osDelegated: false }
      },
    },
  })

  const result = await service.login('kimi', 'stored-test-key')

  assert.equal(result.state.status, 'authenticated')
  assert.deepEqual(await service.status('kimi'), {
    status: 'authenticated',
    accountLabel: 'Stored credential',
  })
  assert.deepEqual(await service.details('kimi'), {
    state: {
      status: 'authenticated',
      accountLabel: 'Stored credential',
    },
    source: 'stored',
    environmentVariable: 'MOONSHOT_API_KEY',
    protection: {
      encrypted: true,
      backend: 'test-encrypted-store',
      osDelegated: false,
    },
  })
  assert.equal(credentials.get('kimi/apiKey'), 'stored-test-key')
  await service.logout('kimi')
  assert.equal(provider.authState().status, 'unauthenticated')
})

test('rejects unknown Providers from every credential operation', async () => {
  const service = createService()

  await assert.rejects(() => service.status('unknown'), /Unknown provider: unknown\./)
  await assert.rejects(() => service.login('unknown'), /Unknown provider: unknown\./)
  await assert.rejects(() => service.logout('unknown'), /Unknown provider: unknown\./)
})

test('an injected CredentialService controls default Provider selection', async () => {
  const providers = new Map<string, ChatProvider>([
    ['kimi', new KimiProvider('test-key')],
    ['mock', new MockProvider()],
  ])
  const credentials = new CredentialService((id) => providers.get(id))
  const extensions: RuntimeExtensions = {
    initialize: async () => {
      throw new Error('not used by this test')
    },
    provider: async (id) => providers.get(id),
    providerIds: () => [...providers.keys()],
    shutdown: async () => {},
  }
  const kernel = new RuntimeKernel({
    credentials,
    extensions,
    traceService: new NoopTraceService(),
  })
  await credentials.logout('kimi')

  const defaultProviderId = await (
    kernel as unknown as { defaultProviderId(): Promise<string> }
  ).defaultProviderId()

  assert.equal(defaultProviderId, 'mock')
})
