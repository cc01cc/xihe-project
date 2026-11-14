#!/usr/bin/env node
/**
 * 图像差异仪器：逐像素对比 PNG，并用「差异集 ⊆ 噪声集」判定跨改动差异是否可忽略。
 *
 * 为什么不是阈值判据：图像基线不能一律用逐字节相同做对照 —— 2026-11-15 实测（task-54 control
 * 对照）同一版截图脚本连跑两次，06 号图也不一样：2–3 个像素、每通道 Δ=1、占比 1e-6 量级。
 * 而「Δ ≤ 1 LSB 即通过」会放过一类真实错误：换了坐标但差 1 LSB。所以判据换成集合关系：
 *
 *   ① 噪声基线 = 同一版本连跑 N 次得到的差异「坐标集合」（--noise 产出）；
 *   ② 跨改动判定 = 候选图与基线图的差异集逐坐标包含于噪声集，且同坐标的每通道差值不超过
 *      噪声基线在该坐标的量级（--subset，exit 0/1）。
 *
 * 用法：
 *   node scripts/pngdiff.mjs diff <a.png> <b.png>
 *   node scripts/pngdiff.mjs noise <out.json> <reference.png> <run2.png> [run3.png ...]
 *   node scripts/pngdiff.mjs --subset <noise.json> <candidate.png>
 *   node scripts/pngdiff.mjs --selftest
 *
 * 退出码：0 通过 / 1 不通过 / 2 用法或输入错误。
 *
 * 零第三方依赖：解码与编码只用 Node 内建 node:zlib + node:crypto（D-1448）。
 *
 * 支持范围（够用即止，超出显式报错而不是猜）：位深 8、非隔行、colorType 0(灰度)/2(RGB)/6(RGBA)。
 * 16 位、调色板、隔行一律 exit 2 —— 猜错颜色空间会让判定本身变成噪声。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 与 ui-mock-shot 的 sha256_16 同口径：sha256 十六进制前 16 位，便于和 manifest 那列对照。 */
export function sha256_16(buffer) {
    return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function readChunks(buffer) {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("不是 PNG（签名不匹配）");
    }
    const chunks = [];
    let pos = 8;
    while (pos + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(pos);
        const type = buffer.toString("ascii", pos + 4, pos + 8);
        chunks.push({ type, data: buffer.subarray(pos + 8, pos + 8 + length) });
        pos += 12 + length;
        if (type === "IEND") break;
    }
    return chunks;
}

