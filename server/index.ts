import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import { config } from './config.js'
import { runMigrations } from './db.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSyncRoutes } from './routes/sync.js'
import { registerGenerationRoutes } from './routes/generation.js'
import { formatRequest, logError, logInfo, logOk, logWarn } from './logger.js'

runMigrations()
mkdirSync(config.storageDir, { recursive: true })

const app = Fastify({ logger: false, bodyLimit: config.maxUploadMb * 1024 * 1024 })

app.register(fastifyCookie)

app.addHook('onRequest', async (request) => {
  request.startTime = performance.now()
})

app.addHook('onResponse', async (request, reply) => {
  const elapsed = performance.now() - (request.startTime ?? performance.now())
  const statusCode = reply.statusCode
  const message = formatRequest(request.method, request.url, statusCode, elapsed)
  if (statusCode >= 500) logError(message)
  else if (statusCode >= 400) logWarn(message)
  else logOk(message)
})

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    reply.code(400).send({ error: '请求参数不正确', details: error.issues })
    return
  }

  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
  reply.code(statusCode).send({ error: statusCode >= 500 ? '服务器内部错误' : error.message })
})

app.get('/api/health', async () => ({ ok: true, version: process.env.npm_package_version ?? 'dev' }))

await registerAuthRoutes(app)
await registerSettingsRoutes(app)
await registerSyncRoutes(app)
await registerGenerationRoutes(app)

const distDir = resolve(process.cwd(), 'dist')
if (existsSync(distDir)) {
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store')
      }
    },
  })

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: '接口不存在' })
      return
    }
    reply.sendFile('index.html')
  })
} else {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: request.url.startsWith('/api/') ? '接口不存在' : '前端 dist 目录不存在，请先运行 npm run build' })
  })
}

await app.listen({ host: config.host, port: config.port })
logInfo(`服务已启动：http://${config.host}:${config.port}`)
logInfo(`数据库：${config.databasePath}`)
logInfo(`图片目录：${join(config.storageDir)}`)
logInfo(`Cookie Secure：${config.cookieSecure ? '开启' : '关闭'}`)
