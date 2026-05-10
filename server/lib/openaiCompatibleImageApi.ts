import type { ApiProfile, ImageApiResponse, ResponsesApiResponse, TaskParams } from '../../src/types'
import {
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getUnknownErrorMessage,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
  readJsonIgnoringHeartbeats,
  type CallApiOptions,
  type CallApiResult,
} from '../../src/lib/imageApiShared'

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

function createRequestHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
}

function buildApiUrl(baseUrl: string, apiPath: string) {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'
  const normalizedPath = apiPath.replace(/^\/+/, '')
  return normalizedBase.endsWith('/v1') ? `${normalizedBase}/${normalizedPath}` : `${normalizedBase}/v1/${normalizedPath}`
}

async function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png') {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: fallbackType })
}

function createResponsesImageTool(params: TaskParams, isEdit: boolean, profile: ApiProfile, maskDataUrl?: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
  }
  if (!profile.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl }
  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImageDataUrls.map((imageUrl) => ({ type: 'input_image', image_url: imageUrl })),
    ],
  }]
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string) {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) throw new Error('接口未返回图片数据')
  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []
  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue
    if (typeof item.result === 'string' && item.result.trim()) {
      results.push({
        image: normalizeBase64Image(item.result, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }
  if (!results.length) throw new Error('接口未返回可用图片数据')
  return results
}

export async function callOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  return profile.apiMode === 'responses' ? callResponsesImageApi(opts, profile) : callImagesApi(opts, profile)
}

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (profile.codexCli && n > 1) {
    const singleOpts = { ...opts, params: { ...opts.params, n: 1, quality: 'auto' as const } }
    const results = await Promise.all(Array.from({ length: n }).map(() => callImagesApiSingle(singleOpts, profile)))
    const images = results.flatMap((result) => result.images)
    return {
      images,
      actualParams: mergeActualParams(results[0]?.actualParams, { n: images.length }),
      actualParamsList: results.flatMap((result) => result.actualParamsList ?? result.images.map(() => result.actualParams)),
      revisedPrompts: results.flatMap((result) => result.revisedPrompts ?? result.images.map(() => undefined)),
    }
  }
  return callImagesApiSingle(opts, profile)
}

async function callImagesApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${originalPrompt}` : originalPrompt
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  let requestUrl = ''

  try {
    let response: Response
    if (isEdit) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)
      if (!profile.codexCli) formData.append('quality', params.quality)
      if (params.output_format !== 'png' && params.output_compression != null) formData.append('output_compression', String(params.output_compression))
      if (params.n > 1) formData.append('n', String(params.n))

      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const blob = await dataUrlToBlob(inputImageDataUrls[i])
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }
      if (opts.maskDataUrl) formData.append('mask', await dataUrlToBlob(opts.maskDataUrl, 'image/png'), 'mask.png')

      requestUrl = buildApiUrl(profile.baseUrl, 'images/edits')
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: createRequestHeaders(profile),
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        size: params.size,
        output_format: params.output_format,
        moderation: params.moderation,
      }
      if (!profile.codexCli) body.quality = params.quality
      if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
      if (params.n > 1) body.n = params.n

      requestUrl = buildApiUrl(profile.baseUrl, 'images/generations')
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: { ...createRequestHeaders(profile), 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await readJsonIgnoringHeartbeats(response) as ImageApiResponse
    const results = await Promise.all((payload.data ?? []).map(async (item) => {
      const image = item.b64_json
        ? normalizeBase64Image(item.b64_json, mime)
        : item.url && isHttpUrl(item.url)
          ? await fetchImageUrlAsDataUrl(item.url, mime, controller.signal)
          : null
      if (!image) return null
      return {
        image,
        actualParams: mergeActualParams(pickActualParams(payload), pickActualParams(item)),
        revisedPrompt: item.revised_prompt,
      }
    }))
    const filtered = results.filter((item): item is NonNullable<typeof item> => Boolean(item))
    if (!filtered.length) throw new Error('接口未返回图片数据')
    return {
      images: filtered.map((item) => item.image),
      actualParams: mergeActualParams(pickActualParams(payload), { n: filtered.length }),
      actualParamsList: filtered.map((item) => item.actualParams),
      revisedPrompts: filtered.map((item) => item.revisedPrompt),
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error(`请求超时：超过 ${profile.timeout} 秒仍未完成\nURL: ${requestUrl}`)
    if (err instanceof Error && (err.message.startsWith('HTTP ') || err.message.startsWith('接口返回的 JSON 无法解析'))) throw err
    throw new Error(`请求图像接口失败\nURL: ${requestUrl || profile.baseUrl}\n错误：${getUnknownErrorMessage(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const requestUrl = buildApiUrl(profile.baseUrl, 'responses')
  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { ...createRequestHeaders(profile), 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        model: profile.model,
        input: createResponsesInput(opts.prompt, opts.inputImageDataUrls),
        tools: [createResponsesImageTool(opts.params, opts.inputImageDataUrls.length > 0, profile, opts.maskDataUrl)],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await readJsonIgnoringHeartbeats(response) as ResponsesApiResponse
    const results = parseResponsesImageResults(payload, mime)
    return {
      images: results.map((item) => item.image),
      actualParams: mergeActualParams(...results.map((item) => item.actualParams), { n: results.length }),
      actualParamsList: results.map((item) => item.actualParams),
      revisedPrompts: results.map((item) => item.revisedPrompt),
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error(`请求超时：超过 ${profile.timeout} 秒仍未完成\nURL: ${requestUrl}`)
    if (err instanceof Error && (err.message.startsWith('HTTP ') || err.message.startsWith('接口返回的 JSON 无法解析'))) throw err
    throw new Error(`请求图像接口失败\nURL: ${requestUrl}\n错误：${getUnknownErrorMessage(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }
}
