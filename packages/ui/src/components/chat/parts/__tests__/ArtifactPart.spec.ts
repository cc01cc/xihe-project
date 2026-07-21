import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ArtifactPart from '../ArtifactPart.vue'

describe('ArtifactPart', () => {
  it('renders artifact with identifier and content', () => {
    const wrapper = mount(ArtifactPart, {
      props: {
        part: { type: 'artifact', identifier: 'a1', artifactType: 'code', title: 'test', content: 'code content' },
      },
    })
    expect(wrapper.text()).toContain('a1')
    expect(wrapper.text()).toContain('code content')
  })

  it('renders artifact without identifier', () => {
    const wrapper = mount(ArtifactPart, {
      props: {
        part: { type: 'artifact', identifier: '', artifactType: 'text', title: '', content: 'plain' },
      },
    })
    expect(wrapper.text()).toContain('Artifact')
    expect(wrapper.text()).toContain('plain')
  })
})
