import type { AuthStatus, DoctorResult, ModelInfo } from '@praxis/protocol'

export type CatalogView = 'providers' | 'models' | 'credentials'
export type CatalogIntent = 'select' | 'login' | 'logout'

export type ProviderOption = {
  id: string
  status: AuthStatus
  health: string
  accountLabel?: string
  modelCount: number
}

type PickerContext = {
  view: CatalogView
  intent: CatalogIntent
  query: string
  providerFilter?: string
  scopeProvider?: string
  availability?: 'available' | 'all'
  currentProvider: string
  currentModel: string
  credential?: string
  notice?: string
}

export type CatalogPickerState =
  | (PickerContext & { status: 'loading' })
  | (PickerContext & {
      status: 'ready'
      providers: ProviderOption[]
      models: ModelInfo[]
      selected: number
    })

export function buildProviderOptions(
  providers: DoctorResult['providers'],
  models: readonly ModelInfo[],
): ProviderOption[] {
  return providers
    .map((provider) => ({
      ...provider,
      modelCount: models.filter((model) => model.provider === provider.id).length,
    }))
    .sort((left, right) => {
      const authOrder = authRank(left.status) - authRank(right.status)
      return authOrder === 0 ? left.id.localeCompare(right.id) : authOrder
    })
}

export function availableModels(
  models: readonly ModelInfo[],
  providers: readonly ProviderOption[],
): ModelInfo[] {
  const available = new Set(providers.map(({ id }) => id))
  return models.filter((model) => available.has(model.provider))
}

export function visibleProviders(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
): ProviderOption[] {
  return state.providers.filter((provider) =>
    fuzzyMatch(
      `${provider.id} ${provider.status} ${provider.health} ${provider.accountLabel ?? ''}`,
      state.query,
    ),
  )
}

export function visibleModels(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
): ModelInfo[] {
  const matching = matchingModels(state)
  if ((state.availability ?? 'available') === 'all') return sortModels(matching, state)
  const authenticated = new Set(
    state.providers.filter(({ status }) => status === 'authenticated').map(({ id }) => id),
  )
  return sortModels(
    matching.filter(
      (model) =>
        authenticated.has(model.provider) ||
        (model.provider === state.currentProvider && model.id === state.currentModel),
    ),
    state,
  )
}

export function catalogModelCounts(state: Extract<CatalogPickerState, { status: 'ready' }>): {
  shown: number
  available: number
  catalog: number
} {
  const matching = matchingModels(state)
  const authenticated = new Set(
    state.providers.filter(({ status }) => status === 'authenticated').map(({ id }) => id),
  )
  return {
    shown: visibleModels(state).length,
    available: matching.filter(
      (model) =>
        authenticated.has(model.provider) ||
        (model.provider === state.currentProvider && model.id === state.currentModel),
    ).length,
    catalog: matching.length,
  }
}

function matchingModels(state: Extract<CatalogPickerState, { status: 'ready' }>): ModelInfo[] {
  return state.models.filter(
    (model) =>
      (!state.providerFilter || model.provider === state.providerFilter) &&
      fuzzyMatch(
        `${model.name} ${model.id} ${(model.aliases ?? []).join(' ')} ${model.provider}/${model.id} ${model.provider} ${model.family} ${model.modalities.join(' ')}`,
        state.query,
      ),
  )
}

function sortModels(
  models: readonly ModelInfo[],
  state: Extract<CatalogPickerState, { status: 'ready' }>,
): ModelInfo[] {
  return [...models].sort((left, right) => {
    const leftCurrent = left.provider === state.currentProvider && left.id === state.currentModel
    const rightCurrent = right.provider === state.currentProvider && right.id === state.currentModel
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    const providerOrder = left.provider.localeCompare(right.provider)
    return providerOrder === 0 ? left.id.localeCompare(right.id) : providerOrder
  })
}

export function pickerItemCount(state: CatalogPickerState): number {
  if (state.status === 'loading') return 0
  return state.view === 'providers' ? visibleProviders(state).length : visibleModels(state).length
}

export function movePickerSelection(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
  offset: number,
): Extract<CatalogPickerState, { status: 'ready' }>
export function movePickerSelection(state: CatalogPickerState, offset: number): CatalogPickerState
export function movePickerSelection(state: CatalogPickerState, offset: number): CatalogPickerState {
  if (state.status === 'loading') return state
  const count = pickerItemCount(state)
  if (count === 0) return { ...state, selected: 0 }
  return { ...state, selected: (state.selected + offset + count) % count }
}

export function navigatePicker(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
  movement: 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize?: number,
): Extract<CatalogPickerState, { status: 'ready' }>
export function navigatePicker(
  state: CatalogPickerState,
  movement: 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize?: number,
): CatalogPickerState
export function navigatePicker(
  state: CatalogPickerState,
  movement: 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize = 8,
): CatalogPickerState {
  if (state.status === 'loading') return state
  const count = pickerItemCount(state)
  if (count === 0) return { ...state, selected: 0 }
  const selected =
    movement === 'home'
      ? 0
      : movement === 'end'
        ? count - 1
        : Math.min(
            count - 1,
            Math.max(0, state.selected + (movement === 'pageUp' ? -pageSize : pageSize)),
          )
  return { ...state, selected, notice: undefined }
}

