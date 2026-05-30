import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { serverApi } from './serverApi'
import { callFalAiImageApi } from './falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (opts.settings.serverRequestMode) {
    if (profile.provider === 'fal') {
      throw new Error('服务端发出请求暂时仅支持 OpenAI 兼容接口；请关闭该选项或切换到 OpenAI 兼容配置。')
    }
    return serverApi<CallApiResult>('/api/generation/images', {
      method: 'POST',
      body: JSON.stringify({
        settings: opts.settings,
        prompt: opts.prompt,
        params: opts.params,
        inputImageDataUrls: opts.inputImageDataUrls,
        maskDataUrl: opts.maskDataUrl,
      }),
    })
  }

  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
