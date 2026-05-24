const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

function timestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function line(level: string, color: string, message: string, meta?: Record<string, unknown>) {
  const suffix = meta && Object.keys(meta).length ? ` ${colors.gray}${JSON.stringify(meta)}${colors.reset}` : ''
  console.log(`${colors.gray}${timestamp()}${colors.reset} ${color}${level}${colors.reset} ${message}${suffix}`)
}

export function logInfo(message: string, meta?: Record<string, unknown>) {
  line('INFO ', colors.cyan, message, meta)
}

export function logOk(message: string, meta?: Record<string, unknown>) {
  line('OK   ', colors.green, message, meta)
}

export function logWarn(message: string, meta?: Record<string, unknown>) {
  line('WARN ', colors.yellow, message, meta)
}

export function logError(message: string, meta?: Record<string, unknown>) {
  line('ERROR', colors.red, message, meta)
}

export function logAuth(message: string, meta?: Record<string, unknown>) {
  line('AUTH ', colors.magenta, message, meta)
}

export function formatRequest(method: string, url: string, statusCode: number, ms: number) {
  const color = statusCode >= 500 ? colors.red : statusCode >= 400 ? colors.yellow : colors.green
  return `${method.padEnd(6)} ${url} ${color}${statusCode}${colors.reset} ${colors.dim}${ms.toFixed(1)}ms${colors.reset}`
}
