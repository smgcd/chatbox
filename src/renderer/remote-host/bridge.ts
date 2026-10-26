/**
 * LAN remote-host bridge (renderer side).
 *
 * The main process forwards HTTP commands here. This module deliberately only
 * *calls the same functions the UI calls* - `submitNewUserMessage`,
 * `stopAllMessageGenerations`, `createEmpty`, `rendererApplication.sessions` -
 * so the remote client keeps 100% of the desktop behaviour (tools, MCP, skills,
 * memory, approvals) without duplicating any logic.
 *
 * Two additions on top of that:
 *  - agent mode is forced to 'on' (the phone has no toggle: this instance is a
 *    workhorse that may always use local tools);
 *  - a ~150ms ticker pushes the live streaming frame over IPC so the phone sees
 *    reasoning/text as they arrive, not on the 2s persistence cadence.
 */
import type {
  RemoteCapabilities,
  RemoteHostCommand,
  RemoteHostEnvelope,
  RemoteHostReply,
  RemoteProgressEvent,
  RemoteSessionSummary,
  RemoteSessionView,
} from '@shared/remote-host'
import { buildProgressEvent, digestSession } from '@shared/remote-host'
import type { CommandApprovalMode } from '@shared/types/command-execution'
import { resolveCommandApprovalMode } from '@shared/types/command-execution'
import { createMessage, type Session } from '@shared/types'
import { currentGenerationService } from '@/adapters/CurrentGenerationService'
import { rendererApplication } from '@/app/renderer-application'
import { getLogger } from '@/lib/utils'
import { getSessionAgentModeEntry, setSessionAgentMode } from '@/stores/session/agent-mode'
import { createEmpty } from '@/stores/session/crud'
import { stopAllMessageGenerations } from '@/stores/session/generation-cancellation'
import { submitNewUserMessage } from '@/stores/session/messages'
import { syncSessionAutoTitle } from '@/stores/session/naming'
import { getSessionWebBrowsing } from '@/stores/session/utils'
import { settingsStore } from '@/stores/settingsStore'
import { uiStore } from '@/stores/uiStore'

const log = getLogger('remote-host-bridge')

const PROGRESS_INTERVAL_MS = 150
/** ~3.5s of idleness before the ticker shuts itself down. */
const IDLE_TICKS_BEFORE_STOP = 24

function remoteApi() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

function emitProgress(event: RemoteProgressEvent): void {
  try {
    remoteApi()?.pushRemoteHostProgress?.(event)
  } catch (error) {
    log.error('failed to push progress frame', { error })
  }
}

let progressTimer: ReturnType<typeof setInterval> | null = null
let progressSessionId: string | null = null
let idleTicks = 0
let wasActive = false

/**
 * The hidden window has no chat route mounted, so the auto-title effect never
 * runs on its own; ask the official naming service directly once a session has
 * content.
 */
function maybeAutoTitle(sessionId: string): void {
  try {
    const session = rendererApplication.sessionQueryBridge.getCachedSession(sessionId)
    if (!session || !session.messages?.length) return
    const name = (session.name ?? '').trim()
    if (name && name !== 'Untitled' && name !== 'New Chat') return
    syncSessionAutoTitle(session)
  } catch (error) {
    log.error('auto title failed', { sessionId, error })
  }
}

function stopProgress(): void {
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = null
  progressSessionId = null
  idleTicks = 0
  wasActive = false
}

/** Returns true while the message is still producing (streaming or tools running). */
function pushProgressFrame(sessionId: string): boolean {
  // getCachedSession is the same React Query cache that updateStreamingCache
  // writes on every chunk, so this frame is as fresh as the desktop UI.
  const session = rendererApplication.sessionQueryBridge.getCachedSession(sessionId)
  if (!session) return false
  const messages = session.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const event = buildProgressEvent(sessionId, message)
    emitProgress(event)
    return event.generating || event.tools.some((tool) => tool.state === 'call')
  }
  return false
}

function ensureProgress(sessionId: string): void {
  if (progressSessionId !== sessionId) {
    stopProgress()
  }
  progressSessionId = sessionId
  if (progressTimer) return
  idleTicks = 0
  progressTimer = setInterval(() => {
    if (!progressSessionId) {
      stopProgress()
      return
    }
    let active = false
    try {
      active = pushProgressFrame(progressSessionId)
    } catch (error) {
      log.error('progress tick failed', { error })
    }
    idleTicks = active ? 0 : idleTicks + 1
    if (wasActive && !active && progressSessionId) {
      maybeAutoTitle(progressSessionId)
    }
    wasActive = active
    if (idleTicks >= IDLE_TICKS_BEFORE_STOP) {
      stopProgress()
    }
  }, PROGRESS_INTERVAL_MS)
}

