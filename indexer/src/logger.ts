import pino, { type Logger } from 'pino'
import type { Config } from './config'

/** JSON logs in production; pretty only when explicitly developing. */
export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>): Logger {
  const pretty = config.nodeEnv === 'development'
  return pino({
    level: config.logLevel,
    base: { service: 'compliance-dvn-indexer' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  })
}
