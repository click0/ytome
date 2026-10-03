/**
 * Кожен MCP-інструмент має Zod-схему, і кожна схема — інструмент.
 * Без схеми validateArgs мовчки пропускає аргументи як є.
 */
import { describe, it, expect } from 'vitest';
import { TOOLS } from '../src/mcp/handlers';
import { SCHEMAS } from '../src/mcp/validation';

describe('MCP tools ↔ Zod schemas', () => {
  const toolNames = TOOLS.map(t => t.name);

  it('tool names are unique', () => {
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it('every tool has a validation schema', () => {
    expect(toolNames.filter(n => !SCHEMAS[n])).toEqual([]);
  });

  it('every schema belongs to a tool', () => {
    expect(Object.keys(SCHEMAS).filter(n => !toolNames.includes(n))).toEqual([]);
  });
});