/**
 * The phone has no agent-mode switch: this instance always works in agent mode
 * so it can call local tools. Sessions lock their mode once the conversation
 * starts, so this is best-effort (new sessions always succeed).
 */
async function forceAgentModeOn(sessionId: string): Promise<void> {
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  if (!session) return
  const entry = getSessionAgentModeEntry(sessionId, session)
  if (entry.value === 'on' || entry.locked) {
    if (entry.value !== 'on') {
      log.warn('session agent mode is locked off; tools will not be available', { sessionId })
    }
    return
  }
  try {
    await setSessionAgentMode(sessionId, 'on')
  } catch (error) {
    log.error('failed to enable agent mode', { sessionId, error })
  }
}

/**
 * Work mode parity.
 *
 * The phone has no Work Mode panel, so this instance has to *be* the desktop's
 * "Full Access" configuration rather than a quieter cousin of it: approval
 * permanently skipped (otherwise every command would stop and wait for a dialog
 * nobody is standing at), web search on, agent mode on. Everything else
 * (skills, MCP, knowledge base, Soul, memory) already comes from the same global
 * settings because we drive the real renderer.
 */
const WORK_APPROVAL_MODE: CommandApprovalMode = 'full_access'

/** New chats inherit the policy even when the desktop UI creates them. */
function primeNewSessionDefaults(): void {
  try {
    const store = uiStore.getState()
    store.setNewSessionCommandApprovalModeDefault(WORK_APPROVAL_MODE)
    if (store.newSessionWebBrowsingDefault !== true) {
      uiStore.setState({ newSessionWebBrowsingDefault: true })
    }
  } catch (error) {
    log.error('failed to prime new-session defaults', { error })
  }
}

async function ensureWorkModeSettings(sessionId: string): Promise<void> {
  try {
    const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
    if (!session) return
    if (!getSessionWebBrowsing(sessionId, session.settings?.provider)) {
      uiStore.getState().setSessionWebBrowsing(sessionId, true)
      log.info('work mode: enabled web browsing', { sessionId })
    }
    if (resolveCommandApprovalMode(session.settings ?? {}) === WORK_APPROVAL_MODE) return
    await rendererApplication.sessions.updateSession(sessionId, (current) => {
      if (!current) throw new Error('Session not found')
      return {
        ...current,
        settings: {
          ...current.settings,
          // Same pair useCommandApprovalModeState writes, so both entry points agree.
          agentFullAccess: true,
          commandApprovalMode: WORK_APPROVAL_MODE,
        },
      }
    })
    log.info('work mode: approval forced to full access', { sessionId })
  } catch (error) {
    log.error('failed to apply work mode settings', { sessionId, error })
  }
}

function readCapabilities(session: Session): RemoteCapabilities {
  const entry = getSessionAgentModeEntry(session.id, session)
  let skills = 0
  let mcp = 0
  try {
    const globalSettings = settingsStore.getState().getSettings()
    skills = globalSettings.skills?.enabledSkillNames?.length ?? 0
    mcp =
      (globalSettings.mcp?.servers?.filter((server) => server.enabled).length ?? 0) +
      (globalSettings.mcp?.enabledBuiltinServers?.length ?? 0)
  } catch (error) {
    log.error('failed to read capability settings', { error })
  }
  return {
    agentMode: entry.value,
    agentModeLocked: Boolean(entry.locked),
    approvalMode: resolveCommandApprovalMode(session.settings ?? {}),
    webBrowsing: getSessionWebBrowsing(session.id, session.settings?.provider),
    skills,
    mcp,
  }
}

async function readSession(sessionId: string): Promise<RemoteSessionView | null> {
  const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  if (!session) return null
  // Opening a session in the remote host applies the work-mode policy, so the
  // capability chips never claim something the next turn would not do.
  await ensureWorkModeSettings(sessionId)
  const patched = await rendererApplication.sessionQueryBridge.getSession(sessionId)
  const current = patched ?? session
  const digest = digestSession(current)
  const agentModeEntry = getSessionAgentModeEntry(sessionId, current)
  // Opening a session that is mid-generation should start streaming right away.
  if (digest.generating || digest.busy) {
    ensureProgress(sessionId)
  } else {
    maybeAutoTitle(sessionId)
  }
  return {
    ...digest,
    agentMode: agentModeEntry.value,
    agentModeLocked: Boolean(agentModeEntry.locked),
    capabilities: readCapabilities(current),
  }
}

