import { Box, Text } from 'ink'
import type { ModelInfo } from '@praxis/protocol'
import {
  catalogModelCounts,
  type CatalogPickerState,
  pickerWindow,
  type ProviderOption,
  visibleModels,
  visibleProviders,
} from './catalogPickerModel.js'
import { compactNumber, palette } from './theme.js'

type ReadyState = Extract<CatalogPickerState, { status: 'ready' }>

type Props = {
  state: CatalogPickerState
  spinner: string
  compact: boolean
}

export function CatalogPicker({ state, spinner, compact }: Props) {
  return (
    <Box
      borderStyle="double"
      borderColor={palette.accentStrong}
      flexDirection="column"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text bold backgroundColor={palette.accent} color="#07111f">
            {' CATALOG '}
          </Text>
          <Text bold color={palette.ink}>
            {'  '}
            {state.view === 'credentials'
              ? 'CONNECT PROVIDER'
              : state.view === 'providers' && state.intent === 'login'
                ? 'CONFIGURE PROVIDER'
                : state.view === 'providers' && state.intent === 'logout'
                  ? 'DISCONNECT PROVIDER'
                  : `SELECT ${state.view === 'providers' ? 'PROVIDER' : 'MODEL'}`}
          </Text>
        </Box>
        {!compact && state.view !== 'credentials' ? (
          <Text color={palette.muted}>
            CURRENT{' '}
            <Text color={palette.violet}>
              {state.currentProvider}/{state.currentModel}
            </Text>
          </Text>
        ) : null}
      </Box>

      {state.status === 'loading' ? (
        <Box marginY={1}>
          <Text color={palette.mint}>
            {spinner}{' '}
            {state.view === 'credentials' ? 'CONNECTING PROVIDER…' : 'REFRESHING MODEL CATALOG…'}
          </Text>
        </Box>
      ) : (
        <>
          {state.view === 'credentials' ? (
            <CredentialForm state={state} />
          ) : (
            <SearchLine query={state.query} />
          )}
          {state.view === 'providers' ? (
            <ProviderList compact={compact} state={state} />
          ) : state.view === 'models' ? (
            <ModelList compact={compact} state={state} />
          ) : null}
        </>
      )}

      {state.notice ? (
        <Box marginTop={1}>
          <Text color={palette.amber}>◆ {state.notice}</Text>
        </Box>
      ) : null}

      <ShortcutBar compact={compact} state={state} />
    </Box>
  )
}

function CredentialForm({ state }: { state: ReadyState }) {
  const secret = state.credential ?? ''
  const masked = secret
    ? `${'•'.repeat(Math.min(secret.length, 24))}${secret.length > 24 ? '…' : ''}`
    : ''
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={palette.muted}>PROVIDER </Text>
        <Text bold color={palette.violet}>
          {state.providerFilter}
        </Text>
      </Text>
      <Text color={palette.muted}>
        Paste the Provider API key below. It is hidden here and encrypted before being stored.
      </Text>
      <Box marginTop={1}>
        <Text bold color={palette.accent}>
          API KEY ›{' '}
        </Text>
        {masked ? (
          <Text color={palette.ink}>{masked}█</Text>
        ) : (
          <Text color={palette.muted}>paste or type securely…</Text>
        )}
      </Box>
      <Text color={palette.faint}>The key is never written to the run log.</Text>
    </Box>
  )
}

function SearchLine({ query }: { query: string }) {
  return (
    <Box marginTop={1}>
      <Text bold color={palette.accent}>
        SEARCH ›{' '}
      </Text>
      {query ? (
        <Text color={palette.ink}>{query}█</Text>
      ) : (
        <Text color={palette.muted}>type model or provider…</Text>
      )}
    </Box>
  )
}

