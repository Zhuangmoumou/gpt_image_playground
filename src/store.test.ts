import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
vi.mock('./lib/serverApi', async () => {
  const actual = await vi.importActual<typeof import('./lib/serverApi')>('./lib/serverApi')
  return {
    ...actual,
    saveUserSettings: vi.fn(async (settings, params) => ({ settings, params })),
    generateServerTask: vi.fn(),
    getServerTask: vi.fn(),
    saveServerTask: vi.fn(async (task) => ({ task })),
    patchServerTask: vi.fn(async (id, patch) => ({ task: { id, ...patch } })),
    uploadServerImage: vi.fn(async (_dataUrl: string, source = 'upload') => ({
      image: { id: `${source}-image`, url: `/api/images/${source}-image`, createdAt: 1, source },
    })),
  }
})

vi.mock('./lib/api', () => ({
  callImageApi: vi.fn(),
}))

vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})
import { clearImages, putImage } from './lib/db'
import { callImageApi } from './lib/api'
import { generateServerTask, getServerTask, patchServerTask, saveServerTask, saveUserSettings, uploadServerImage } from './lib/serverApi'
import { editOutputs, getPersistedState, getTaskApiProfile, markInterruptedOpenAIRunningTasks, reuseConfig, submitTask, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const serverSideRunning = task({ id: 'server-running', apiProvider: 'openai', serverSideRequest: true, status: 'running', createdAt: 5_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, serverSideRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'server-running')).toEqual(serverSideRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: 'prompt',
      inputImages: [imageA],
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('user settings server save queue', () => {
  const mockedSaveUserSettings = vi.mocked(saveUserSettings)

  beforeEach(async () => {
    mockedSaveUserSettings.mockReset()
    mockedSaveUserSettings.mockImplementation(async (settings, params) => ({ settings, params }))
    useStore.setState({
      authUser: { id: 'user-a', username: 'user-a' },
      settings: normalizeSettings(DEFAULT_SETTINGS),
      params: { ...DEFAULT_PARAMS },
      showToast: vi.fn(),
    })
    await flushPromises()
  })

  it('saves settings changes for logged-in users', async () => {
    useStore.getState().setSettings({ apiKey: 'server-key' })

    await flushPromises()

    expect(mockedSaveUserSettings).toHaveBeenCalledTimes(1)
    expect(mockedSaveUserSettings).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'server-key' }), expect.any(Object))
  })

  it('serializes rapid changes and saves the latest snapshot', async () => {
    const firstSave = createDeferred<Awaited<ReturnType<typeof saveUserSettings>>>()
    mockedSaveUserSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementation(async (settings, params) => ({ settings, params }))

    useStore.getState().setSettings({ apiKey: 'first-key' })
    useStore.getState().setSettings({ apiKey: 'latest-key' })
    useStore.getState().setParams({ n: 2 })

    expect(mockedSaveUserSettings).toHaveBeenCalledTimes(1)

    firstSave.resolve({ settings: normalizeSettings(DEFAULT_SETTINGS), params: { ...DEFAULT_PARAMS } })
    await flushPromises()

    expect(mockedSaveUserSettings).toHaveBeenCalledTimes(2)
    expect(mockedSaveUserSettings.mock.calls[1][0]).toMatchObject({ apiKey: 'latest-key' })
    expect(mockedSaveUserSettings.mock.calls[1][1]).toMatchObject({ n: 2 })
  })

  it('shows an error toast when saving settings fails', async () => {
    const showToast = vi.fn()
    const error = Object.assign(new Error('Unauthorized'), { status: 401 })
    mockedSaveUserSettings.mockRejectedValueOnce(error)
    useStore.setState({ showToast })

    useStore.getState().setSettings({ apiKey: 'unsaved-key' })
    await flushPromises()

    expect(showToast).toHaveBeenCalledWith('登录已失效，设置未保存', 'error')
  })
})

