import { describe, expect, it } from 'vitest'
import { chatErrorToastText, humanizeErrorCode } from '../errorMessages'

describe('humanizeErrorCode', () => {
  it('maps runtime unavailable to human copy', () => {
    expect(humanizeErrorCode('RUNTIME_ERROR')).toContain('沙盒未就绪')
    expect(humanizeErrorCode('MCP_STREAM_UNAVAILABLE')).toContain('Docker')
  })

  it('maps approval terminal states', () => {
    expect(humanizeErrorCode('APPROVAL_REJECTED')).toContain('取消')
    expect(humanizeErrorCode('APPROVAL_EXPIRED')).toContain('过期')
  })

  it('keeps unknown codes visible', () => {
    expect(humanizeErrorCode('SOMETHING', 'boom')).toContain('SOMETHING')
    expect(chatErrorToastText('RUNTIME_ERROR')).toContain('RUNTIME_ERROR')
    expect(chatErrorToastText('RUNTIME_ERROR')).toContain('沙盒')
  })
})
