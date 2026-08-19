import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, useApp, useInput, useStdin, useStdout } from 'ink'
import type {
  AuthStatus,
  CommandCatalogSnapshotV1,
  RuntimeBridge,
  SessionEvent,
  SessionInfo,
} from '@praxis/protocol'
import { CatalogPicker } from './CatalogPicker.js'
import {
  appendCredentialInput,
  availableModels,
  backToProviders,
  buildProviderOptions,
  type CatalogPickerState,
  movePickerSelection,
  navigatePicker,
  nextModel,
  openProviderModels,
  refreshCatalog,
  selectedModel,
  selectedProvider,
  toggleModelScope,
  updateCredential,
  updatePickerQuery,
} from './catalogPickerModel.js'
import {
  commandCatalogFromSnapshots,
  commandNames,
  commandSuggestions,
  type CommandDefinition,
  moveCommandSelection,
  selectedCommandSuggestion,
} from './commandCatalog.js'
import { createClientCommandRegistryV1 } from './clientCommandRegistry.js'
import { copyTextToClipboard } from './clipboard.js'
import { Composer } from './Composer.js'
import { ContextRail } from './ContextRail.js'
import { EventList } from './EventList.js'
import { Header } from './Header.js'
import {
  moveSessionSelection,
  selectedSession,
  SessionPicker,
  type SessionPickerState,
  updateSessionQuery,
} from './SessionPicker.js'
import { appendEvent } from './eventState.js'
import { latestAssistantText } from './sessionTranscript.js'
import {
  editInExternalEditor,
  editorKeybindings,
  isBackwardDeleteSequence,
  TerminalEditorModel,
} from './terminalEditor.js'
import { executeSlashCommand } from './slashCommands.js'
import { deliverSteer, runtimeFailureCode } from './steerDelivery.js'
import { contextPressure, terminalLayout, type WorkflowPlanView } from './tuiModel.js'
import { useSessionHistory } from './useSessionHistory.js'
import { useWorkflowGraph } from './useWorkflowGraph.js'

