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
import { registerSecurityHooks } from './security'

const app = Fastify({
  logger: false,
  bodyLimit: config.maxUploadMb * 1024 * 1024,
})

function timestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

app.addHook('onResponse', async (request, reply) => {
  console.log(`[${timestamp()}] ${request.method} ${request.url} -> ${reply.statusCode}`)
})

app.addHook('onError', async (request, reply, error) => {
  console.error(`[${timestamp()}] ${request.method} ${request.url} 出错：${error.message}`)
})

await app.register(cookie, { secret: config.sessionSecret })
await registerSecurityHooks(app)
await app.register(configRoutes)
await app.register(authRoutes)
await app.register(imageRoutes)
await app.register(settingsRoutes)
await app.register(taskRoutes)
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
  console.log(`[${timestamp()}] 服务已启动：http://${config.host}:${config.port}`)
  console.log(`[${timestamp()}] 数据目录：${config.dataDir}`)
} catch (err) {
  console.error(`[${timestamp()}] 服务启动失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
