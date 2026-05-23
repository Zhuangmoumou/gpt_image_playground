import fs from 'node:fs'
import path from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { config } from './config'
import './db/client'
import { authRoutes } from './routes/auth'
import { configRoutes } from './routes/config'
import { generateRoutes } from './routes/generate'
import { imageRoutes } from './routes/images'
import { settingsRoutes } from './routes/settings'
import { taskRoutes } from './routes/tasks'
import { agentRoutes } from './routes/agent'
import { registerSecurityHooks } from './security'

const app = Fastify({
  logger: false,
  bodyLimit: config.maxUploadMb * 1024 * 1024,
})

const useColor = Boolean(process.stdout.isTTY)
const color = {
  dim: useColor ? '\x1b[2m' : '',
  blue: useColor ? '\x1b[34m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  reset: useColor ? '\x1b[0m' : '',
}

function timestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
  const levelColor = level === 'ERROR' ? color.red : level === 'WARN' ? color.yellow : color.cyan
  const output = `${color.dim}[${timestamp()}]${color.reset} ${levelColor}${level}${color.reset} ${message}`
  if (level === 'ERROR') {
    console.error(output)
    return
  }
  console.log(output)
}

app.addHook('onResponse', async (request, reply) => {
  const statusColor = reply.statusCode >= 500
    ? color.red
    : reply.statusCode >= 400
      ? color.yellow
      : color.green
  log('INFO', `${color.blue}${request.method}${color.reset} ${request.url} -> ${statusColor}${reply.statusCode}${color.reset}`)
})

app.addHook('onError', async (request, reply, error) => {
  log('ERROR', `${color.blue}${request.method}${color.reset} ${request.url} 出错：${error.message}`)
})

await app.register(cookie, { secret: config.sessionSecret })
await registerSecurityHooks(app)
await app.register(configRoutes)
await app.register(authRoutes)
await app.register(imageRoutes)
await app.register(settingsRoutes)
await app.register(taskRoutes)
await app.register(agentRoutes)
await app.register(generateRoutes)

const distDir = path.resolve(process.cwd(), 'dist')
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
  })
}

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
  if (fs.existsSync(distDir)) return reply.sendFile('index.html')
  return reply.code(404).send({ error: '前端构建产物不存在，请运行 npm run build:client' })
})

try {
  await app.listen({ host: config.host, port: config.port })
  log('INFO', `服务已启动：${color.green}http://${config.host}:${config.port}${color.reset}`)
  log('INFO', `数据目录：${color.green}${config.dataDir}${color.reset}`)
} catch (err) {
  log('ERROR', `服务启动失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
