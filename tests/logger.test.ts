/**
 * Тести модуля логування
 */
import { describe, it, expect } from 'vitest';
import { logger, createLogger } from '../src/logger';

describe('logger', () => {
  it('exports a pino logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('createLogger returns a child logger with module context', () => {
    const child = createLogger('test-module');
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });

  it('child logger preserves parent level', () => {
    const child = createLogger('test');
    // pino child loggers inherit the level from parent
    expect(child.level).toBe(logger.level);
  });
});
