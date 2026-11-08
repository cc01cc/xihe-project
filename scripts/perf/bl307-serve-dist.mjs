#!/usr/bin/env node
/**
 * BL-307 — 生产 bundle 复测用的静态服务 + CP 反代（测量工具，不改产品代码）。
 *
 * 生产 `vite build` 产物是相对 `/api/v1/...` 的；`vite preview` 默认不代理，
 * 所以这里用零依赖 Node http 服务：静态 dist + `/api` 透明反代（含 SSE 流式 pipe）。
 *
 * 用法：
 *   node scripts/perf/bl307-serve-dist.mjs --dist packages/ui/dist --cp http://127.0.0.1:27412 --port 27511
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argValue = (name, fallback = null) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1) return process.argv[index + 1];
    const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return inline === undefined ? fallback : inline.slice(name.length + 3);
};

const A03 = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = resolve(argValue('dist', join(A03, 'packages/ui/dist')));
const CP = argValue('cp');
const PORT = Number(argValue('port', '27511'));
if (!CP) throw new Error('--cp http://127.0.0.1:<port> is required');
const cpUrl = new URL(CP);

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((incoming, response) => {
    if (incoming.url === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('ok');
        return;
    }
    if (incoming.url.startsWith('/api/')) {
        // 透明反代：保留 method/headers/body；响应流式 pipe（SSE 不缓冲）。
        const headers = { ...incoming.headers, host: `${cpUrl.hostname}:${cpUrl.port}` };
        const upstream = httpRequest({
            protocol: cpUrl.protocol,
            hostname: cpUrl.hostname,
            port: cpUrl.port,
            path: incoming.url,
            method: incoming.method,
            headers,
        }, (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        });
        upstream.on('error', (error) => {
            response.writeHead(502, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ code: 'PROXY_UPSTREAM_ERROR', detail: String(error).slice(0, 200) }));
        });
        incoming.pipe(upstream);
        return;
    }
    // 静态文件 + SPA fallback（无扩展名路径 → index.html）
    const pathname = decodeURIComponent((incoming.url ?? '/').split('?')[0]);
    const normalized = normalize(pathname).replace(/^([/\\])+/, '');
    let file = join(DIST, normalized);
    const isAsset = extname(file) !== '';
    if (!isAsset || !existsSync(file) || !statSync(file).isFile()) {
        file = join(DIST, 'index.html');
    }
    if (!existsSync(file)) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('dist not built');
        return;
    }
    response.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ok] dist=${DIST} proxy=/api -> ${CP} listen=http://127.0.0.1:${PORT}`);
});