async function handleCommand(command: RemoteHostCommand): Promise<unknown> {
  switch (command.op) {
    case 'list-sessions': {
      const records = await rendererApplication.sessions.listAllSessionsMeta()
      const summaries: RemoteSessionSummary[] = records
        .filter((record) => !record.archivedAt)
        .map((record) => ({ id: record.id, name: record.name ?? '', createdAt: record.createdAt }))
      summaries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return summaries
    }

    case 'get-session': {
      if (!command.sessionId) throw new Error('sessionId is required')
      return readSession(command.sessionId)
    }

    case 'create-session': {
      const session = await createEmpty('chat')
      await ensureWorkModeSettings(session.id)
      await forceAgentModeOn(session.id)
      return { sessionId: session.id }
    }

    case 'send-message': {
      if (!command.sessionId) throw new Error('sessionId is required')
      const text = (command.text ?? '').trim()
      if (!text) throw new Error('text is required')
      // Policy first: a session that inherited "smart" would pause on the first
      // command, and nobody is at the desk to click that dialog.
      await ensureWorkModeSettings(command.sessionId)
      await forceAgentModeOn(command.sessionId)
      const newUserMsg = createMessage('user', text)
      // Generation can run for minutes; the UI never awaits it either. Reply
      // immediately and let the client follow the stream.
      void submitNewUserMessage(command.sessionId, { newUserMsg, needGenerating: true }).catch((error) => {
        log.error('remote send-message failed', { sessionId: command.sessionId, error })
      })
      ensureProgress(command.sessionId)
      return { accepted: true }
    }

    case 'stop': {
      if (!command.sessionId) throw new Error('sessionId is required')
      await stopAllMessageGenerations(command.sessionId)
      return { stopped: true }
    }

    case 'set-agent-mode': {
      if (!command.sessionId) throw new Error('sessionId is required')
      const value = command.value
      if (value !== 'auto' && value !== 'on' && value !== 'off') throw new Error('value must be auto|on|off')
      const entry = await setSessionAgentMode(command.sessionId, value)
      return { agentMode: entry.value, locked: Boolean(entry.locked) }
    }

    // Tool-call approval: the desktop shows a dialog, the phone shows a bar.
    case 'continue-paused': {
      if (!command.sessionId || !command.messageId || !command.toolCallId) {
        throw new Error('sessionId, messageId and toolCallId are required')
      }
      void currentGenerationService
        .continuePausedToolCall(command.sessionId, command.messageId, command.toolCallId)
        .catch((error) => log.error('continuePausedToolCall failed', { error }))
      ensureProgress(command.sessionId)
      return { accepted: true }
    }

    case 'reject-paused': {
      if (!command.sessionId || !command.messageId || !command.toolCallId) {
        throw new Error('sessionId, messageId and toolCallId are required')
      }
      void currentGenerationService
        .stopPausedToolCall(command.sessionId, command.messageId, command.toolCallId)
        .catch((error) => log.error('stopPausedToolCall failed', { error }))
      return { accepted: true }
    }

    default: {
      throw new Error(`unknown op: ${(command as { op?: string }).op}`)
    }
  }
}

let installed = false

export function initRemoteHostBridge(): void {
  if (installed) return
  const api = remoteApi()
  if (!api?.onRemoteHostCommand) {
    // Web / mobile builds have no main process - nothing to bridge.
    return
  }
  installed = true
  primeNewSessionDefaults()
  api.onRemoteHostCommand((envelope: RemoteHostEnvelope) => {
    const reply = (payload: RemoteHostReply) => {
      try {
        api.replyRemoteHostCommand(payload)
      } catch (error) {
        log.error('failed to send remote reply', { error })
      }
    }
    void (async () => {
      try {
        const data = await handleCommand(envelope.command)
        reply({ id: envelope.id, ok: true, data })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('remote command failed', { op: envelope.command.op, error: message })
        reply({ id: envelope.id, ok: false, error: message })
      }
    })()
  })
  log.info('remote host bridge ready')
}
