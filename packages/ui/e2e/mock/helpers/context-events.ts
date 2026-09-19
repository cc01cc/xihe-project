import type { Page } from "@playwright/test";

export async function installContextEventStream(page: Page): Promise<void> {
    await page.addInitScript(() => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const encode = (value: string) => new TextEncoder().encode(value);
        const event = (name: string, data: unknown) =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        (window as unknown as Record<string, unknown>).__pushContextEvent = (
            name: string,
            data: unknown,
        ) => {
            controller?.enqueue(encode(event(name, data)));
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.url;
            if (url.includes("/api/v1/events")) {
                const body = new ReadableStream<Uint8Array>({
                    start(next) {
                        controller = next;
                        next.enqueue(encode("retry: 1000\n\n"));
                    },
                    cancel() {
                        controller = null;
                    },
                });
                return new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            return originalFetch(input, init);
        };
    });
}

export async function pushContextEvent(page: Page, name: string, data: unknown): Promise<void> {
    await page.evaluate(
        ([eventName, payload]) => {
            (window as unknown as Record<string, unknown>).__pushContextEvent!(eventName, payload);
        },
        [name, data] as const,
    );
}
