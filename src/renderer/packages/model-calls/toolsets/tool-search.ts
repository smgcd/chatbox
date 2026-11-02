import { toolSearch } from 'ai'
import type { ToolSet } from 'ai'
import { asRecord, toTextModelOutput } from './model-output'

/**
 * On-demand MCP tool loading, built on the AI SDK's own `toolSearch()`.
 *
 * Registering every MCP tool with the provider costs its full JSON schema on every request —
 * with a few servers installed that is tens of thousands of characters the model mostly never
 * reads. Marking a tool `deferLoading: true` keeps its definition out of the request until the
 * model calls the search tool; the SDK discovers it and exposes it from the next step on
 * (`prepare-tool-search.ts` in ai, applied after `filterActiveTools`, so this composes with
 * prepareStep's activeTools).
 *
 * The prompt keeps a name-only catalog (see `buildDeferredToolsInstruction`) so the model can aim
 * its searches instead of guessing. Ranking goes through this module's `search` callback rather
 * than the SDK default: the default splits on camelCase and matches whole words, which never
 * matches a Chinese query against English tool descriptions. Ours tokenizes CJK runs, matches
 * substrings, and boosts the server name so "scrapling" loads that whole server.
 */

export const SEARCH_TOOLS_TOOL_NAME = 'search_tools'

/** Matches per search. The SDK default is 5; MCP work often needs navigate + click + snapshot at once. */
export const SEARCH_TOOLS_MAX_RESULTS = 8

const DESCRIPTION_PREVIEW_LIMIT = 320

export interface DeferredToolEntry {
  /** Provider-visible tool name, e.g. `mcp__playwright__browser_click`. */
  name: string
  /** Tool name without the `mcp__<server>__` prefix, e.g. `browser_click`. */
  shortName: string
  /** MCP server the tool came from (empty when the name is not MCP-prefixed). */
  server: string
  description: string
}

export interface SearchableToolSummary {
  name: string
  description?: string
}

/** Split `mcp__<server>__<tool>` into its parts; server names keep any inner `_`. */
export function describeDeferredTool(name: string, description: string): DeferredToolEntry {
  const match = /^mcp__(.+)__(.+)$/.exec(name)
  if (!match) return { name, shortName: name, server: '', description }
  return { name, server: match[1], shortName: match[2], description }
}

/**
 * Mark every tool in the set as deferred, so the SDK keeps its definition out of the request
 * until the model discovers it with the search tool.
 */
export function markToolsAsDeferred(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, { ...tool, deferLoading: true }])
  ) as ToolSet
}

/** Split a query into lowercase match tokens; CJK runs stay whole, so they match by substring. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;/|+，。、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function scoreTool(entry: DeferredToolEntry, tokens: readonly string[]): number {
  const name = entry.name.toLowerCase()
  const shortName = entry.shortName.toLowerCase()
  const server = entry.server.toLowerCase()
  const description = entry.description.toLowerCase()
  let score = 0

  for (const token of tokens) {
    if (name === token || shortName === token) score += 1000
    else if (name.startsWith(token) || shortName.startsWith(token)) score += 320
    else if (shortName.includes(token)) score += 200
    else if (name.includes(token)) score += 180

    if (server && server === token) score += 400
    else if (server && server.includes(token)) score += 80

    if (description.includes(token)) score += 40

    // `browser_click`-style tokens also match on their meaningful parts, so
    // "click element" still finds `browser_click`.
    for (const part of token.split(/[_\-\s]+/)) {
      if (part.length < 3 || part === token) continue
      if (shortName.includes(part)) score += 35
      else if (description.includes(part)) score += 10
    }
  }

  return score
}

/**
 * Rank deferred tools for a query. Passed to `toolSearch({ search })`: it receives the query and
 * every eligible deferred tool (name + resolved description) and returns names in ranked order;
 * the SDK drops unknown names and duplicates, then keeps the first `maxResults`.
 */
export function rankDeferredToolNames(query: string, candidates: readonly SearchableToolSummary[]): string[] {
  const normalized = query.trim().toLowerCase()
  // An empty query or "*" is an explicit "show me everything" request.
  if (!normalized || normalized === '*') return candidates.map((candidate) => candidate.name)
  const tokens = tokenize(normalized)
  if (tokens.length === 0) return []

  return candidates
    .map((candidate) => ({
      name: candidate.name,
      score: scoreTool(describeDeferredTool(candidate.name, candidate.description ?? ''), tokens),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((candidate) => candidate.name)
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

/** Keeps the tool result the model reads short: names plus a one-line description preview. */
function formatToolSearchOutput(output: unknown): string {
  const matches = asRecord(output)?.tools
  const tools = Array.isArray(matches)
    ? (matches as Array<{ name?: unknown; description?: unknown }>).filter(
        (tool): tool is { name: string; description?: string } => typeof tool.name === 'string'
      )
    : []
  if (tools.length === 0) {
    return (
      'No tool matched that query, so nothing was loaded. Try a shorter English keyword ' +
      '(for example "screenshot", "click", "navigate") or the exact tool name from the catalog.'
    )
  }
  const lines = tools.map(
    (tool) =>
      `- ${tool.name}${typeof tool.description === 'string' && tool.description ? `: ${truncate(tool.description, DESCRIPTION_PREVIEW_LIMIT)}` : ''}`
  )
  return [
    `Loaded ${tools.length} tool(s). They are callable from your next step:`,
    ...lines,
    'Call the tool you need now. Load more with this tool if something is still missing.',
  ].join('\n')
}

/** The SDK rebinds `execute` per generation but keeps our `toModelOutput`, so the result text stays compact. */
export function buildToolSearchTool(): ToolSet[string] {
  const searchTool = toolSearch({
    maxResults: SEARCH_TOOLS_MAX_RESULTS,
    search: ({ query, tools }) => rankDeferredToolNames(query, tools),
  })
  return {
    ...searchTool,
    toModelOutput: toTextModelOutput(formatToolSearchOutput, {
      emptyFallback: 'No tool matched that query, so nothing was loaded.',
    }),
  } as ToolSet[string]
}

/** Name-only catalog of the deferred tools, grouped by server, plus the loading workflow. */
export function buildDeferredToolsInstruction(entries: readonly DeferredToolEntry[]): string {
  if (entries.length === 0) return ''
  const byServer = new Map<string, DeferredToolEntry[]>()
  for (const entry of entries) {
    const key = entry.server || 'mcp'
    const bucket = byServer.get(key)
    if (bucket) bucket.push(entry)
    else byServer.set(key, [entry])
  }
  const catalog = [...byServer.entries()]
    .map(([server, group]) => `- ${server} (${group.length}): ${group.map((entry) => entry.shortName).join(', ')}`)
    .join('\n')

  return `
## Tools on Demand
MCP server tools are listed by name only; their definitions are not part of this request. Load a tool before calling it.

### MCP tool catalog
${catalog}

### Loading a tool
1. Call \`${SEARCH_TOOLS_TOOL_NAME}\` with a short English keyword, an exact tool name, or a server name.
2. Matching tools become callable on your next step and stay available for the rest of this turn.
3. Load only what the task needs: every loaded tool adds its full schema to the request.
Calling a tool that is not loaded yet fails — load it first instead of guessing its arguments.
`
}
