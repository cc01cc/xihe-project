import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, markRaw } from 'vue'
import InputToolbar from '../../components/chat/InputToolbar.vue'

const LeftComponent = defineComponent({
  name: 'LeftComponent',
  template: '<button class="left-action">Left</button>',
})

const RightComponent = defineComponent({
  name: 'RightComponent',
  template: '<button class="right-action">Right</button>',
})

const HiddenComponent = defineComponent({
  name: 'HiddenComponent',
  template: '<button>Hidden</button>',
})

const IconComponent = defineComponent({
  name: 'IconComponent',
  template: '<svg>Icon</svg>',
})

describe('InputToolbar', () => {
  it('renders left and right actions', () => {
    const wrapper = mount(InputToolbar, {
      props: {
        actions: [
          { key: 'left', position: 'left', component: markRaw(LeftComponent) },
          { key: 'right', position: 'right', component: markRaw(RightComponent) },
        ],
      },
    })

    expect(wrapper.text()).toContain('Left')
    expect(wrapper.text()).toContain('Right')
  })

  it('hides actions when visible returns false', () => {
    const wrapper = mount(InputToolbar, {
      props: {
        actions: [
          { key: 'visible', position: 'left', component: markRaw(LeftComponent) },
          { key: 'hidden', position: 'left', component: markRaw(HiddenComponent), visible: false },
        ],
      },
    })

    expect(wrapper.text()).toContain('Left')
    expect(wrapper.text()).not.toContain('Hidden')
  })

  it('passes props to dynamic action components', async () => {
    const onClick = vi.fn()
    const wrapper = mount(InputToolbar, {
      props: {
        actions: [
          {
            key: 'clickable',
            position: 'right',
            component: 'button',
            props: { class: 'custom-btn', onClick },
            icon: markRaw(IconComponent),
          },
        ],
      },
    })

    const btn = wrapper.find('button.custom-btn')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(onClick).toHaveBeenCalled()
  })
})