function ProviderList({ state, compact }: { state: ReadyState; compact: boolean }) {
  const providers = visibleProviders(state)
  const window = pickerWindow(providers, state.selected, compact ? 6 : 10)
  if (providers.length === 0) return <Empty message="No matching Providers." />

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={palette.muted}>
        {state.intent === 'login'
          ? 'Choose a Provider to add or replace its API key.'
          : state.intent === 'logout'
            ? 'Choose a Provider to remove its stored credential.'
            : 'Choose a Provider, then choose one of its models.'}
      </Text>
      {window.items.map((provider, index) => (
        <ProviderRow
          compact={compact}
          key={provider.id}
          provider={provider}
          selected={window.offset + index === state.selected}
        />
      ))}
      <WindowStatus
        count={providers.length}
        selected={state.selected}
        visible={window.items.length}
      />
    </Box>
  )
}

function ModelList({ state, compact }: { state: ReadyState; compact: boolean }) {
  const models = visibleModels(state)
  const counts = catalogModelCounts(state)
  const window = pickerWindow(models, state.selected, compact ? 7 : 10)
  if (models.length === 0) {
    return (
      <Empty
        message={
          counts.catalog > 0
            ? `No available models; ${counts.catalog} catalog entries can be inspected with Tab.`
            : 'No matching models. Keep typing or press Backspace to go back.'
        }
      />
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={palette.muted}>
        {state.providerFilter ? `Provider: ${state.providerFilter}. ` : ''}
        Showing {counts.shown}; {counts.available} available / {counts.catalog} catalog. Scope:{' '}
        {(state.availability ?? 'available').toUpperCase()}.
      </Text>
      {window.items.map((model, index) => (
        <ModelRow
          authenticated={
            state.providers.find(({ id }) => id === model.provider)?.status === 'authenticated'
          }
          compact={compact}
          current={model.provider === state.currentProvider && model.id === state.currentModel}
          key={`${model.provider}/${model.id}`}
          model={model}
          selected={window.offset + index === state.selected}
        />
      ))}
      <WindowStatus count={models.length} selected={state.selected} visible={window.items.length} />
      <ModelDetails
        authenticated={
          state.providers.find(({ id }) => id === models[state.selected]?.provider)?.status ===
          'authenticated'
        }
        compact={compact}
        model={models[state.selected]}
      />
    </Box>
  )
}

function ProviderRow({
  provider,
  selected,
  compact,
}: {
  provider: ProviderOption
  selected: boolean
  compact: boolean
}) {
  const statusColor =
    provider.status === 'authenticated'
      ? palette.mint
      : provider.status === 'expired'
        ? palette.amber
        : palette.danger
  return (
    <Box backgroundColor={selected ? palette.panelStrong : undefined} paddingX={1}>
      <Text bold color={selected ? palette.accent : palette.faint}>
        {selected ? '›' : ' '}
      </Text>
      <Box marginLeft={1} width={compact ? 22 : 28}>
        <Text bold color={selected ? palette.ink : palette.muted} wrap="truncate-end">
          {provider.id}
        </Text>
      </Box>
      <Box width={compact ? 18 : 22}>
        <Text color={statusColor}>{providerStatusLabel(provider.status)}</Text>
      </Box>
      <Text color={palette.muted}>
        {provider.modelCount} model{provider.modelCount === 1 ? '' : 's'}
      </Text>
      {!compact ? (
        <Text color={provider.health === 'healthy' ? palette.muted : palette.amber}>
          {'  '}
          {provider.accountLabel ?? provider.health}
        </Text>
      ) : null}
    </Box>
  )
}

function ModelRow({
  model,
  selected,
  current,
  compact,
  authenticated,
}: {
  model: ModelInfo
  selected: boolean
  current: boolean
  compact: boolean
  authenticated: boolean
}) {
  return (
    <Box backgroundColor={selected ? palette.panelStrong : undefined} paddingX={1}>
      <Text bold color={selected ? palette.accent : palette.faint}>
        {selected ? '›' : ' '}
      </Text>
      <Box marginLeft={1} width={compact ? 29 : 38}>
        <Text bold color={selected ? palette.accent : palette.ink} wrap="truncate-end">
          {model.name}
        </Text>
      </Box>
      <Box width={compact ? 22 : 28}>
        <Text color={palette.violet} wrap="truncate-end">
          [{model.provider}]
        </Text>
      </Box>
      {!authenticated ? (
        <Text bold color={palette.amber}>
          ◆ KEY REQUIRED
        </Text>
      ) : model.lifecycle === 'deprecated' ? (
        <Text bold color={palette.amber}>
          DEPRECATED
        </Text>
      ) : current ? (
        <Text bold color={palette.mint}>
          ✓ CURRENT
        </Text>
      ) : null}
      {!compact && !current ? (
        <Text color={palette.muted}>{compactNumber(model.contextTokens)} ctx</Text>
      ) : null}
    </Box>
  )
}

function ModelDetails({
  model,
  compact,
  authenticated,
}: {
  model?: ModelInfo
  compact: boolean
  authenticated: boolean
}) {
  if (!model) return null
  const hasReasoning = model.reasoningLevels.some((level) => level !== 'none')
  const capabilities = compact
    ? [
        model.contextTokens ? `${compactNumber(model.contextTokens)} ctx` : undefined,
        model.outputTokens ? `${compactNumber(model.outputTokens)} output` : undefined,
        hasReasoning ? 'reasoning metadata' : 'no reasoning metadata',
        model.modalities.join('+'),
      ].filter(Boolean)
    : [
        model.contextTokens ? `${compactNumber(model.contextTokens)} context` : undefined,
        model.outputTokens ? `${compactNumber(model.outputTokens)} max output` : undefined,
        hasReasoning
          ? `advertised reasoning ${model.reasoningLevels.filter((level) => level !== 'none').join('/')} (metadata only)`
          : 'no reasoning metadata',
        model.modalities.join(' + '),
      ].filter(Boolean)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={palette.muted}>ID </Text>
        <Text color={palette.ink}>
          {model.provider}/{model.id}
        </Text>
      </Text>
      <Text color={palette.faint}>{capabilities.join('  ·  ')}</Text>
      {!authenticated ? (
        <Text color={palette.amber}>
          Unavailable: {model.provider} is not authenticated. Press Enter to connect it.
        </Text>
      ) : null}
      {model.lifecycle === 'deprecated' ? (
        <Text color={palette.amber}>This catalog entry is deprecated; choose a replacement.</Text>
      ) : null}
    </Box>
  )
}

