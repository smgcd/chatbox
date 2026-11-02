import { describe, expect, test } from 'vitest'
import { buildSkillSearchTool, searchSkills } from './skill-search'

const SKILLS = [
  { name: 'pdf', description: 'Read, merge and split PDF files; OCR scanned PDFs.' },
  { name: 'xlsx', description: 'Create and edit spreadsheet files, formulas and charts.' },
  { name: 'humanizer', description: 'Remove signs of AI-generated writing from text.' },
  { name: 'ghidra-headless', description: 'Decompile binaries with the Ghidra headless analyzer.' },
]

describe('searchSkills', () => {
  test('matches the name first', () => {
    expect(searchSkills(SKILLS, 'xlsx')[0]?.name).toBe('xlsx')
  })

  test('matches descriptions too', () => {
    expect(searchSkills(SKILLS, 'spreadsheet').map((skill) => skill.name)).toContain('xlsx')
    expect(searchSkills(SKILLS, 'decompile').map((skill) => skill.name)).toContain('ghidra-headless')
  })

  test('returns nothing for an unrelated query', () => {
    expect(searchSkills(SKILLS, 'zzzz')).toEqual([])
  })

  test('an asterisk lists everything up to the limit', () => {
    expect(searchSkills(SKILLS, '*')).toHaveLength(SKILLS.length)
    expect(searchSkills(SKILLS, '*', 2)).toHaveLength(2)
  })
})

describe('buildSkillSearchTool', () => {
  test('reports matching skills with descriptions so the model can pick one to load', async () => {
    const tool = buildSkillSearchTool(SKILLS)
    const output = await tool.execute?.({ query: 'spreadsheet' }, {} as never)
    const mapped = (await tool.toModelOutput?.({
      toolCallId: 'call-1',
      input: { query: 'spreadsheet' },
      output,
    })) as { type: 'text'; value: string }

    expect(mapped.value).toContain('- xlsx: Create and edit spreadsheet files')
    expect(mapped.value).toContain('load_skill')
  })
})
