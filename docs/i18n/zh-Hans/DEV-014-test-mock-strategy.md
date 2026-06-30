# DEV-014: 测试 Mock 策略约束

单元测试 mock 不能掩盖集成层 bug：

| 原则 | 说明 |
|------|------|
| **验证 body 格式** | mock `fetch` 时，不仅验证 `method: 'POST'`，还要验证 `Content-Type` 和 body 结构 |
| **验证端点路径** | mock URL 要与 Vite proxy rewrite 后的实际路径一致 |
| **不用 `console.warn` 替代错误** | catch 块必须有用户可见的反馈（Toast），不能只 `console.warn` |
| **dynamic import 改 static** | 测试文件中 `await import()` 改为顶层 `import`，避免模块加载竞争导致 flaky |
| **jsdom 限制** | `Image.onload`、`canvas.toBlob` 在 jsdom 中不可靠，需要 mock |
