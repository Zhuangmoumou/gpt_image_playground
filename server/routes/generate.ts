import type { FastifyInstance } from 'fastify'
import type { AppSettings, TaskParams } from '../../src/types'
import { requireUser } from '../auth'
import { callServerImageApi } from '../lib/generate'
import { getTaskForUser, upsertTask } from '../lib/tasks'
import { getUnknownErrorMessage } from '../../src/lib/imageApiShared'
import { fileToDataUrl, getImageForUser, saveImageDataUrl } from '../storage/images'
import { config } from '../config'

export async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { taskId?: unknown; settings?: AppSettings }
    if (typeof body?.taskId !== 'string' || !body.settings) return reply.code(400).send({ error: '缺少生成参数' })

    const task = getTaskForUser(user.id, body.taskId)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    if (task.status !== 'running') return { task }

    try {
      const inputImageDataUrls = task.inputImageIds.map((imageId) => {
        const image = getImageForUser(user.id, imageId)
        if (!image) throw new Error('输入图片已不存在')
        return fileToDataUrl(image)
      })
      const maskDataUrl = task.maskImageId
        ? (() => {
            const image = getImageForUser(user.id, task.maskImageId!)
            if (!image) throw new Error('遮罩图片已不存在')
            return fileToDataUrl(image)
          })()
        : undefined

      const result = await callServerImageApi({
        settings: body.settings,
        prompt: task.prompt,
        params: task.params,
        inputImageDataUrls,
        maskDataUrl,
        onFalRequestEnqueued: (requestInfo) => {
          upsertTask(user.id, {
            ...task,
            falRequestId: requestInfo.requestId,
            falEndpoint: requestInfo.endpoint,
            falRecoverable: false,
          })
        },
      })

      const outputImages = result.images.map((dataUrl) => saveImageDataUrl(user.id, dataUrl, 'generated').id)
      const shouldStoreApiResponseMetadata = task.apiProvider !== 'fal'
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

      const saved = upsertTask(user.id, {
        ...task,
        outputImages,
        actualParams: shouldStoreApiResponseMetadata ? { ...result.actualParams, n: outputImages.length } : undefined,
        actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length ? actualParamsByImage : undefined,
        revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
        status: 'done',
        error: null,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
        falRecoverable: false,
      })
      return { task: saved }
    } catch (err) {
      const errorMessage = getUnknownErrorMessage(err)
      const publicError = config.exposeErrorDetail ? errorMessage : '生成失败，请查看服务端日志'
      const saved = upsertTask(user.id, {
        ...task,
        status: 'error',
        error: publicError,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
        falRecoverable: false,
      })
      return reply.code(500).send({
        error: saved?.error ?? publicError,
        ...(config.exposeErrorDetail ? { detail: errorMessage } : {}),
        task: saved,
      })
    }
  })
}
