import { validatedToolSchema } from '@shared/validated-tool-schema'
import type { ToolSet } from 'ai'
import { asRecord, toTextModelOutput } from './model-output'

/**
 * On-demand skill discovery.
 *
 * Every enabled skill contributes `name: description` to the system prompt, and the
 * descriptions are long — a few dozen skills cost more prompt characters than the
 * whole tool catalog. When many skills are enabled the prompt keeps the names only and
 * this tool returns the matching descriptions, so the model can pick a skill to load
 * with `load_skill` instead of reading every description up front.
 */

export const SEARCH_SKILLS_TOOL_NAME = 'search_skills'

const DEFAULT_MAX_RESULTS = 6
const MAX_RESULTS_LIMIT = 15
const DESCRIPTION_PREVIEW_LIMIT = 500

export interface SearchableSkill {
  name: string
  description: string
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_MAX_RESULTS
  const rounded = Math.floor(limit)
  if (rounded < 1) return DEFAULT_MAX_RESULTS
  return Math.min(rounded, MAX_RESULTS_LIMIT)
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;/|+，。、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function scoreSkill(skill: SearchableSkill, tokens: readonly string[]): number {
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name === token) score += 1000
    else if (name.startsWith(token)) score += 320
    else if (name.includes(token)) score += 200
    if (description.includes(token)) score += 40
    for (const part of token.split(/[_\-\s]+/)) {
      if (part.length < 3 || part === token) continue
      if (name.includes(part)) score += 35
      else if (description.includes(part)) score += 10
    }
  }
  return score
}

export function searchSkills(
  skills: readonly SearchableSkill[],
  query: string,
  limit?: number
): SearchableSkill[] {
  const cap = normalizeLimit(limit)
  const normalized = query.trim().toLowerCase()
  if (!normalized || normalized === '*') return skills.slice(0, cap)
  const tokens = tokenize(normalized)
  if (tokens.length === 0) return []
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, cap)
    .map((item) => item.skill)
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

function formatSkillSearchOutput(output: unknown): string {
  const record = asRecord(output)
  const matches = Array.isArray(record?.matches) ? (record.matches as SearchableSkill[]) : []
  if (matches.length === 0) {
    return (
      'No skill matched that query. Try another keyword, or continue without a skill: ' +
      'most tasks do not need one.'
    )
  }
  const lines = matches.map((skill) => `- ${skill.name}: ${truncate(skill.description, DESCRIPTION_PREVIEW_LIMIT)}`)
  return [
    `Matching skills (${matches.length}):`,
    ...lines,
    'Call load_skill with the name of the skill that fits; skip the skill at all if none of them does.',
  ].join('\n')
}

export function buildSkillSearchTool(skills: readonly SearchableSkill[]): ToolSet[string] {
  return {
    description:
      'Search the installed skills by keyword and get their descriptions. Use it when the task ' +
      'might match a skill whose name alone does not tell you enough; then call load_skill for the ' +
      'matching skill. Skills are independent of tools: most tasks need no skill.',
    inputSchema: validatedToolSchema({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'One or two English keywords describing the task (e.g. "spreadsheet", "ocr", "decompile", ' +
            '"word document"). Use "*" to list every enabled skill.',
        },
        limit: {
          type: 'number',
          description: `Maximum skills to return (1-${MAX_RESULTS_LIMIT}, default ${DEFAULT_MAX_RESULTS}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: (input) => {
      const { query, limit } = input as { query: string; limit?: number }
      return { matches: searchSkills(skills, query, limit) }
    },
    toModelOutput: toTextModelOutput(formatSkillSearchOutput, {
      emptyFallback: 'No skill matched that query.',
    }),
  }
}