type Props = {
  bridge: RuntimeBridge
  session: SessionInfo
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function App({ bridge, session: initialSession }: Props) {
  const [session, setSession] = useState(initialSession)
  const { sessionId } = session
  const { exit } = useApp()
  const { stdin } = useStdin()
  const rawInput = useRef('')
  const [editor] = useState(() => new TerminalEditorModel())
  const [keybindings] = useState(() => editorKeybindings())
  const [input, setInput] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const [commandSelection, setCommandSelection] = useState(0)
  const [runtimeCommandCatalog, setRuntimeCommandCatalog] = useState<CommandCatalogSnapshotV1>()
  const [commandCatalog, setCommandCatalog] = useState<readonly CommandDefinition[]>([])
  const steerTail = useRef<Promise<void>>(Promise.resolve())
  const localMessageSequence = useRef(0)
  const [runtimeEpoch, setRuntimeEpoch] = useState(0)
  const historyEvents = useSessionHistory(bridge, sessionId, runtimeEpoch)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const isRunningRef = useRef(false)
  const hasRunRef = useRef((initialSession.messageCount ?? 0) > 0)
  const [activeRunId, setActiveRunId] = useState<string>()
  const activeRunIdRef = useRef<string | undefined>(undefined)
  const runOwnerRef = useRef<symbol | undefined>(undefined)
  const [pendingPermission, setPendingPermission] =
    useState<Extract<SessionEvent, { type: 'permission_request' }>>()
  const [catalogPicker, setCatalogPicker] = useState<CatalogPickerState>()
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState>()
  const [providerAuth, setProviderAuth] = useState<AuthStatus>()
  const [modelContextLimit, setModelContextLimit] = useState<number>()
  const terminal = useTerminalDimensions()
  const layout = terminalLayout(terminal.columns, terminal.rows)
  const displayEvents = useMemo(() => [...historyEvents, ...events], [events, historyEvents])
  const workflowPlan = useWorkflowGraph(bridge, sessionId, runtimeEpoch, displayEvents)
  const pressure = contextPressure(
    displayEvents,
    session.contextLimitTokens ?? modelContextLimit,
    session.usage,
  )

  function syncEditor(): void {
    setInput(editor.value)
    setCursorIndex(editor.cursorIndex)
  }

  function updateIsRunning(value: boolean): void {
    isRunningRef.current = value
    setIsRunning(value)
  }

  function updateActiveRunId(value: string | undefined): void {
    activeRunIdRef.current = value
    setActiveRunId(value)
  }

  function updateHasRun(value: boolean): void {
    hasRunRef.current = value
  }

  useEffect(() => {
    const captureRawInput = (data: Buffer | string) => {
      rawInput.current = typeof data === 'string' ? data : data.toString('utf8')
    }
    stdin.prependListener('data', captureRawInput)
    return () => {
      stdin.off('data', captureRawInput)
    }
  }, [stdin])

  useEffect(() => {
    let cancelled = false
    void Promise.all([bridge.authStatus(session.provider), bridge.listModels(session.provider)])
      .then(([auth, models]) => {
        if (cancelled) return
        setProviderAuth(auth.status)
        setModelContextLimit(models.find(({ id }) => id === session.model)?.contextTokens)
      })
      .catch(() => {
        if (!cancelled) setProviderAuth('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [bridge, session.model, session.provider])

  useEffect(() => {
    void runtimeEpoch
    let cancelled = false
    void bridge
      .listCommands(session.cwd)
      .then((runtimeCatalog) => {
        if (cancelled) return
        const clientCatalog = createClientCommandRegistryV1().snapshot({
          workspaceId: runtimeCatalog.workspaceId,
          workspaceTrusted: runtimeCatalog.workspaceTrusted,
          capabilityIds: runtimeCatalog.capabilityIds,
        })
        const definitions = commandCatalogFromSnapshots([clientCatalog, runtimeCatalog])
        setRuntimeCommandCatalog(runtimeCatalog)
        setCommandCatalog(definitions)
        editor.setCompletions(commandNames(definitions))
      })
      .catch((error) => {
        if (!cancelled) {
          setEvents((previous) =>
            appendEvent(previous, {
              type: 'runtime_warning',
              code: 'COMMAND_CATALOG_UNAVAILABLE',
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [bridge, editor, runtimeEpoch, session.cwd])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        for await (const event of bridge.events()) {
          if (!cancelled) {
            if (event.type === 'runtime_ready') setRuntimeEpoch((previous) => previous + 1)
            setEvents((previous) => appendEvent(previous, event))
          }
        }
      } catch (error) {
        if (!cancelled) {
          setEvents((previous) =>
            appendEvent(previous, {
              type: 'runtime_warning',
              code: 'RUNTIME_CONNECTION_LOST',
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [bridge])

  useEffect(() => {
    void sessionId
    setEvents([])
  }, [sessionId])

  const refreshOpenCatalog =
    catalogPicker?.status === 'ready' && catalogPicker.view !== 'credentials'
  useEffect(() => {
    if (!refreshOpenCatalog) return
    const timer = setInterval(() => {
      void Promise.all([bridge.listModels(), bridge.doctor(session.cwd)])
        .then(([models, doctor]) => {
          setCatalogPicker((current) => {
            if (current?.status !== 'ready' || current.view === 'credentials') {
              return current
            }
            const providers = buildProviderOptions(doctor.providers, models)
            return refreshCatalog(current, providers, availableModels(models, providers))
          })
        })
        .catch(() => {
          // Keep the last known catalog usable; foreground actions surface errors.
        })
    }, 15_000)
    return () => clearInterval(timer)
  }, [bridge, refreshOpenCatalog, session.cwd])

  useInput((inputChar, key) => {
    const rawSequence = rawInput.current
    rawInput.current = ''

    if (key.ctrl && inputChar === 'c') {
      if (catalogPicker) {
        setCatalogPicker(undefined)
      } else if (sessionPicker) {
        setSessionPicker(undefined)
      } else if (activeRunId) {
        void bridge.abort(activeRunId)
      } else {
        process.exitCode = 130
        exit()
      }
      return
    }

    if (sessionPicker) {
      if (key.escape) {
        setSessionPicker(undefined)
      } else if (key.upArrow) {
        setSessionPicker((current) => (current ? moveSessionSelection(current, 'up') : current))
      } else if (key.downArrow) {
        setSessionPicker((current) => (current ? moveSessionSelection(current, 'down') : current))
      } else if (key.pageUp) {
        setSessionPicker((current) => (current ? moveSessionSelection(current, 'pageUp') : current))
      } else if (key.pageDown) {
        setSessionPicker((current) =>
          current ? moveSessionSelection(current, 'pageDown') : current,
        )
      } else if (key.home) {
        setSessionPicker((current) => (current ? moveSessionSelection(current, 'home') : current))
      } else if (key.end) {
        setSessionPicker((current) => (current ? moveSessionSelection(current, 'end') : current))
      } else if (key.return) {
        void resumeSelectedSession()
      } else if (key.backspace || key.delete) {
        if (sessionPicker.query) {
          setSessionPicker(
            updateSessionQuery(sessionPicker, [...sessionPicker.query].slice(0, -1).join('')),
          )
        }
      } else if (inputChar && !key.ctrl && !key.meta) {
        setSessionPicker(updateSessionQuery(sessionPicker, `${sessionPicker.query}${inputChar}`))
      }
      return
    }

    if (catalogPicker) {
      if (catalogPicker.status === 'ready' && catalogPicker.view === 'credentials' && key.escape) {
        setCatalogPicker(backToProviders(catalogPicker))
      } else if (key.escape) {
        setCatalogPicker(undefined)
      } else if (catalogPicker.status === 'ready' && catalogPicker.view === 'credentials') {
        if (key.return) {
          void connectProvider()
        } else if (key.ctrl && inputChar.toLowerCase() === 'u') {
          setCatalogPicker(updateCredential(catalogPicker, ''))
        } else if (key.backspace || key.delete) {
          const credential = catalogPicker.credential ?? ''
          if (credential) {
            setCatalogPicker(updateCredential(catalogPicker, [...credential].slice(0, -1).join('')))
          } else {
            setCatalogPicker(backToProviders(catalogPicker))
          }
        } else if (inputChar && !key.ctrl && !key.meta) {
          const credential = appendCredentialInput(catalogPicker.credential ?? '', inputChar)
          if (credential !== (catalogPicker.credential ?? '')) {
            setCatalogPicker(updateCredential(catalogPicker, credential))
          }
        }
      } else if (key.upArrow) {
        setCatalogPicker((current) => (current ? movePickerSelection(current, -1) : current))
      } else if (key.downArrow) {
        setCatalogPicker((current) => (current ? movePickerSelection(current, 1) : current))
      } else if (key.pageUp) {
        setCatalogPicker((current) => (current ? navigatePicker(current, 'pageUp') : current))
      } else if (key.pageDown) {
        setCatalogPicker((current) => (current ? navigatePicker(current, 'pageDown') : current))
      } else if (key.home) {
        setCatalogPicker((current) => (current ? navigatePicker(current, 'home') : current))
      } else if (key.end) {
        setCatalogPicker((current) => (current ? navigatePicker(current, 'end') : current))
      } else if (key.tab && catalogPicker.status === 'ready' && catalogPicker.view === 'models') {
        setCatalogPicker(toggleModelScope(catalogPicker))
      } else if (key.return) {
        if (catalogPicker.status === 'ready' && catalogPicker.view === 'providers') {
          if (catalogPicker.intent === 'logout') {
            void disconnectProvider()
          } else {
            setCatalogPicker(openProviderModels(catalogPicker))
          }
        } else {
          void selectCatalogEntry()
        }
      } else if (key.backspace || key.delete) {
        if (catalogPicker.query) {
          setCatalogPicker(
            updatePickerQuery(catalogPicker, [...catalogPicker.query].slice(0, -1).join('')),
          )
        } else if (
          catalogPicker.status === 'ready' &&
          catalogPicker.view === 'models' &&
          catalogPicker.providerFilter
        ) {
          setCatalogPicker(backToProviders(catalogPicker))
        }
      } else if (inputChar && !key.ctrl && !key.meta) {
        setCatalogPicker(updatePickerQuery(catalogPicker, `${catalogPicker.query}${inputChar}`))
      }
      return
    }

    if (pendingPermission) {
      if (inputChar.toLowerCase() === 'a') {
        void decidePermission({ type: 'allow_once' })
      }
      if (inputChar.toLowerCase() === 'w') {
        void decidePermission({ type: 'allow_always' })
      }
      if (inputChar.toLowerCase() === 'd') {
        void decidePermission({ type: 'deny', reason: 'Denied by user' })
      }
      return
    }

    if (key.ctrl && inputChar.toLowerCase() === 'l' && !activeRunId) {
      void openCatalogPicker('models')
      return
    }

    if (key.ctrl && inputChar.toLowerCase() === 'p' && !activeRunId) {
      void cycleCatalogModel(key.shift ? -1 : 1)
      return
    }

    if (key.ctrl && inputChar.toLowerCase() === 'e') {
      void editInExternalEditor(editor.value)
        .then((value) => {
          editor.replace(value)
          syncEditor()
          setCommandSelection(0)
        })
        .catch((error) => appendLocalMessage(`External editor failed: ${String(error)}`))
      return
    }

    if (key.upArrow) {
      if (commandSuggestions(editor.value, commandCatalog).length > 0) {
        setCommandSelection((current) =>
          moveCommandSelection(editor.value, current, -1, commandCatalog),
        )
      } else if (editor.moveUp()) {
        syncEditor()
      } else {
        editor.previousHistory()
        syncEditor()
        setCommandSelection(0)
      }
      return
    }
    if (key.downArrow) {
      if (commandSuggestions(editor.value, commandCatalog).length > 0) {
        setCommandSelection((current) =>
          moveCommandSelection(editor.value, current, 1, commandCatalog),
        )
      } else if (editor.moveDown()) {
        syncEditor()
      } else {
        editor.nextHistory()
        syncEditor()
        setCommandSelection(0)
      }
      return
    }
    if (key.leftArrow) {
      if (key.ctrl || key.meta) editor.moveWordLeft()
      else editor.moveLeft()
      syncEditor()
      return
    }
    if (key.rightArrow) {
      if (key.ctrl || key.meta) editor.moveWordRight()
      else editor.moveRight()
      syncEditor()
      return
    }
    if (key.home) {
      editor.moveToLineStart()
      syncEditor()
      return
    }
    if (key.end) {
      editor.moveToLineEnd()
      syncEditor()
      return
    }
    if (key.tab) {
      const suggestion = selectedCommandSuggestion(editor.value, commandSelection, commandCatalog)
      if (suggestion) {
        editor.replace(`${suggestion.command} `)
      } else {
        editor.complete()
      }
      syncEditor()
      setCommandSelection(0)
      return
    }

    const commandSuggestion = selectedCommandSuggestion(
      editor.value,
      commandSelection,
      commandCatalog,
    )
    if (
      key.return &&
      !key.shift &&
      !key.ctrl &&
      commandSuggestion &&
      editor.value.trim() !== commandSuggestion.command
    ) {
      editor.replace(`${commandSuggestion.command} `)
      syncEditor()
      setCommandSelection(0)
      return
    }

    const submit =
      key.return &&
      ((keybindings.submit === 'enter' && !key.shift) ||
        (keybindings.submit === 'ctrl-enter' && key.ctrl))
    if (submit) {
      const text = editor.submit()
      if (!text) return
      syncEditor()
      setCommandSelection(0)
      const routedRunId = activeRunIdRef.current
      if (isRunningRef.current && routedRunId) {
        submitActiveRunInput(text)
      } else {
        void runInput(text)
      }
      return
    }

    if (key.return) {
      editor.newline()
      syncEditor()
      setCommandSelection(0)
      return
    }

    if (key.backspace) {
      editor.backspace()
      syncEditor()
      setCommandSelection(0)
      return
    }

    if (key.delete) {
      if (isBackwardDeleteSequence(rawSequence)) editor.backspace()
      else editor.deleteForward()
      syncEditor()
      setCommandSelection(0)
      return
    }

    if (inputChar) {
      editor.insert(inputChar)
      syncEditor()
      setCommandSelection(0)
    }
  })

  function submitActiveRunInput(text: string): void {
    const targetSessionId = sessionId
    steerTail.current = steerTail.current.then(async () => {
      try {
        const runId = activeRunIdRef.current
        if (!runId) {
          await startRunAndWaitUntilReady(text)
          return
        }
        const result = await deliverSteer(bridge, {
          sessionId: targetSessionId,
          runId,
          text,
        })
        if (result === 'run-ended') {
          if (activeRunIdRef.current === runId) updateActiveRunId(undefined)
          await startRunAndWaitUntilReady(text)
        }
      } catch (error) {
        editor.replace(editor.value ? `${text}\n${editor.value}` : text)
        syncEditor()
        appendRuntimeWarning('STEER_FAILED', error instanceof Error ? error.message : String(error))
      }
    })
  }

  function startRunAndWaitUntilReady(text: string): Promise<void> {
    return new Promise((resolveReady) => {
      void runInput(text, resolveReady)
    })
  }

  async function runInput(text: string, onStartedOrSettled?: () => void): Promise<void> {
    let handoffReleased = false
    const releaseHandoff = () => {
      if (handoffReleased) return
      handoffReleased = true
      onStartedOrSettled?.()
    }
    const owner = Symbol('run-input')
    runOwnerRef.current = owner
    try {
      updateIsRunning(true)
      const command = await executeSlashCommand(text, {
        bridge,
        session,
        cwd: session.cwd,
        runtimeCatalog: runtimeCommandCatalog,
        runActive: activeRunIdRef.current !== undefined,
        latestAssistantText: latestAssistantText(displayEvents),
        copyText: copyTextToClipboard,
      })
      if (command.handled) {
        releaseHandoff()
        if (command.action?.type === 'open_catalog') {
          await openCatalogPicker(command.action.view, {
            intent: command.action.intent,
            query: command.action.query,
            provider: command.action.provider,
          })
        }
        if (command.action?.type === 'open_session_picker') {
          await openSessionPicker(command.action.query)
        }
        if (command.session) {
          setSession(command.session)
          if (command.history === 'reset') updateHasRun(false)
          if (command.history === 'restore') {
            updateHasRun((command.session.messageCount ?? 0) > 0)
          }
        }
        if (command.message) appendLocalMessage(command.message)
        return
      }
      const promptText = command.prompt ?? text
      const run = hasRunRef.current
        ? bridge.followUp({
            sessionId,
            text: promptText,
            ...(command.commandInvocationId === undefined
              ? {}
              : { commandInvocationId: command.commandInvocationId }),
          })
        : bridge.prompt({
            sessionId,
            text: promptText,
            ...(command.commandInvocationId === undefined
              ? {}
              : { commandInvocationId: command.commandInvocationId }),
          })
      for await (const event of run) {
        setEvents((previous) => appendEvent(previous, event))
        if (event.type === 'prompt_started') {
          updateActiveRunId(event.runId)
          updateHasRun(true)
          releaseHandoff()
        }
        if (event.type === 'permission_request') {
          setPendingPermission(event)
        }
        if (
          event.type === 'prompt_completed' ||
          event.type === 'prompt_failed' ||
          event.type === 'prompt_aborted'
        ) {
          if (activeRunIdRef.current === event.runId) updateActiveRunId(undefined)
        }
        if (event.type === 'prompt_failed' && event.code === 'PROVIDER_MODEL_UNAVAILABLE') {
          editor.replace(text)
          syncEditor()
          await openCatalogPicker('models', { provider: session.provider })
        }
      }
    } catch (error) {
      setEvents((previous) =>
        appendEvent(previous, {
          type: 'prompt_failed',
          runId: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      if (runtimeFailureCode(error) === 'PROVIDER_MODEL_UNAVAILABLE') {
        editor.replace(text)
        syncEditor()
        await openCatalogPicker('models', { provider: session.provider })
      }
    } finally {
      if (runOwnerRef.current === owner) {
        runOwnerRef.current = undefined
        updateIsRunning(false)
        updateActiveRunId(undefined)
      }
      releaseHandoff()
    }
  }

  function appendLocalMessage(message: string): void {
    localMessageSequence.current += 1
    setEvents((previous) =>
      appendEvent(previous, {
        type: 'text_delta',
        runId: `cli-${localMessageSequence.current}`,
        text: message,
      }),
    )
  }

  async function openCatalogPicker(
    view: 'providers' | 'models',
    options: {
      intent?: 'select' | 'login' | 'logout'
      query?: string
      provider?: string
    } = {},
  ): Promise<void> {
    const intent = options.intent ?? 'select'
    setCatalogPicker({
      status: 'loading',
      view,
      intent,
      query: options.query ?? '',
      providerFilter: options.provider,
      scopeProvider: options.provider ?? (view === 'models' ? session.provider : undefined),
      availability: 'available',
      currentProvider: session.provider,
      currentModel: session.model,
    })
    try {
      const [models, doctor] = await Promise.all([bridge.listModels(), bridge.doctor(session.cwd)])
      const providers = buildProviderOptions(doctor.providers, models)
      const requestedProvider = options.provider
        ? providers.find(({ id }) => id === options.provider)
        : undefined
      const resolvedView =
        intent === 'login' && requestedProvider
          ? 'credentials'
          : view === 'models' &&
              requestedProvider !== undefined &&
              requestedProvider.status !== 'authenticated'
            ? 'credentials'
            : view
      setCatalogPicker({
        status: 'ready',
        view: resolvedView,
        intent,
        query: options.query ?? '',
        providerFilter: options.provider,
        scopeProvider: options.provider ?? (view === 'models' ? session.provider : undefined),
        availability: 'available',
        currentProvider: session.provider,
        currentModel: session.model,
        ...(resolvedView === 'credentials' ? { credential: '' } : {}),
        providers,
        models: availableModels(models, providers),
        selected: 0,
      })
    } catch (error) {
      setCatalogPicker(undefined)
      appendRuntimeWarning(
        'CATALOG_LOAD_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async function openSessionPicker(query = ''): Promise<void> {
    setSessionPicker({
      status: 'loading',
      query,
      currentSessionId: session.sessionId,
    })
    try {
      const sessions = await bridge.listSessions()
      setSessionPicker({
        status: 'ready',
        query,
        currentSessionId: session.sessionId,
        sessions,
        selected: 0,
      })
    } catch (error) {
      setSessionPicker(undefined)
      appendRuntimeWarning(
        'SESSION_INDEX_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async function resumeSelectedSession(): Promise<void> {
    if (sessionPicker?.status !== 'ready') return
    const selected = selectedSession(sessionPicker)
    if (!selected) return
    if (selected.sessionId === session.sessionId) {
      setSessionPicker(undefined)
      return
    }
    if (activeRunId && sessionPicker.confirmingSessionId !== selected.sessionId) {
      setSessionPicker({
        ...sessionPicker,
        confirmingSessionId: selected.sessionId,
        notice: `A run is active. Press Enter again to cancel it and resume ${shortSessionId(selected.sessionId)}.`,
      })
      return
    }
    const previous = sessionPicker
    setSessionPicker({
      status: 'loading',
      query: sessionPicker.query,
      currentSessionId: session.sessionId,
      notice: `Resuming ${shortSessionId(selected.sessionId)}…`,
    })
    try {
      if (activeRunId) await bridge.abort(activeRunId)
      const resumed = await bridge.resumeSession(selected.sessionId)
      setSession(resumed)
      updateHasRun((resumed.messageCount ?? 0) > 0)
      updateActiveRunId(undefined)
      setSessionPicker(undefined)
      appendLocalMessage(`Resumed ${resumed.name ?? shortSessionId(resumed.sessionId)}.`)
    } catch (error) {
      setSessionPicker({
        ...previous,
        notice: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function connectProvider(): Promise<void> {
    if (
      catalogPicker?.status !== 'ready' ||
      catalogPicker.view !== 'credentials' ||
      !catalogPicker.providerFilter
    ) {
      return
    }
    const provider = catalogPicker.providerFilter
    const apiKey = (catalogPicker.credential ?? '').trim()
    if (!apiKey) {
      setCatalogPicker({ ...catalogPicker, notice: 'Enter an API key to connect this Provider.' })
      return
    }
    const previous = { ...catalogPicker, credential: '' }
    setCatalogPicker({
      status: 'loading',
      view: 'credentials',
      intent: catalogPicker.intent,
      query: '',
      providerFilter: provider,
      scopeProvider: provider,
      currentProvider: session.provider,
      currentModel: session.model,
      credential: '',
      notice: `Connecting ${provider}…`,
    })
    try {
      await bridge.login(provider, apiKey)
      const auth = await bridge.authStatus(provider)
      if (auth.status !== 'authenticated') {
        throw new Error(`${provider} could not activate the supplied credential.`)
      }
      if (provider === session.provider) setProviderAuth(auth.status)
      const [models, doctor] = await Promise.all([bridge.listModels(), bridge.doctor(session.cwd)])
      const providers = buildProviderOptions(doctor.providers, models)
      setCatalogPicker({
        status: 'ready',
        view: 'models',
        intent: 'select',
        query: '',
        providerFilter: provider,
        scopeProvider: provider,
        availability: 'available',
        currentProvider: session.provider,
        currentModel: session.model,
        providers,
        models: availableModels(models, providers),
        selected: 0,
        notice: `Credential saved for ${provider}. Choose a model.`,
      })
    } catch (error) {
      setCatalogPicker({
        ...previous,
        notice: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function disconnectProvider(): Promise<void> {
    if (catalogPicker?.status !== 'ready' || catalogPicker.view !== 'providers') return
    const provider = selectedProvider(catalogPicker)
    if (!provider) return
    const previous = catalogPicker
    setCatalogPicker({
      status: 'loading',
      view: 'providers',
      intent: 'logout',
      query: catalogPicker.query,
      currentProvider: session.provider,
      currentModel: session.model,
      notice: `Disconnecting ${provider.id}…`,
    })
    try {
      await bridge.logout(provider.id)
      if (provider.id === session.provider) setProviderAuth('unauthenticated')
      const [models, doctor] = await Promise.all([bridge.listModels(), bridge.doctor(session.cwd)])
      const providers = buildProviderOptions(doctor.providers, models)
      setCatalogPicker({
        status: 'ready',
        view: 'providers',
        intent: 'logout',
        query: '',
        currentProvider: session.provider,
        currentModel: session.model,
        providers,
        models: availableModels(models, providers),
        selected: Math.max(
          0,
          providers.findIndex(({ id }) => id === provider.id),
        ),
        notice: `Disconnected ${provider.id}; its stored credential was removed.`,
      })
    } catch (error) {
      setCatalogPicker({
        ...previous,
        notice: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function selectCatalogEntry(): Promise<void> {
    if (catalogPicker?.status !== 'ready') return
    const model = selectedModel(catalogPicker)
    if (!model) return
    const provider = catalogPicker.providers.find(({ id }) => id === model.provider)
    if (provider?.status !== 'authenticated') {
      setCatalogPicker({
        ...catalogPicker,
        view: 'credentials',
        intent: 'login',
        query: '',
        providerFilter: model.provider,
        scopeProvider: model.provider,
        credential: '',
        selected: 0,
        notice: undefined,
      })
      return
    }
    const previous = catalogPicker
    setCatalogPicker({
      status: 'loading',
      view: catalogPicker.view,
      intent: catalogPicker.intent,
      query: catalogPicker.query,
      providerFilter: catalogPicker.providerFilter,
      scopeProvider: catalogPicker.scopeProvider,
      availability: catalogPicker.availability,
      currentProvider: catalogPicker.currentProvider,
      currentModel: catalogPicker.currentModel,
      notice: `Switching to ${model.id}…`,
    })
    try {
      const nextSession = await bridge.configureSession(session.sessionId, model.provider, model.id)
      setSession(nextSession)
      setCatalogPicker(undefined)
      appendLocalMessage(`Model: ${model.id} [${model.provider}]`)
    } catch (error) {
      setCatalogPicker({
        ...previous,
        notice: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function cycleCatalogModel(direction: 1 | -1): Promise<void> {
    updateIsRunning(true)
    try {
      const [models, doctor] = await Promise.all([bridge.listModels(), bridge.doctor(session.cwd)])
      const authenticated = new Set(
        doctor.providers.filter(({ status }) => status === 'authenticated').map(({ id }) => id),
      )
      const model = nextModel(
        models.filter(
          (candidate) =>
            authenticated.has(candidate.provider) ||
            (candidate.provider === session.provider && candidate.id === session.model),
        ),
        session.provider,
        session.model,
        direction,
      )
      if (!model) {
        appendRuntimeWarning('MODEL_CATALOG_EMPTY', 'No models are available.')
        return
      }
      const configured = await bridge.configureSession(session.sessionId, model.provider, model.id)
      setSession(configured)
      appendLocalMessage(`Model: ${model.id} [${model.provider}]`)
    } catch (error) {
      appendRuntimeWarning(
        'MODEL_CHANGE_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      updateIsRunning(false)
    }
  }

  function appendRuntimeWarning(code: string, message: string): void {
    setEvents((previous) =>
      appendEvent(previous, {
        type: 'runtime_warning',
        code,
        message,
      }),
    )
  }

  async function decidePermission(decision: Parameters<RuntimeBridge['decidePermission']>[1]) {
    if (!pendingPermission) return
    const requestId = pendingPermission.requestId
    setPendingPermission(undefined)
    try {
      await bridge.decidePermission(requestId, decision)
    } catch (error) {
      setEvents((previous) =>
        appendEvent(previous, {
          type: 'runtime_warning',
          code: 'PERMISSION_DECISION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  return (
    <Box flexDirection="column" gap={1} width={layout.columns}>
      <Header
        activeRunId={activeRunId}
        authStatus={providerAuth}
        compact={layout.compact}
        contextPressure={pressure}
        isRunning={isRunning}
        pendingPermission={pendingPermission !== undefined}
        session={session}
      />

      <TranscriptPane
        compact={layout.compact}
        events={displayEvents}
        isRunning={isRunning}
        maxRows={Math.max(4, layout.rows - layout.editorRows - (layout.compact ? 8 : 10))}
        plan={workflowPlan}
        railWidth={layout.railWidth}
        session={session}
        transcriptWidth={layout.transcriptWidth}
        wide={layout.wide}
      />

      <InteractiveFooter
        activeRunId={activeRunId}
        catalogPicker={catalogPicker}
        commandCatalog={commandCatalog}
        commandSelection={commandSelection}
        compact={layout.compact}
        cursorIndex={cursorIndex}
        editorColumns={layout.composerColumns}
        editorRows={layout.editorRows}
        input={input}
        isRunning={isRunning}
        keybindings={keybindings}
        pendingPermission={pendingPermission}
        sessionPicker={sessionPicker}
      />
    </Box>
  )
}

const TranscriptPane = memo(function TranscriptPane({
  compact,
  events,
  isRunning,
  maxRows,
  plan,
  railWidth,
  session,
  transcriptWidth,
  wide,
}: {
  compact: boolean
  events: readonly SessionEvent[]
  isRunning: boolean
  maxRows: number
  plan?: WorkflowPlanView
  railWidth: number
  session: SessionInfo
  transcriptWidth: number
  wide: boolean
}) {
  return (
    <Box gap={wide ? 1 : 0}>
      <Box flexDirection="column" minWidth={0} width={transcriptWidth}>
        <EventList
          columns={transcriptWidth}
          compact={compact}
          events={events}
          maxRows={maxRows}
          plan={plan}
        />
      </Box>
      {wide ? (
        <ContextRail events={events} isRunning={isRunning} session={session} width={railWidth} />
      ) : null}
    </Box>
  )
})

function InteractiveFooter({
  activeRunId,
  catalogPicker,
  commandCatalog,
  commandSelection,
  compact,
  cursorIndex,
  editorColumns,
  editorRows,
  input,
  isRunning,
  keybindings,
  pendingPermission,
  sessionPicker,
}: {
  activeRunId?: string
  catalogPicker?: CatalogPickerState
  commandCatalog: readonly CommandDefinition[]
  commandSelection: number
  compact: boolean
  cursorIndex: number
  editorColumns: number
  editorRows: number
  input: string
  isRunning: boolean
  keybindings: ReturnType<typeof editorKeybindings>
  pendingPermission?: Extract<SessionEvent, { type: 'permission_request' }>
  sessionPicker?: SessionPickerState
}) {
  const spinner = useSpinner(
    isRunning || catalogPicker?.status === 'loading' || sessionPicker?.status === 'loading',
  )
  if (catalogPicker) {
    return <CatalogPicker compact={compact} spinner={spinner} state={catalogPicker} />
  }
  if (sessionPicker) {
    return <SessionPicker compact={compact} spinner={spinner} state={sessionPicker} />
  }
  return (
    <Composer
      activeRunId={activeRunId}
      commandSelection={commandSelection}
      commandCatalog={commandCatalog}
      compact={compact}
      cursorIndex={cursorIndex}
      editorColumns={editorColumns}
      editorRows={editorRows}
      input={input}
      isRunning={isRunning}
      keybindings={keybindings}
      pendingPermission={pendingPermission}
      spinner={spinner}
    />
  )
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12)
}

function useTerminalDimensions(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const [dimensions, setDimensions] = useState(() => readTerminalDimensions(stdout))

  useEffect(() => {
    const resize = () => setDimensions(readTerminalDimensions(stdout))
    stdout.on('resize', resize)
    return () => {
      stdout.off('resize', resize)
    }
  }, [stdout])

  return dimensions
}

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) {
      setFrame(0)
      return
    }
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      80,
    )
    return () => clearInterval(timer)
  }, [active])

  return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0]
}

function readTerminalDimensions(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return {
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }
}