describe('task request execution mode', () => {
  const mockedCallImageApi = vi.mocked(callImageApi)
  const mockedGenerateServerTask = vi.mocked(generateServerTask)
  const mockedGetServerTask = vi.mocked(getServerTask)
  const mockedSaveServerTask = vi.mocked(saveServerTask)
  const mockedUploadServerImage = vi.mocked(uploadServerImage)
  const mockedPatchServerTask = vi.mocked(patchServerTask)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockedSaveServerTask.mockImplementation(async (task) => ({ task }))
    mockedUploadServerImage.mockImplementation(async (_dataUrl: string, source = 'upload') => ({
      image: { id: `${source}-image`, url: `/api/images/${source}-image`, createdAt: 1, source },
    }))
    mockedPatchServerTask.mockImplementation(async (id, patch) => ({ task: { id, ...patch } as TaskRecord }))
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'test-key' })],
        activeProfileId: 'openai-profile',
      }),
      prompt: '生成一只猫',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      authUser: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the server generation endpoint and polls when server-side requests are enabled', async () => {
    mockedGenerateServerTask.mockImplementation(async (taskId) => {
      const current = useStore.getState().tasks.find((item) => item.id === taskId)
      return {
        task: {
          ...current!,
          serverSideRequest: true,
          status: 'running',
          error: null,
          finishedAt: null,
          elapsed: null,
        },
      }
    })
    mockedGetServerTask
      .mockImplementationOnce(async (taskId) => {
        const current = useStore.getState().tasks.find((item) => item.id === taskId)
        const { serverSideRequest: _serverSideRequest, ...taskWithoutServerFlag } = current!
        return {
          task: {
            ...taskWithoutServerFlag,
            status: 'running',
            error: null,
            finishedAt: null,
            elapsed: null,
          },
        }
      })
      .mockImplementationOnce(async (taskId) => {
        const current = useStore.getState().tasks.find((item) => item.id === taskId)
        return {
          task: {
            ...current!,
            outputImages: ['server-output'],
            status: 'done',
            error: null,
            finishedAt: 2,
            elapsed: 1,
          },
        }
      })

    await submitTask()
    await flushPromises()

    expect(mockedGenerateServerTask).toHaveBeenCalledTimes(1)
    expect(mockedCallImageApi).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0]).toMatchObject({ status: 'running', serverSideRequest: true })

    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()

    expect(mockedGetServerTask).toHaveBeenCalledTimes(1)
    expect(mockedGetServerTask).toHaveBeenLastCalledWith(expect.any(String), { poll: true })
    expect(useStore.getState().tasks[0]).toMatchObject({ status: 'running', serverSideRequest: true })

    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()

    expect(mockedGetServerTask).toHaveBeenCalledTimes(2)
    expect(useStore.getState().tasks[0]).toMatchObject({ status: 'done', outputImages: ['server-output'] })
  })

  it('shows backend generation errors returned by polling', async () => {
    mockedGenerateServerTask.mockImplementation(async (taskId) => {
      const current = useStore.getState().tasks.find((item) => item.id === taskId)
      return {
        task: {
          ...current!,
          serverSideRequest: true,
          status: 'running',
          error: null,
          finishedAt: null,
          elapsed: null,
        },
      }
    })
    mockedGetServerTask.mockImplementation(async (taskId) => {
      const current = useStore.getState().tasks.find((item) => item.id === taskId)
      return {
        task: {
          ...current!,
          status: 'error',
          error: '上游接口失败',
          finishedAt: 2,
          elapsed: 1,
        },
      }
    })

    await submitTask()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()

    const task = useStore.getState().tasks[0]
    expect(task).toMatchObject({ status: 'error', error: '上游接口失败' })
    expect(useStore.getState().detailTaskId).toBe(task.id)
  })

  it('uses client direct requests when server-side requests are disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'test-key', useServerSideRequests: false })],
        activeProfileId: 'openai-profile',
      }),
    })
    mockedCallImageApi.mockResolvedValue({
      images: ['data:image/png;base64,out'],
      actualParams: { size: '1024x1024' },
      revisedPrompts: ['revised prompt'],
      rawImageUrls: ['https://example.com/out.png'],
    })

    await submitTask()
    await flushPromises()

    expect(mockedGenerateServerTask).not.toHaveBeenCalled()
    expect(mockedCallImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '生成一只猫',
      inputImageDataUrls: [],
      maskDataUrl: undefined,
    }))
    expect(mockedUploadServerImage).toHaveBeenCalledWith('data:image/png;base64,out', 'generated')
    expect(useStore.getState().tasks[0]).toMatchObject({
      status: 'done',
      outputImages: ['generated-image'],
      rawImageUrls: ['https://example.com/out.png'],
    })
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})
