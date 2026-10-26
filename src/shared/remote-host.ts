/**
 * LAN remote-host protocol (local-only feature, not upstreamed).
 *
 * The main process exposes a tiny HTTP API on the LAN; the browser client
 * (iPad) polls it. Every command is forwarded to the renderer, which owns the
 * real business logic, and answered over IPC. No business logic is duplicated
 * here - this file only carries the wire shapes.
 */
import type { Message } from './types'
import { getMessageText } from './utils/message'

export type RemoteHostOp =
  | 'list-sessions'
  | 'get-session'
  | 'send-message'
  | 'stop'
  | 'create-session'
  | 'set-agent-mode'
  | 'continue-paused'
  | 'reject-paused'

export interface RemoteHostCommand {
  op: RemoteHostOp
  sessionId?: string
  text?: string
  name?: string
  /** AgentModeValue for set-agent-mode. */
  value?: string
  messageId?: string
  toolCallId?: string
}

export interface RemoteHostEnvelope {
  id: string
  command: RemoteHostCommand
}

export interface RemoteHostReply {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

export interface RemoteToolCallDigest {
  toolCallId: string
  toolName: string
  /** Mirrors the persisted tool-call state. */
  state: 'call' | 'result' | 'error' | 'paused'
  duration?: number
  /** Short one-line argument preview so the phone can show what is running. */
  brief?: string
}

export interface RemoteMessageDigest {
  id: string
  role: string
  text: string
  /** Reasoning stream - the phone shows this while the model is still thinking. */
  reasoning?: string
  generating: boolean
  error?: string
  tools: RemoteToolCallDigest[]
}

export interface RemoteSessionDigest {
  id: string
  name: string
  createdAt?: number
  /** 'auto' | 'on' | 'off' */
  agentMode?: string
  /** True while the session is locked from switching agent mode. */
  agentModeLocked?: boolean
  generating: boolean
  /** True while any tool call is still running - drives the phone's status line. */
  busy: boolean
  messages: RemoteMessageDigest[]
}

export interface RemoteSessionSummary {
  id: string
  name: string
  createdAt?: number
}

/**
 * What this instance can actually do right now. The phone has no Work Mode
 * panel, so it displays the effective policy instead of letting it be toggled -
 * this is also how we prove in the UI that the remote run is not degraded.
 */
export interface RemoteCapabilities {
  agentMode: string
  agentModeLocked: boolean
  approvalMode: 'always_ask' | 'smart' | 'full_access'
  webBrowsing: boolean
  /** Enabled skill count, from the same global settings the desktop uses. */
  skills: number
  /** Enabled MCP servers (custom + builtin). */
  mcp: number
}

/** Payload of `get-session`: the digest plus the live policy snapshot. */
export interface RemoteSessionView extends RemoteSessionDigest {
  agentMode?: string
  agentModeLocked?: boolean
  capabilities: RemoteCapabilities
}

/** Real-time streaming frame pushed from the renderer, relayed over SSE. */
export interface RemoteProgressEvent {
  type: 'progress'
  sessionId: string
  messageId: string
  text: string
  reasoning?: string
  generating: boolean
  tools: RemoteToolCallDigest[]
}

const PROGRESS_TAIL_LIMIT = 4000

function tail(value: string, limit: number): string {
  return value.length > limit ? value.slice(-limit) : value
}

/**
 * Builds the live frame for the message currently being generated. Called on a
 * short interval by the renderer bridge; `updateStreamingCache` refreshes the
 * in-memory session on every stream chunk, so this is as fresh as the UI is.
 */
export function buildProgressEvent(
  sessionId: string,
  message: {
    id: string
    generating?: boolean
    contentParts?: Message['contentParts']
  }
): RemoteProgressEvent {
  const digest = digestMessage(message as Message)
  return {
    type: 'progress',
    sessionId,
    messageId: digest.id,
    text: tail(digest.text, PROGRESS_TAIL_LIMIT),
    reasoning: digest.reasoning ? tail(digest.reasoning, PROGRESS_TAIL_LIMIT) : undefined,
    generating: digest.generating,
    tools: digest.tools,
  }
}

function briefArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined
  let text: string
  try {
    text = JSON.stringify(args) ?? ''
  } catch {
    return undefined
  }
  if (text === '{}' || text === 'null') return undefined
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

export function digestMessage(message: Message): RemoteMessageDigest {
  const tools: RemoteToolCallDigest[] = []
  let text = ''
  let reasoning = ''
  for (const part of message.contentParts ?? []) {
    if (part.type === 'tool-call') {
      tools.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        state: part.state,
        duration: part.duration,
        brief: briefArgs(part.args),
      })
      continue
    }
    if (part.type === 'text' && !part.protocolOnly) {
      text += part.text
      continue
    }
    if (part.type === 'reasoning' && !part.protocolOnly) {
      reasoning += part.text
    }
  }
  if (!text) {
    // Fall back to the shared projection so attachments / images still show up.
    text = getMessageText(message)
  }
  return {
    id: message.id,
    role: message.role,
    text,
    // Only ship the tail: the phone needs progress, not the full chain of thought.
    reasoning: reasoning ? reasoning.slice(-1200) : undefined,
    generating: Boolean(message.generating),
    error: message.error,
    tools,
  }
}

export function digestSession(session: {
  id: string
  name?: string
  createdAt?: number
  messages?: Message[]
}): RemoteSessionDigest {
  const messages = (session.messages ?? []).map(digestMessage)
  const generating = messages.some((m) => m.generating)
  const busy = generating || messages.some((m) => m.tools.some((t) => t.state === 'call'))
  return {
    id: session.id,
    name: session.name ?? '',
    createdAt: session.createdAt,
    generating,
    busy,
    messages,
  }
}