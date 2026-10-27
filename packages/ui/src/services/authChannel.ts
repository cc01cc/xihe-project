const CHANNEL_NAME = "xihe-auth";
const STORAGE_EVENT_KEY = "xihe-auth-logout";

type RemoteLogout = () => void;

let channel: BroadcastChannel | null = null;
let listener: RemoteLogout | null = null;
let installed = false;

function ensureChannel(): BroadcastChannel | null {
    if (channel) return channel;
    if (typeof BroadcastChannel === "undefined") return null;
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "logout") listener?.();
    };
    return channel;
}

/** Install once per tab; `onLogout` must not broadcast back (loop guard). */
export function onRemoteLogout(onLogout: RemoteLogout): void {
    listener = onLogout;
    ensureChannel();
    if (installed) return;
    installed = true;
    window.addEventListener("storage", (event) => {
        if (event.key === STORAGE_EVENT_KEY && event.newValue) listener?.();
    });
}

export function broadcastLogout(): void {
    const target = ensureChannel();
    if (target) {
        target.postMessage({ type: "logout" });
        return;
    }
    // Fallback for environments without BroadcastChannel: a storage event is
    // delivered to the other tabs (never to the writer).
    try {
        localStorage.setItem(STORAGE_EVENT_KEY, String(Date.now()));
        localStorage.removeItem(STORAGE_EVENT_KEY);
    } catch {
        // No cross-tab channel available; the next 401 still terminates the tab.
    }
}
