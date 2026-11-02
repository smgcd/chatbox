import { generateText, isStepCount, jsonSchema } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import {
  buildDeferredToolsInstruction,
  buildToolSearchTool,
  describeDeferredTool,
  markToolsAsDeferred,
  rankDeferredToolNames,
  SEARCH_TOOLS_TOOL_NAME,
} from './tool-search'

const CANDIDATES = [
  { name: 'mcp__playwright__browser_click', description: 'Click an element on the page' },
  { name: 'mcp__playwright__browser_navigate', description: 'Navigate the browser to a URL' },
  { name: 'mcp__playwright__browser_take_screenshot', description: 'Take a screenshot of the page' },
  { name: 'mcp__scrapling__bulk_get', description: 'Fetch a batch of URLs over HTTP' },
  { name: 'mcp__local-llm__local_llm_generate', description: 'Generate text with the local model' },
]

describe('describeDeferredTool', () => {
  test('splits the mcp__<server>__<tool> prefix, keeping inner underscores in the server', () => {
    expect(describeDeferredTool('mcp__my_server__run', '')).toEqual({
      name: 'mcp__my_server__run',
      server: 'my_server',
      shortName: 'run',
      description: '',
    })
  })

  test('falls back to the raw name when the tool is not MCP-prefixed', () => {
    expect(describeDeferredTool('plain_tool', 'x')).toEqual({
      name: 'plain_tool',
      server: '',
      shortName: 'plain_tool',
      description: 'x',
    })
  })
})

describe('rankDeferredToolNames', () => {
  test('an exact tool name wins over a description match', () => {
    expect(rankDeferredToolNames('browser_click', CANDIDATES)[0]).toBe('mcp__playwright__browser_click')
  })

  test('a keyword finds tools by name and description', () => {
    const names = rankDeferredToolNames('screenshot', CANDIDATES)
    expect(names[0]).toBe('mcp__playwright__browser_take_screenshot')
    expect(names).not.toContain('mcp__local-llm__local_llm_generate')
  })

  test('a server name raises all of its tools', () => {
    expect(rankDeferredToolNames('scrapling', CANDIDATES)[0]).toBe('mcp__scrapling__bulk_get')
  })

  test('an empty query or asterisk ranks everything', () => {
    expect(rankDeferredToolNames('', CANDIDATES)).toHaveLength(CANDIDATES.length)
    expect(rankDeferredToolNames('*', CANDIDATES)).toHaveLength(CANDIDATES.length)
  })

  test('an unrelated query ranks nothing', () => {
    expect(rankDeferredToolNames('zzzz', CANDIDATES)).toEqual([])
  })
})

describe('buildDeferredToolsInstruction', () => {
  const entries = CANDIDATES.map((candidate) => describeDeferredTool(candidate.name, candidate.description ?? ''))

  test('lists names by server without descriptions', () => {
    const instruction = buildDeferredToolsInstruction(entries)
    expect(instruction).toContain('playwright (3): browser_click, browser_navigate, browser_take_screenshot')
    expect(instruction).toContain('## Tools on Demand')
    expect(instruction).toContain(SEARCH_TOOLS_TOOL_NAME)
    expect(instruction).not.toContain('Click an element on the page')
  })

  test('is empty when nothing is deferred', () => {
    expect(buildDeferredToolsInstruction([])).toBe('')
  })
})

/**
 * End-to-end proof that the official SDK mechanism does the work: the deferred definition is
 * absent from the first request, discovered by the search tool, present on the second request,
 * and actually executed.
 */
describe('AI SDK tool search integration', () => {
  test('keeps deferred definitions out of the request until the model searches for them', async () => {
    const requestedTools: string[][] = []
    const executed: string[] = []
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    }

    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        requestedTools.push((options.tools ?? []).map((tool) => tool.name))
        const call = requestedTools.length
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-search',
                toolName: SEARCH_TOOLS_TOOL_NAME,
                input: JSON.stringify({ query: 'click' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage,
            warnings: [],
          }
        }
        if (call === 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-click',
                toolName: 'mcp__playwright__browser_click',
                input: JSON.stringify({ selector: '#go' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'done' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
          warnings: [],
        }
      },
    })

    const result = await generateText({
      model,
      stopWhen: isStepCount(5),
      prompt: 'click the go button',
      tools: {
        [SEARCH_TOOLS_TOOL_NAME]: buildToolSearchTool(),
        read_file: {
          description: 'Read a file',
          inputSchema: jsonSchema<{ path: string }>({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          }),
          execute: async () => 'contents',
        },
        ...markToolsAsDeferred({
          'mcp__playwright__browser_click': {
            description: 'Click an element on the page',
            inputSchema: jsonSchema<{ selector: string }>({
              type: 'object',
              properties: { selector: { type: 'string' } },
              required: ['selector'],
              additionalProperties: false,
            }),
            execute: async () => {
              executed.push('mcp__playwright__browser_click')
              return 'clicked'
            },
          },
          'mcp__playwright__browser_navigate': {
            description: 'Navigate the browser to a URL',
            inputSchema: jsonSchema<{ url: string }>({
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
              additionalProperties: false,
            }),
            execute: async () => 'navigated',
          },
        }),
      },
    })

    // First request: only the search tool and core tools — the deferred schemas are absent.
    expect(requestedTools[0]?.sort()).toEqual(['read_file', SEARCH_TOOLS_TOOL_NAME].sort())
    // Second request: the discovered tool is now part of the request…
    expect(requestedTools[1]).toContain('mcp__playwright__browser_click')
    // …and only the one that was discovered, not its sibling.
    expect(requestedTools[1]).not.toContain('mcp__playwright__browser_navigate')
    // …and it really ran.
    expect(executed).toEqual(['mcp__playwright__browser_click'])
    expect(result.steps).toHaveLength(3)
  })
})
