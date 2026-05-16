import type { FastifyInstance } from 'fastify'
import type { AppSettings, TaskParams, TaskRecord } from '../../src/types'
import { requireUser } from '../auth'
import { callServerImageApi } from '../lib/generate'
import { getTaskForUser, upsertTask } from '../lib/tasks'
import { getUnknownErrorMessage } from '../../src/lib/imageApiShared'
import { replaceImageMentionsForApi } from '../../src/lib/promptImageMentions'
import { fileToDataUrl, getImageForUser, saveImageDataUrl } from '../storage/images'
import { config } from '../config'

const runningServerTaskIds = new Set<string>()

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

async function runServerGeneration(app: FastifyInstance, userId: string, taskId: string, settings: AppSettings) {
  try {
    const task = getTaskForUser(userId, taskId)
    if (!task || task.status !== 'running') return

    const inputImageDataUrls = task.inputImageIds.map((imageId) => {
      const image = getImageForUser(userId, imageId)
      if (!image) throw new Error('输入图片已不存在')
      return fileToDataUrl(image)
    })
    const maskDataUrl = task.maskImageId
      ? (() => {
          const image = getImageForUser(userId, task.maskImageId!)
          if (!image) throw new Error('遮罩图片已不存在')
          return fileToDataUrl(image)
        })()
      : undefined

    const result = await callServerImageApi({
      settings,
      prompt: replaceImageMentionsForApi(task.prompt, inputImageDataUrls.length),
      params: task.params,
      inputImageDataUrls,
      maskDataUrl,
      onFalRequestEnqueued: (requestInfo) => {
        const current = getTaskForUser(userId, taskId)
        if (!current || current.status !== 'running') return
        upsertTask(userId, {
          ...current,
          falRequestId: requestInfo.requestId,
          falEndpoint: requestInfo.endpoint,
          falRecoverable: false,
        })
      },
    })

    const current = getTaskForUser(userId, taskId)
    if (!current || current.status !== 'running') return

    const outputImages = result.images.map((dataUrl) => saveImageDataUrl(userId, dataUrl, 'generated').id)
    const shouldStoreApiResponseMetadata = current.apiProvider !== 'fal'
    const actualParamsByImage = shouldStoreApiResponseMetadata ? result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
      const imageId = outputImages[index]
      if (imageId && params && Object.keys(params).length > 0) acc[imageId] = params
      return acc
    }, {}) : undefined
    const revisedPromptByImage = shouldStoreApiResponseMetadata ? result.revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
      const imageId = outputImages[index]
      if (imageId && prompt?.trim()) acc[imageId] = prompt
      return acc
    }, {}) : undefined

    upsertTask(userId, {
      ...current,
      outputImages,
      actualParams: shouldStoreApiResponseMetadata ? { ...result.actualParams, n: outputImages.length } : undefined,
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
      rawImageUrls: result.rawImageUrls,
      status: 'done',
      error: null,
      finishedAt: Date.now(),
      elapsed: Date.now() - current.createdAt,
      falRecoverable: false,
    })
  } catch (err) {
    const current = getTaskForUser(userId, taskId)
    if (!current || current.status !== 'running') return

    const errorMessage = getUnknownErrorMessage(err)
    const publicError = config.exposeErrorDetail ? errorMessage : '生成失败，请查看服务端日志'
    upsertTask(userId, {
      ...current,
      status: 'error',
      error: publicError,
      ...getRawErrorPayload(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - current.createdAt,
      falRecoverable: false,
    })
    app.log.error({ err, taskId }, 'server-side generation failed')
  } finally {
    runningServerTaskIds.delete(taskId)
  }
}

export async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { taskId?: unknown; settings?: AppSettings }
    if (typeof body?.taskId !== 'string' || !body.settings) return reply.code(400).send({ error: '缺少生成参数' })

    const task = getTaskForUser(user.id, body.taskId)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    if (task.status !== 'running') return { task }

    const queued = upsertTask(user.id, { ...task, serverSideRequest: true }) ?? { ...task, serverSideRequest: true }
    if (!runningServerTaskIds.has(task.id)) {
      runningServerTaskIds.add(task.id)
      setImmediate(() => {
        void runServerGeneration(app, user.id, task.id, body.settings!)
      })
    }

    return reply.code(202).send({ task: queued })
  })
}
