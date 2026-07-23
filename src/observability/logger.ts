import pino from 'pino';
import { getConfig } from '../config.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  const config = getConfig();
  _logger = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });

  return _logger;
}

export function logEvent(
  event: string,
  meta: Record<string, unknown> = {},
): void {
  const logger = getLogger();
  logger.info({ event, ...meta }, event);
}
