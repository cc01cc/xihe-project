import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { logger } from './lib/logger'
import { setCustomComponents, setKaTeXWorker } from 'markstream-vue'
import MarkstreamCodeBlockAdapter from './components/chat/MarkstreamCodeBlockAdapter.vue'
import './styles/main.css'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const app = createApp(App)
app.use(pinia)
app.use(router)
app.use(i18n)
app.mount('#app')

setCustomComponents('xihe', { code_block: MarkstreamCodeBlockAdapter })

async function initKaTeXWorker() {
  try {
    const KaTeXWorker = await import(
      /* webpackChunkName: "katex-worker" */
      'markstream-vue/workers/katexRenderer.worker?worker'
    )
    setKaTeXWorker(new KaTeXWorker.default())
  } catch {
    // KaTeX Worker is optional — falls back to synchronous rendering
  }
}
initKaTeXWorker()

window.addEventListener('beforeunload', () => logger.flush())
