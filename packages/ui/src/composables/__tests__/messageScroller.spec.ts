import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'

const TestApp = {
  components: {
    MessageScrollerProvider,
    MessageScroller,
    MessageScrollerViewport,
    MessageScrollerContent,
    MessageScrollerItem,
  },
  props: {
    itemCount: {
      type: Number,
      default: 0,
    },
  },
  template: `
    <MessageScrollerProvider :auto-scroll="true">
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem
              v-for="index in itemCount"
              :key="index"
              :message-id="'msg-' + (index - 1)"
            >
              <div>Message {{ index - 1 }}</div>
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  `,
}

describe('MessageScrollerProvider', () => {
  it('renders nested message scroller components', async () => {
    const wrapper = mount(TestApp, { props: { itemCount: 3 } })

    await nextTick()

    expect(wrapper.find('[data-slot="message-scroller"]').exists()).toBe(true)
    expect(wrapper.find('[data-slot="message-scroller-viewport"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-slot="message-scroller-item"]').length).toBe(3)
  })

  it('registers message items with data-message-id', async () => {
    const wrapper = mount(TestApp, { props: { itemCount: 2 } })

    await nextTick()

    const items = wrapper.findAll('[data-slot="message-scroller-item"]')

    expect(items[0].attributes('data-message-id')).toBe('msg-0')
    expect(items[1].attributes('data-message-id')).toBe('msg-1')
  })
})

vi.stubGlobal('ResizeObserver', class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
})
