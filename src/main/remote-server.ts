/**
 * LAN remote host server (local-only feature, not upstreamed).
 *
 * Purpose: let an iPad on the same WiFi see Chatbox's progress, type into it,
 * and stop it - while the desktop itself stays completely silent (hidden
 * window, no tray, no focus stealing, no OS input injection).
 *
 * Security posture (LAN only):
 *  - bearer token required for every request; the token is generated per launch
 *    and can also be pinned via CHATBOX_REMOTE_TOKEN.
 *  - only RFC1918 / loopback peers are accepted, so binding 0.0.0.0 cannot be
 *    reached from outside the LAN.
 *  - the command surface is a small closed enum (`RemoteHostOp`); this is NOT a
 *    generic IPC proxy.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { RemoteHostCommand, RemoteHostEnvelope, RemoteHostReply, RemoteProgressEvent } from '@shared/remote-host'
import { REMOTE_CLIENT_HTML } from './remote-client-html'

const REPLY_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 30_000

export interface RemoteHostServerHandle {
  port: number
  token: string
  url: string
  close: () => void
}

/**
 * The token is a long-lived device credential, not a per-launch nonce: it is
 * stored in the profile so the iPad's cookie survives a Chatbox restart or a
 * guard-driven crash recovery. Without this the phone would silently 401 after
 * every restart and the reconnect banner could never clear.
 * `--new-token` (or CHATBOX_REMOTE_TOKEN) rotates/overrides it.
 */
function loadOrCreateToken(tokenFile: string | null, rotate: boolean): string {
  if (process.env.CHATBOX_REMOTE_TOKEN) return process.env.CHATBOX_REMOTE_TOKEN
  if (!tokenFile) return randomBytes(16).toString('hex')
  if (!rotate) {
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(existing)) return existing
    } catch {
      // first run
    }
  }
  const token = randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.error('[remote-host] failed to persist token', error)
  }
  return token
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
const sseClients = new Set<http.ServerResponse>()
let ipcInstalled = false

/**
 * Replay window for reconnects. Every frame gets a monotonic id and lands in a
 * ring buffer; a browser that reconnects (iPad lock, WiFi blip, Safari killing
 * the socket) sends `Last-Event-ID` automatically and we replay what it missed
 * instead of leaving a hole in the transcript. 400 frames ~= 60s of streaming,
 * well under 4 MB.
 */
const FRAME_HISTORY_LIMIT = 400
let frameSeq = 0
const frameHistory: { seq: number; payload: string }[] = []

function broadcastProgress(event: RemoteProgressEvent): void {
  frameSeq += 1
  const payload = JSON.stringify(event)
  frameHistory.push({ seq: frameSeq, payload })
  if (frameHistory.length > FRAME_HISTORY_LIMIT) frameHistory.shift()
  if (sseClients.size === 0) return
  const frame = `id: ${frameSeq}\ndata: ${payload}\n\n`
  for (const client of sseClients) {
    try {
      client.write(frame)
    } catch {
      sseClients.delete(client)
    }
  }
}

/** Frames newer than the id the browser last saw (0 = fresh connection). */
function framesSince(lastEventId: number): { seq: number; payload: string }[] {
  if (!Number.isFinite(lastEventId) || lastEventId <= 0) return []
  return frameHistory.filter((frame) => frame.seq > lastEventId)
}

function installIpc(): void {
  if (ipcInstalled) return
  ipcInstalled = true
  ipcMain.on('remote-host:progress', (_event, progress: RemoteProgressEvent) => {
    broadcastProgress(progress)
  })
  ipcMain.on('remote-host:reply', (_event, reply: RemoteHostReply) => {
    const entry = reply && pending.get(reply.id)
    if (!entry) return
    pending.delete(reply.id)
    clearTimeout(entry.timer)
    if (reply.ok) {
      entry.resolve(reply.data)
    } else {
      entry.reject(new Error(reply.error || 'remote command failed'))
    }
  })
}

function findLanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address
      }
    }
  }
  return null
}

function isPrivatePeer(rawAddress: string | undefined): boolean {
  if (!rawAddress) return false
  // Strip the IPv4-mapped IPv6 prefix Node sometimes reports.
  const address = rawAddress.startsWith('::ffff:') ? rawAddress.slice(7) : rawAddress
  if (address === '::1' || address === '127.0.0.1') return true
  const octets = address.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local
  return false
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const entry of header.split(';')) {
    const index = entry.indexOf('=')
    if (index < 0) continue
    result[entry.slice(0, index).trim()] = entry.slice(index + 1).trim()
  }
  return result
}

