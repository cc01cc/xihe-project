import { describe, it, expect } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { useStreamParser } from '../useStreamParser'

function mountStreamParser() {
  const TestComponent = defineComponent({
    setup() {
      const parser = useStreamParser()
      return { parser }
    },
    template: '<div />',
  })
  const wrapper = mount(TestComponent)
  return wrapper
}

describe('useStreamParser', () => {
  it('routes reasoning hint to reasoning part', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('思考内容', 'reasoning')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({ type: 'reasoning', content: '思考内容' })
  })

  it('routes text hint to text part', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Hello', 'text')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Hello' })
  })

  it('merges consecutive reasoning tokens with hint', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('思考A', 'reasoning')
    handleToken('思考B', 'reasoning')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({ type: 'reasoning', content: '思考A思考B' })
  })

  it('merges consecutive text tokens with hint', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Hello ', 'text')
    handleToken('world', 'text')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Hello world' })
  })

  it('handles interleaved reasoning and text by hint', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Answer: ', 'text')
    handleToken('thinking deeply', 'reasoning')
    handleToken(' done', 'text')
    finalize()
    expect(parts.value).toHaveLength(3)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Answer: ' })
    expect(parts.value[1]).toEqual({ type: 'reasoning', content: 'thinking deeply' })
    expect(parts.value[2]).toEqual({ type: 'text', content: ' done' })
  })

  it('extracts think block without hint', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Before <think>思考内容</think> After')
    finalize()
    expect(parts.value).toHaveLength(3)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Before ' })
    expect(parts.value[1]).toEqual({ type: 'reasoning', content: '思考内容' })
    expect(parts.value[2]).toEqual({ type: 'text', content: ' After' })
  })

  it('handles unclosed think block without hint', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts } = wrapper.vm.parser
    handleToken('Before <think>未关闭')
    expect(parts.value).toHaveLength(2)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Before ' })
    expect(parts.value[1]).toEqual({ type: 'reasoning', content: '未关闭' })
  })

  it('closes unclosed think on finalize and falls back to text', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Before <think>未关闭')
    finalize()
    expect(parts.value).toHaveLength(2)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Before ' })
    expect(parts.value[1]).toEqual({ type: 'reasoning', content: '未关闭' })
  })

  it('extracts citation markers', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Some text [1] and [42] more')
    finalize()
    expect(parts.value.length).toBeGreaterThanOrEqual(3)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Some text ' })
    expect(parts.value[1]).toEqual({ type: 'citation', index: 1 })
    expect(parts.value[parts.value.length - 1]).toEqual({ type: 'text', content: ' more' })
  })

  it('extracts artifact block', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('text <artifact identifier="a1" type="code" title="test">code content</artifact> after')
    finalize()
    expect(parts.value).toHaveLength(3)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'text ' })
    expect(parts.value[1]).toEqual({
      type: 'artifact',
      identifier: 'a1',
      artifactType: 'code',
      title: 'test',
      content: 'code content',
    })
    expect(parts.value[2]).toEqual({ type: 'text', content: ' after' })
  })

  it('handles streaming artifact block', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('<artifact identifier="a1" type="text" title="doc">')
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0].type).toBe('artifact')
    expect((parts.value[0] as { content: string }).content).toBe('')
    handleToken('streaming ')
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0].type).toBe('artifact')
    handleToken('content')
    handleToken('</artifact>')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({
      type: 'artifact',
      identifier: 'a1',
      artifactType: 'text',
      title: 'doc',
      content: 'streaming content',
    })
  })

  it('handles mixed think and artifact', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('<think>推理</think>正文<artifact identifier="a1" type="code" title="x">代码</artifact>')
    finalize()
    expect(parts.value).toHaveLength(3)
    expect(parts.value[0]).toEqual({ type: 'reasoning', content: '推理' })
    expect(parts.value[1]).toEqual({ type: 'text', content: '正文' })
    expect(parts.value[2].type).toBe('artifact')
  })

  it('handles empty input', () => {
    const wrapper = mountStreamParser()
    const { parts, finalize } = wrapper.vm.parser
    finalize()
    expect(parts.value).toHaveLength(0)
  })

  it('handles plain text without any tags', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, finalize } = wrapper.vm.parser
    handleToken('Just some plain text')
    finalize()
    expect(parts.value).toHaveLength(1)
    expect(parts.value[0]).toEqual({ type: 'text', content: 'Just some plain text' })
  })

  it('resets state correctly', () => {
    const wrapper = mountStreamParser()
    const { handleToken, parts, reset } = wrapper.vm.parser
    handleToken('Hello', 'text')
    expect(parts.value).toHaveLength(1)
    reset()
    expect(parts.value).toHaveLength(0)
  })
})
