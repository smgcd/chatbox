import { useCallback, useMemo } from 'react'
import { rendererApplication } from '@/app/renderer-application'
import { BUILTIN_MCP_SERVERS } from '@/packages/mcp/builtin'
import { useSessionSettings } from '@/stores/session/session-settings'
import { useMcpSettings } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

export interface SessionMcpServer {
  id: string
  name: string
  /** Built-in (ChatboxAI-hosted) server rather than one the user added. */
  builtin: boolean
  /** Switched on in Settings → MCP; a server that is off globally has no live tools. */
  globallyEnabled: boolean
  /** Whether this chat hands the server's tools to the model. */
  enabledInSession: boolean
}

/**
 * Session-scoped MCP selection. The global switches (Settings → MCP) decide whether a
 * server runs at all and are unchanged; this decides whether *this* chat passes its
 * tools to the model. Muting a server here leaves it running for every other chat, so
 * a conversation can keep Work Mode (code execution, skills, files) without a
 * particular MCP tool set.
 *
 * A brand-new chat (sessionId === 'new') is not persisted yet, so its choice lives in
 * uiStore.newSessionState and is baked into the created session's settings on first
 * submit (see routes/index.tsx) — the same path working directories take.
 */
export function useSessionMcpState(sessionId: string, options: { includeBuiltin?: boolean } = {}) {
  const includeBuiltin = options.includeBuiltin ?? false
  const isNewSession = sessionId === 'new'
  const mcp = useMcpSettings()
  const newSessionState = useUIStore((s) => s.newSessionState)
  const setNewSessionState = useUIStore((s) => s.setNewSessionState)
  const { sessionSettings } = useSessionSettings(isNewSession ? null : sessionId)

  const disabledServerIds = useMemo(
    () =>
      isNewSession
        ? (newSessionState.disabledMcpServers ?? [])
        : (sessionSettings.disabledMcpServers ?? []),
    [isNewSession, newSessionState.disabledMcpServers, sessionSettings.disabledMcpServers]
  )

  const servers = useMemo<SessionMcpServer[]>(() => {
    const list: SessionMcpServer[] = []
    if (includeBuiltin) {
      for (const server of BUILTIN_MCP_SERVERS) {
        list.push({
          id: server.id,
          name: server.name,
          builtin: true,
          globallyEnabled: mcp.enabledBuiltinServers.includes(server.id),
          enabledInSession: !disabledServerIds.includes(server.id),
        })
      }
    }
    for (const server of mcp.servers) {
      list.push({
        id: server.id,
        name: server.name,
        builtin: false,
        globallyEnabled: Boolean(server.enabled),
        enabledInSession: !disabledServerIds.includes(server.id),
      })
    }
    return list
  }, [disabledServerIds, includeBuiltin, mcp.enabledBuiltinServers, mcp.servers])

  // Servers actually reaching the model in this chat: globally on and not muted here.
  const enabledCount = useMemo(
    () => servers.filter((server) => server.globallyEnabled && server.enabledInSession).length,
    [servers]
  )

  const setSessionServerEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const next = enabled
        ? disabledServerIds.filter((serverId) => serverId !== id)
        : Array.from(new Set([...disabledServerIds, id]))
      if (isNewSession) {
        setNewSessionState((prev) => ({ ...prev, disabledMcpServers: next }))
        return
      }
      try {
        await rendererApplication.sessions.updateSession(sessionId, (session) => {
          if (!session) {
            throw new Error('Session not found')
          }
          return {
            ...session,
            settings: {
              ...session.settings,
              // Stay absent when nothing is muted so untouched chats keep following
              // the global list instead of storing an empty array.
              disabledMcpServers: next.length > 0 ? next : undefined,
            },
          }
        })
      } catch (err) {
        console.error('Failed to update session MCP servers:', err)
      }
    },
    [disabledServerIds, isNewSession, sessionId, setNewSessionState]
  )

  return { servers, disabledServerIds, enabledCount, setSessionServerEnabled }
}
