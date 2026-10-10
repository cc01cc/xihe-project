import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

const messages = { "zh-CN": { multimodal: { voice: "语音" } } };
function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

describe("VoiceInput", () => {
    class MockSpeechRecognition extends EventTarget implements SpeechRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        start = vi.fn<SpeechRecognition["start"]>();
        stop = vi.fn<SpeechRecognition["stop"]>();
        abort = vi.fn<SpeechRecognition["abort"]>();
        onresult: SpeechRecognition["onresult"] = null;
        onerror: SpeechRecognition["onerror"] = null;
        onend: SpeechRecognition["onend"] = null;
    }

    beforeEach(() => {
        window.SpeechRecognition = MockSpeechRecognition;
    });

    it("renders voice input button", async () => {
        const { default: VoiceInput } = await import("../../components/multimodal/VoiceInput.vue"),
            wrapper = mount(VoiceInput, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.find("button").exists()).toBe(true);
    });
});