export function updatePickerQuery(state: CatalogPickerState, query: string): CatalogPickerState {
  return state.status === 'ready'
    ? { ...state, query, selected: 0, notice: undefined }
    : { ...state, query }
}

export function openProviderModels(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
): Extract<CatalogPickerState, { status: 'ready' }> {
  const provider = visibleProviders(state)[state.selected]
  if (!provider) return state
  if (state.intent === 'login' || provider.status !== 'authenticated') {
    return {
      ...state,
      view: 'credentials',
      providerFilter: provider.id,
      query: '',
      credential: '',
      selected: 0,
      notice: undefined,
    }
  }
  return {
    ...state,
    view: 'models',
    providerFilter: provider.id,
    scopeProvider: provider.id,
    availability: 'available',
    query: '',
    credential: undefined,
    selected: 0,
    notice: undefined,
  }
}

export function backToProviders(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
): Extract<CatalogPickerState, { status: 'ready' }> {
  return {
    ...state,
    view: 'providers',
    providerFilter: undefined,
    scopeProvider: undefined,
    availability: 'available',
    query: '',
    credential: undefined,
    selected: Math.max(
      0,
      state.providers.findIndex(({ id }) => id === state.providerFilter),
    ),
    notice: undefined,
  }
}

export function toggleModelScope(state: CatalogPickerState): CatalogPickerState {
  if (state.status !== 'ready' || state.view !== 'models') return state
  return {
    ...state,
    availability: (state.availability ?? 'available') === 'available' ? 'all' : 'available',
    selected: 0,
    notice: undefined,
  }
}

export function refreshCatalog(
  state: Extract<CatalogPickerState, { status: 'ready' }>,
  providers: ProviderOption[],
  models: ModelInfo[],
): Extract<CatalogPickerState, { status: 'ready' }> {
  const selected =
    state.view === 'providers' ? selectedProvider(state)?.id : modelKey(selectedModel(state))
  const next = { ...state, providers, models }
  const index =
    state.view === 'providers'
      ? visibleProviders(next).findIndex((item) => item.id === selected)
      : visibleModels(next).findIndex((item) => modelKey(item) === selected)
  return {
    ...next,
    selected: index >= 0 ? index : Math.min(state.selected, Math.max(0, pickerItemCount(next) - 1)),
  }
}

export function updateCredential(
  state: CatalogPickerState,
  credential: string,
): CatalogPickerState {
  return state.status === 'ready' && state.view === 'credentials'
    ? { ...state, credential, notice: undefined }
    : state
}

export function appendCredentialInput(current: string, input: string): string {
  const normalized = input
    .split('\u001b[200~')
    .join('')
    .split('\u001b[201~')
    .join('')
    .replace(/[\r\n]/g, '')
  return `${current}${normalized}`.slice(0, 8_192)
}

export function selectedModel(state: CatalogPickerState): ModelInfo | undefined {
  return state.status === 'ready' && state.view === 'models'
    ? visibleModels(state)[state.selected]
    : undefined
}

export function selectedProvider(state: CatalogPickerState): ProviderOption | undefined {
  return state.status === 'ready' && state.view === 'providers'
    ? visibleProviders(state)[state.selected]
    : undefined
}

export function nextModel(
  models: readonly ModelInfo[],
  currentProvider: string,
  currentModel: string,
  direction: 1 | -1,
): ModelInfo | undefined {
  if (models.length === 0) return undefined
  const ordered = [...models].sort((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider)
    return providerOrder === 0 ? left.id.localeCompare(right.id) : providerOrder
  })
  const currentIndex = ordered.findIndex(
    (model) => model.provider === currentProvider && model.id === currentModel,
  )
  const start = currentIndex < 0 ? (direction === 1 ? -1 : 0) : currentIndex
  return ordered[(start + direction + ordered.length) % ordered.length]
}

export function pickerWindow<T>(
  items: readonly T[],
  selected: number,
  limit = 10,
): { items: readonly T[]; offset: number } {
  if (items.length <= limit) return { items, offset: 0 }
  const half = Math.floor(limit / 2)
  const offset = Math.min(Math.max(0, selected - half), items.length - limit)
  return { items: items.slice(offset, offset + limit), offset }
}

function modelKey(model: ModelInfo | undefined): string | undefined {
  return model ? `${model.provider}\u0000${model.id}` : undefined
}

function fuzzyMatch(source: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  const normalizedSource = source.toLowerCase()
  return normalizedQuery.split(/\s+/).every((term) => {
    if (normalizedSource.includes(term)) return true
    let cursor = 0
    for (const character of normalizedSource) {
      if (character === term[cursor]) cursor += 1
      if (cursor === term.length) return true
    }
    return false
  })
}

function authRank(status: AuthStatus): number {
  if (status === 'authenticated') return 0
  if (status === 'expired') return 1
  if (status === 'unauthenticated') return 2
  return 3
}