async function execCommand(
  getWindow: () => BrowserWindow | null,
  command: RemoteHostCommand,
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<unknown> {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    throw new Error('Chatbox renderer is not available')
  }
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      const onLoaded = () => resolve()
      window.webContents.once('did-finish-load', onLoaded)
      setTimeout(resolve, 20_000)
    })
  }

  const id = randomBytes(8).toString('hex')
  const envelope: RemoteHostEnvelope = { id, command }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for renderer (${command.op})`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      window.webContents.send('remote-host:command', envelope)
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    // utf8 decoding at the stream level keeps multi-byte characters intact when
    // a request body is split across chunks.
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 1_000_000) {
        reject(new Error('body too large'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

export function startRemoteHostServer(options: {
  getWindow: () => BrowserWindow | null
  port: number
  /** Where the persistent token lives (profile dir); null = in-memory only. */
  tokenFile?: string | null
  /** Force a fresh token (a phone that lost the cookie must re-open the URL). */
  rotateToken?: boolean
}): Promise<RemoteHostServerHandle> {
  installIpc()
  const token = loadOrCreateToken(options.tokenFile ?? null, options.rotateToken === true)

  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress
    if (!isPrivatePeer(remote)) {
      sendJson(response, 403, { error: 'LAN peers only' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const cookies = parseCookies(request.headers.cookie)

    // Landing page: bootstrap the cookie from ?t=<token>, then serve the app.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const queryToken = url.searchParams.get('t')
      if (queryToken === token) {
        response.writeHead(302, {
          location: '/',
          'set-cookie': `cbx=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      if (cookies.cbx !== token) {
        response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<body style="font:16px -apple-system;padding:32px">未授权：请使用带 token 的链接打开。</body>'
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(REMOTE_CLIENT_HTML)
      return
    }

    // Live streaming frames (Server-Sent Events). One persistent connection per
    // phone; the renderer pushes ~150ms frames, we just relay them.
    if (url.pathname === '/api/events') {
      const headerToken = request.headers['x-cbx-token']
      const supplied = typeof headerToken === 'string' ? headerToken : cookies.cbx
      if (supplied !== token) {
        sendJson(response, 401, { error: 'invalid token' })
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // Retry fast: the phone is on the same WiFi, a long backoff just looks broken.
      response.write('retry: 1500\n\n')
      response.write(': connected\n\n')
      const lastEventIdRaw = request.headers['last-event-id'] ?? url.searchParams.get('since') ?? ''
      const lastEventId = Number(Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw)
      const missed = framesSince(lastEventId)
      for (const frame of missed) {
        try {
          response.write(`id: ${frame.seq}\ndata: ${frame.payload}\n\n`)
        } catch {
          break
        }
      }
      // Tell the client how many frames were replayed (and where the stream now
      // stands) so it can decide whether a full snapshot refresh is needed.
      response.write(`data: ${JSON.stringify({ type: 'hello', seq: frameSeq, replayed: missed.length })}\n\n`)
      sseClients.add(response)
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          sseClients.delete(response)
        }
      }, 15_000)
      request.on('close', () => {
        clearInterval(heartbeat)
        sseClients.delete(response)
      })
      return
    }

    if (url.pathname === '/api/exec') {
      const headerToken = request.headers['x-cbx-token']
      const supplied = typeof headerToken === 'string' ? headerToken : cookies.cbx
      if (supplied !== token) {
        sendJson(response, 401, { error: 'invalid token' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'POST only' })
        return
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(request)) as RemoteHostCommand
          const timeout = body?.op === 'stop' ? STOP_TIMEOUT_MS : REPLY_TIMEOUT_MS
          const data = await execCommand(options.getWindow, body, timeout)
          sendJson(response, 200, { ok: true, data })
        } catch (error) {
          sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
      return
    }

    sendJson(response, 404, { error: 'not found' })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '0.0.0.0', () => {
      const address = findLanAddress() ?? '127.0.0.1'
      const port = (server.address() as { port: number }).port
      const url = `http://${address}:${port}/?t=${token}`
      // The token is the only credential; printing it to the local log is the
      // intended hand-off channel for the phone.
      console.log(`[remote-host] listening on ${address}:${port}`)
      console.log(`[remote-host] open on iPad (same WiFi): ${url}`)
      resolve({
        port,
        token,
        url,
        close: () => {
          for (const client of sseClients) {
            try {
              client.end()
            } catch {
              // ignore
            }
          }
          sseClients.clear()
          server.close()
        },
      })
    })
  })
}

/** Written to a file next to the log so it can be read without scrolling logs. */
export function describeRemoteUrl(handle: RemoteHostServerHandle): string {
  return `Chatbox 局域网遥控\n地址：${handle.url}\n（同一 WiFi 下用 iPad Safari 打开一次即可：token 已存在本机配置里，重启/崩溃恢复后同一个地址继续可用；要作废旧设备请用 --serve --new-token 启动一次）\n`
}
