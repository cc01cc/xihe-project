/**
 * task-105 · `vite.config.ts` 的 `checkedMountPlugin` 提供的虚拟模块，运行期无 vue-i18n 依赖。
 * 声明在这里是为了让 `vue-tsc` 认这个 specifier（构建期由插件 `load()` 注入键清单）。
 */
declare module "virtual:xihe-i18n-keys" {
    const keys: string[];
    export default keys;
}
