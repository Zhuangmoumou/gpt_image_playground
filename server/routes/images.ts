import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../auth'
import { getImageForUser, imageUrl, saveImageDataUrl } from '../storage/images'

export async function imageRoutes(app: FastifyInstance) {
  app.post('/api/images', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    try {
      const body = request.body as { dataUrl?: unknown; source?: unknown }
      if (typeof body?.dataUrl !== 'string') return reply.code(400).send({ error: '缺少图片数据' })
      const source = body.source === 'generated' || body.source === 'mask' ? body.source : 'upload'
      const image = saveImageDataUrl(user.id, body.dataUrl, source)
      return { image: { id: image.id, url: imageUrl(image.id), createdAt: image.created_at, source: image.source } }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/images/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const image = getImageForUser(user.id, id)
    if (!image) return reply.code(404).send({ error: '图片不存在' })

    reply.header('Content-Type', image.mime_type)
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    return reply.send(fs.createReadStream(image.storage_path))
  })
}