/** 解码 PNG 成 { width, height, channels, pixels }（pixels 为已解滤波的裸字节）。 */
export function decodePng(buffer) {
    const chunks = readChunks(buffer);
    const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
    if (!ihdr) throw new Error("缺少 IHDR");
    const width = ihdr.data.readUInt32BE(0);
    const height = ihdr.data.readUInt32BE(4);
    const bitDepth = ihdr.data[8];
    const colorType = ihdr.data[9];
    const interlace = ihdr.data[12];
    if (bitDepth !== 8) throw new Error("不支持的位深 " + bitDepth + "（只支持 8）");
    if (interlace !== 0) throw new Error("不支持隔行（interlace=" + interlace + "）");
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) throw new Error("不支持的 colorType " + colorType + "（支持 0/2/6）");
    const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
    if (idat.length === 0) throw new Error("缺少 IDAT");
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);
    let cursor = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = raw[cursor];
        cursor += 1;
        const line = raw.subarray(cursor, cursor + stride);
        cursor += stride;
        const row = pixels.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x += 1) {
            const left = x >= channels ? row[x - channels] : 0;
            const up = prev ? prev[x] : 0;
            const upLeft = prev && x >= channels ? prev[x - channels] : 0;
            let value = line[x];
            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += Math.floor((left + up) / 2);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            } else if (filter !== 0) {
                throw new Error("未知滤波类型 " + filter);
            }
            row[x] = value & 0xff;
        }
    }
    return { width, height, channels, pixels };
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        crc ^= buffer[index];
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** 编码 PNG（只服务 --selftest 的合成数据；实际比对只解码）。 */
export function encodePng({ width, height, channels, pixels }) {
    const stride = width * channels;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([length, body, crc]);
    };
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** 逐像素差异；pixels = [x, y, 最大通道Δ] 三元组，判据用它做集合运算。 */
export function diffImages(a, b) {
    if (a.width !== b.width || a.height !== b.height) {
        throw new Error(
            "尺寸不同: " + a.width + "x" + a.height + " vs " + b.width + "x" + b.height,
        );
    }
    const channels = Math.min(a.channels, b.channels);
    const pixels = [];
    let maxChannelDelta = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < a.height; y += 1) {
        for (let x = 0; x < a.width; x += 1) {
            const ai = (y * a.width + x) * a.channels;
            const bi = (y * b.width + x) * b.channels;
            let delta = 0;
            for (let c = 0; c < channels; c += 1) {
                const d = Math.abs(b.pixels[bi + c] - a.pixels[ai + c]);
                if (d > delta) delta = d;
            }
            if (delta === 0) continue;
            pixels.push([x, y, delta]);
            if (delta > maxChannelDelta) maxChannelDelta = delta;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    const total = a.width * a.height;
    return {
        size: { width: a.width, height: a.height },
        channels,
        diffPixels: pixels.length,
        ratio: total === 0 ? 0 : pixels.length / total,
        maxChannelDelta,
        bbox: pixels.length === 0 ? null : { x0, y0, x1, y1 },
        pixels,
    };
}

/** 噪声清单：reference 与每个 run 的差异并集（同坐标取最大 Δ）。 */
export function buildNoise(reference, runs) {
    const merged = new Map();
    let maxChannelDelta = 0;
    for (const run of runs) {
        const report = diffImages(reference.image, run.image);
        for (const [x, y, delta] of report.pixels) {
            const key = x + "," + y;
            const previous = merged.get(key);
            if (!previous || delta > previous[2]) merged.set(key, [x, y, delta]);
            if (delta > maxChannelDelta) maxChannelDelta = delta;
        }
    }
    return {
        version: 1,
        size: { width: reference.image.width, height: reference.image.height },
        channels: reference.image.channels,
        reference: {
            path: reference.path,
            sha256_16: reference.sha256_16,
        },
        runs: runs.map((run) => ({ path: run.path, sha256_16: run.sha256_16 })),
        maxChannelDelta,
        pixels: [...merged.values()],
    };
}

/**
 * 判定：候选图相对 reference 的差异集是否逐坐标包含于噪声集，且同坐标 Δ 不超过噪声量级。
 * verdict = 'subset' 即通过；'outside-noise' 时 offending 逐条给出坐标与原因。
 */
export function judgeSubset(noise, referenceImage, candidateImage) {
    const report = diffImages(referenceImage, candidateImage);
    const noiseAt = new Map(noise.pixels.map(([x, y, delta]) => [x + "," + y, delta]));
    const offending = [];
    for (const [x, y, delta] of report.pixels) {
        const allowed = noiseAt.get(x + "," + y);
        if (allowed === undefined)
            offending.push({ x, y, delta, reason: "coordinate-not-in-noise" });
        else if (delta > allowed)
            offending.push({ x, y, delta, allowed, reason: "delta-exceeds-noise" });
    }
    return {
        verdict: offending.length === 0 ? "subset" : "outside-noise",
        criterion: "diff-set-subset-of-noise-set",
        reference: noise.reference,
        size: report.size,
        diffPixels: report.diffPixels,
        noisePixels: noise.pixels.length,
        maxChannelDelta: report.maxChannelDelta,
        noiseMaxChannelDelta: noise.maxChannelDelta,
        offendingCount: offending.length,
        offending: offending.slice(0, 50),
    };
}

function loadImage(file) {
    const buffer = fs.readFileSync(file);
    return { path: file, image: decodePng(buffer), sha256_16: sha256_16(buffer) };
}

function print(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function usage() {
    process.stderr.write(
        [
            "用法:",
            "  node scripts/pngdiff.mjs diff <a.png> <b.png>",
            "  node scripts/pngdiff.mjs noise <out.json> <reference.png> <run2.png> [run3.png ...]",
            "  node scripts/pngdiff.mjs --subset <noise.json> <candidate.png>",
            "  node scripts/pngdiff.mjs --selftest",
            "",
            "退出码: 0 通过 / 1 不通过 / 2 用法或输入错误",
            "",
        ].join("\n"),
    );
    process.exit(EXIT_USAGE);
}

export function main(argv) {
    const [command, ...rest] = argv;
    if (!command || command === "--help" || command === "-h") usage();
    if (command === "diff") {
        if (rest.length !== 2) usage();
        const [left, right] = rest.map(loadImage);
        print({
            kind: "diff",
            left: left.path,
            right: right.path,
            sha_left: left.sha256_16,
            sha_right: right.sha256_16,
            ...diffImages(left.image, right.image),
        });
        return EXIT_PASS;
    }
    if (command === "noise") {
        if (rest.length < 3) usage();
        const [out, referencePath, ...runPaths] = rest;
        const reference = loadImage(referencePath);
        const runs = runPaths.map(loadImage);
        const noise = buildNoise(reference, runs);
        fs.writeFileSync(out, JSON.stringify(noise, null, 2) + "\n", "utf8");
        print({
            kind: "noise",
            out,
            reference: noise.reference,
            runs: runs.length,
            noisePixels: noise.pixels.length,
            maxChannelDelta: noise.maxChannelDelta,
            pixels: noise.pixels,
        });
        return EXIT_PASS;
    }
    if (command === "--subset") {
        if (rest.length !== 2) usage();
        const [noisePath, candidatePath] = rest;
        const noise = JSON.parse(fs.readFileSync(noisePath, "utf8"));
        if (noise.version !== 1) {
            process.stderr.write("[pngdiff] 不支持的噪声清单版本 " + noise.version + "\n");
            return EXIT_USAGE;
        }
        const referencePath = path.isAbsolute(noise.reference.path)
            ? noise.reference.path
            : path.resolve(path.dirname(path.resolve(noisePath)), noise.reference.path);
        if (!fs.existsSync(referencePath)) {
            process.stderr.write(
                "[pngdiff] 噪声清单里的 reference 不存在: " + referencePath + "\n",
            );
            return EXIT_USAGE;
        }
        const reference = loadImage(referencePath);
        const candidate = loadImage(candidatePath);
        const verdict = judgeSubset(noise, reference.image, candidate.image);
        print({
            kind: "subset",
            noise: noisePath,
            reference: referencePath,
            candidate: candidatePath,
            candidateSha: candidate.sha256_16,
            ...verdict,
        });
        return verdict.verdict === "subset" ? EXIT_PASS : EXIT_FAIL;
    }
    if (command === "--selftest") return selftest();
    usage();
    return EXIT_USAGE;
}

/** 合成一张 w×h 图：确定性渐变 + 可选点位改写（用来造「同 Δ、不同坐标」这类样例）。 */
export function syntheticImage(width, height, channels, tweaks = []) {
    const pixels = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * channels;
            for (let c = 0; c < channels; c += 1)
                pixels[offset + c] = (x * 7 + y * 13 + c * 29) % 256;
        }
    }
    for (const tweak of tweaks) {
        const offset = (tweak.y * width + tweak.x) * channels;
        for (let c = 0; c < channels; c += 1) {
            pixels[offset + c] = (pixels[offset + c] + tweak.delta) % 256;
        }
    }
    return { width, height, channels, pixels };
}

