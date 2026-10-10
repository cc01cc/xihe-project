import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import PdfPageCanvas from "../../components/chat/PdfPageCanvas.vue";
import type {
    getDocument,
    PDFDocumentProxy,
    PDFPageProxy,
    PageViewport,
    RenderTask,
} from "pdfjs-dist";

vi.mock("pdfjs-dist", () => ({
    default: {
        GlobalWorkerOptions: { workerSrc: "" },
        getDocument: vi.fn<typeof getDocument>(() => ({
            promise: Promise.resolve({
                numPages: 5,
                getPage: vi.fn<PDFDocumentProxy["getPage"]>(() =>
                    Promise.resolve({
                        getViewport: vi.fn<PDFPageProxy["getViewport"]>(
                            ({ scale }) =>
                                ({
                                    width: Math.round(612 * scale),
                                    height: Math.round(792 * scale),
                                }) as PageViewport,
                        ),
                        render: vi.fn<PDFPageProxy["render"]>(
                            ({ canvasContext: _canvasContext, viewport: _viewport }) =>
                                ({
                                    promise: Promise.resolve(),
                                    cancel: vi.fn<RenderTask["cancel"]>(),
                                }) as RenderTask,
                        ),
                    } as PDFPageProxy),
                ),
            }),
        })),
    },
}));

describe("PdfPageCanvas", () => {
    it("renders container div", () => {
        const wrapper = mount(PdfPageCanvas, {
            props: { pdfDoc: null, pageNum: 1, scale: 1.0 },
        });
        expect(wrapper.find("div").exists()).toBe(true);
    });

    it("accepts pageNum and scale props", () => {
        const wrapper = mount(PdfPageCanvas, {
            props: { pdfDoc: null, pageNum: 3, scale: 1.5 },
        });
        expect(wrapper.props("pageNum")).toBe(3);
        expect(wrapper.props("scale")).toBe(1.5);
    });
});
