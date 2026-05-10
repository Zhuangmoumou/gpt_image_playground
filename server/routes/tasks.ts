import type { FastifyInstance } from 'fastify'
import type { TaskRecord } from '../../src/types'
import { requireUser } from '../auth'
import { db } from '../db/client'
import { getTaskForUser, listTasks, upsertTask } from '../lib/tasks'
import { deleteUnreferencedImages, getImageForUser } from '../storage/images'

function collectTaskImageIds(task: Pick<TaskRecord, 'inputImageIds' | 'maskImageId' | 'maskTargetImageId' | 'outputImages'>) {
  return [
    ...(task.inputImageIds ?? []),
    ...(task.maskTargetImageId ? [task.maskTargetImageId] : []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages ?? []),
  ]
}

function assertTaskImagesBelongToUser(userId: string, task: TaskRecord) {
  for (const imageId of collectTaskImageIds(task)) {
    if (!getImageForUser(userId, imageId)) throw new Error('任务引用了不存在的图片')
  }
}

function isSafeId(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{5,79}$/i.test(value)
}

function assertTaskShape(task: TaskRecord) {
  if (!isSafeId(task?.id)) throw new Error('无效的任务 ID')
  if (typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 20_000) {
    throw new Error('无效的提示词')
  }
  if (!task.params || typeof task.params !== 'object') throw new Error('无效的任务参数')
  if (!['running', 'done', 'error'].includes(task.status)) throw new Error('无效的任务状态')
  if (!Number.isFinite(task.createdAt) || task.createdAt <= 0) throw new Error('无效的创建时间')
  if (!Array.isArray(task.inputImageIds) || task.inputImageIds.length > 16 || !task.inputImageIds.every(isSafeId)) {
    throw new Error('无效的输入图片列表')
  }
  if (task.maskTargetImageId != null && !isSafeId(task.maskTargetImageId)) throw new Error('无效的遮罩目标图片')
  if (task.maskImageId != null && !isSafeId(task.maskImageId)) throw new Error('无效的遮罩图片')
  if (!Array.isArray(task.outputImages) || task.outputImages.length > 32 || !task.outputImages.every(isSafeId)) {
    throw new Error('无效的输出图片列表')
  }
}

export async function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return { tasks: listTasks(user.id) }
  })

  app.post('/api/tasks', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    try {
      const task = request.body as TaskRecord
      if (!task?.id || !task.prompt || !task.params || !task.status) return reply.code(400).send({ error: '无效的任务数据' })
      assertTaskShape(task)
      assertTaskImagesBelongToUser(user.id, task)
      const saved = upsertTask(user.id, task)
      return { task: saved }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/tasks/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const existing = getTaskForUser(user.id, id)
    if (!existing) return reply.code(404).send({ error: '任务不存在' })

    try {
      const patch = request.body as Partial<TaskRecord>
      const next = { ...existing, ...patch, id: existing.id }
      assertTaskShape(next)
      assertTaskImagesBelongToUser(user.id, next)
      const saved = upsertTask(user.id, next)
      return { task: saved }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/tasks/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const task = getTaskForUser(user.id, id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })

    const imageIds = collectTaskImageIds(task)
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, user.id)
    deleteUnreferencedImages(user.id, imageIds)
    return { ok: true }
  })

  app.post('/api/tasks/delete', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { ids?: unknown }
    if (!Array.isArray(body?.ids)) return reply.code(400).send({ error: '缺少任务 ID' })
    const allImageIds: string[] = []
    for (const id of body.ids) {
      if (typeof id !== 'string') continue
      const task = getTaskForUser(user.id, id)
      if (!task) continue
      allImageIds.push(...collectTaskImageIds(task))
      db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, user.id)
    }
    deleteUnreferencedImages(user.id, allImageIds)
    return { ok: true }
  })

  app.delete('/api/tasks', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const tasks = listTasks(user.id)
    const imageIds = tasks.flatMap(collectTaskImageIds)
    db.prepare('DELETE FROM tasks WHERE user_id = ?').run(user.id)
    deleteUnreferencedImages(user.id, imageIds)
    return { ok: true }
  })
}