function runCli(args) {
    const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "pngdiff.mjs"), ...args],
        {
            encoding: "utf8",
            windowsHide: true,
        },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 自检：全部用合成数据（不依赖任何外部 fixture），覆盖「仪器本身会不会骗人」。
 * 其中最要紧的一条是第 ⑥ 例：同 Δ=1 但换坐标必须判不通过 —— 阈值判据会放过它。
 */
function selftest() {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? "" });
    const tmpDir = fs.mkdtempSync(
        path.join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "pngdiff-selftest-"),
    );
    const writePng = (name, image) => {
        const file = path.join(tmpDir, name);
        fs.writeFileSync(file, encodePng(image));
        return file;
    };

    for (const channels of [3, 4]) {
        const image = syntheticImage(9, 7, channels);
        const roundtrip = decodePng(encodePng(image));
        check(
            "编解码往返通道=" + channels,
            roundtrip.width === image.width &&
                roundtrip.height === image.height &&
                roundtrip.channels === channels &&
                roundtrip.pixels.equals(image.pixels),
            "",
        );
    }

    const base = syntheticImage(8, 8, 3);
    check("相同图 diffPixels=0", diffImages(base, base).diffPixels === 0, "");

    const twoPixels = syntheticImage(8, 8, 3, [
        { x: 2, y: 3, delta: 1 },
        { x: 5, y: 6, delta: 1 },
    ]);
    const report = diffImages(base, twoPixels);
    check(
        "两处 Δ=1 ⇒ 2 像素且 maxChannelDelta=1",
        report.diffPixels === 2 && report.maxChannelDelta === 1,
        JSON.stringify(report.pixels),
    );

    const runA = syntheticImage(8, 8, 3, [{ x: 2, y: 3, delta: 1 }]);
    const runB = syntheticImage(8, 8, 3, [{ x: 5, y: 6, delta: 1 }]);
    const fileBase = writePng("base.png", base);
    const noise = buildNoise(loadImage(fileBase), [
        { path: writePng("runA.png", runA), image: runA, sha256_16: "runA" },
        { path: writePng("runB.png", runB), image: runB, sha256_16: "runB" },
    ]);
    check(
        "噪声基线 = 多次 run 的差异并集（2 个坐标）",
        noise.pixels.length === 2 && noise.maxChannelDelta === 1,
        JSON.stringify(noise.pixels),
    );

    const inside = judgeSubset(noise, base, twoPixels);
    check(
        "差异集 ⊆ 噪声集 ⇒ verdict=subset",
        inside.verdict === "subset",
        JSON.stringify(inside.offending),
    );

    const displacedImage = syntheticImage(8, 8, 3, [{ x: 7, y: 0, delta: 1 }]);
    const displaced = judgeSubset(noise, base, displacedImage);
    check(
        "同 Δ=1 但换坐标 ⇒ outside-noise（阈值判据会放过它）",
        displaced.verdict === "outside-noise" && displaced.offending.length === 1,
        JSON.stringify(displaced.offending),
    );

    const louderImage = syntheticImage(8, 8, 3, [{ x: 2, y: 3, delta: 3 }]);
    const louder = judgeSubset(noise, base, louderImage);
    check(
        "同坐标 Δ=3 > 噪声 Δ=1 ⇒ delta-exceeds-noise",
        louder.verdict === "outside-noise" && louder.offending[0]?.reason === "delta-exceeds-noise",
        JSON.stringify(louder.offending),
    );

    const palette = Buffer.from(
        encodePng({ width: 2, height: 2, channels: 3, pixels: Buffer.alloc(12) }),
    );
    palette[25] = 3;
    let paletteError = null;
    try {
        decodePng(palette);
    } catch (error) {
        paletteError = error;
    }
    check(
        "调色板 PNG ⇒ 显式报错（不猜颜色空间）",
        paletteError !== null,
        String(paletteError?.message ?? ""),
    );

    const noisePath = path.join(tmpDir, "noise.json");
    fs.writeFileSync(noisePath, JSON.stringify(noise, null, 2), "utf8");
    const cliInside = runCli(["--subset", noisePath, writePng("candidate-inside.png", twoPixels)]);
    const cliDisplaced = runCli([
        "--subset",
        noisePath,
        writePng("candidate-displaced.png", displacedImage),
    ]);
    const cliLouder = runCli([
        "--subset",
        noisePath,
        writePng("candidate-louder.png", louderImage),
    ]);
    check("CLI --subset 通过分支 exit=0", cliInside.status === 0, "exit=" + cliInside.status);
    check("CLI --subset 换坐标 exit=1", cliDisplaced.status === 1, "exit=" + cliDisplaced.status);
    check("CLI --subset 同坐标更大 Δ exit=1", cliLouder.status === 1, "exit=" + cliLouder.status);
    const missingRef = path.join(tmpDir, "noise-missing-ref.json");
    fs.writeFileSync(
        missingRef,
        JSON.stringify({
            ...noise,
            reference: { path: path.join(tmpDir, "nope.png"), sha256_16: "x" },
        }),
        "utf8",
    );
    const cliMissing = runCli([
        "--subset",
        missingRef,
        writePng("candidate-inside.png", twoPixels),
    ]);
    check(
        "reference 缺失 ⇒ exit=2（输入错误不是判定不通过）",
        cliMissing.status === 2,
        "exit=" + cliMissing.status,
    );
    const cliUsage = runCli(["--nonsense"]);
    check("未知子命令 ⇒ exit=2", cliUsage.status === 2, "exit=" + cliUsage.status);

    for (const item of checks) {
        process.stdout.write(
            (item.ok ? "PASS  " : "FAIL  ") +
                item.name +
                (item.detail ? "  (" + item.detail + ")" : "") +
                "\n",
        );
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const failed = checks.filter((item) => !item.ok);
    if (failed.length > 0) {
        process.stderr.write("[pngdiff] 自检失败 " + failed.length + "/" + checks.length + "\n");
        return EXIT_FAIL;
    }
    process.stdout.write("[pngdiff] 自检通过 " + checks.length + "/" + checks.length + "\n");
    return EXIT_PASS;
}

if (import.meta.url === "file:///" + process.argv[1].replace(/\\/g, "/")) {
    process.exit(main(process.argv.slice(2)));
}