function ShortcutBar({ state, compact }: { state: CatalogPickerState; compact: boolean }) {
  if (state.status === 'loading') {
    return (
      <Box marginTop={1}>
        <Hint keyName="ESC" label="cancel" />
      </Box>
    )
  }
  return (
    <Box gap={compact ? 1 : 2} marginTop={1}>
      {state.view === 'credentials' ? (
        <>
          <Hint keyName="ENTER" label="connect" />
          <Hint keyName="CTRL+U" label="clear" />
          <Hint keyName="⌫" label="edit / back" />
          <Hint keyName="ESC" label="back" />
        </>
      ) : (
        <>
          <Hint keyName="TYPE" label="search" />
          <Hint keyName="↑↓" label="navigate" />
          <Hint
            keyName="ENTER"
            label={
              state.view === 'providers'
                ? state.intent === 'login'
                  ? 'configure'
                  : state.intent === 'logout'
                    ? 'disconnect'
                    : 'connect / models'
                : 'select'
            }
          />
          {state.view === 'models' ? <Hint keyName="TAB" label="available / all" /> : null}
          {state.view === 'models' && state.providerFilter ? (
            <Hint keyName="⌫" label="back" />
          ) : null}
          <Hint keyName="ESC" label="cancel" />
        </>
      )}
    </Box>
  )
}

function providerStatusLabel(status: ProviderOption['status']): string {
  if (status === 'authenticated') return 'CONNECTED'
  if (status === 'unauthenticated') return 'API KEY NEEDED'
  return status.toUpperCase()
}

function Empty({ message }: { message: string }) {
  return (
    <Box marginY={1}>
      <Text color={palette.amber}>{message}</Text>
    </Box>
  )
}

function WindowStatus({
  count,
  selected,
  visible,
}: {
  count: number
  selected: number
  visible: number
}) {
  return visible >= count ? null : (
    <Text color={palette.faint}>
      ({selected + 1}/{count})
    </Text>
  )
}

function Hint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Text>
      <Text color={palette.ink}>{keyName}</Text>
      <Text color={palette.muted}> {label}</Text>
    </Text>
  )
}
