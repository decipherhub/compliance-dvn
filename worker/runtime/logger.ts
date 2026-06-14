import pino, { Logger, LoggerOptions } from 'pino'

export type { Logger }

export interface LoggerConfig {
  logLevel: string
  nodeEnv: string
}

/**
 * Root logger. In production we emit newline-delimited JSON to stdout (ready for Loki /
 * Promtail); in development we route through pino-pretty for human-readable colored output.
 * Secrets are redacted defensively in case they ever reach a log call.
 */
export function createLogger(cfg: LoggerConfig): Logger {
  const base: LoggerOptions = {
    level: cfg.logLevel,
    redact: {
      paths: ['privateKey', 'PRIVATE_KEY', '*.privateKey', 'config.privateKey'],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  }

  if (cfg.nodeEnv !== 'production') {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
      },
    })
  }
  return pino({ ...base, base: { service: 'compliance-dvn' } })
}
