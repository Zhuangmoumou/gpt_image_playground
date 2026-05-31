import { describe, expect, it } from 'vitest'
import type { ResponsesOutputItem } from '../types'
import { getPersistableResponseOutputItem, getPersistableTask } from './taskPayloadSanitizer'

describe('taskPayloadSanitizer', () => {
  it('removes string image generation results from response output items', () => {
    expect(getPersistableResponseOutputItem({
      type: 'image_generation_call',
      id: 'img_1',
      result: 'large-base64',
      size: '1024x1024',
    })).toEqual({
      type: 'image_generation_call',
      id: 'img_1',
      size: '1024x1024',
    })
  })

  it('removes base64 image fields while keeping other result metadata', () => {
    const item = {
      type: 'image_generation_call',
      id: 'img_1',
      result: {
        b64_json: 'large-base64',
        base64: 'large-base64-2',
        image: 'large-base64-3',
        data: 'large-base64-4',
        seed: '1234',
      },
    } as unknown as ResponsesOutputItem

    expect(getPersistableResponseOutputItem(item)).toEqual({
      type: 'image_generation_call',
      id: 'img_1',
      result: { seed: '1234' },
    })
  })

  it('sanitizes rawResponsePayload on task records', () => {
    const task = {
      id: 'task_1',
      rawResponsePayload: JSON.stringify({
        id: 'resp_1',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
          { type: 'image_generation_call', id: 'img_1', result: { b64_json: 'large-base64' }, size: '1024x1024' },
        ],
      }),
    }

    const sanitized = getPersistableTask(task)
    expect(sanitized.rawResponsePayload).not.toContain('large-base64')
    expect(JSON.parse(sanitized.rawResponsePayload as string)).toEqual({
      id: 'resp_1',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
        { type: 'image_generation_call', id: 'img_1', size: '1024x1024' },
      ],
    })
  })
})
