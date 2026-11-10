# 字体许可与来源声明

本目录的字体文件是 **Noto Sans SC** 的**子集**（只含产品实际用到的码点），由
`internal/A03-xihe/scripts/build-font-subset.mjs` 从本机安装的 `NotoSansSC-VF.ttf` 生成。

| 项 | 值（取自字体 `name` 表，[实测]） |
| --- | --- |
| 字体族 | Noto Sans SC |
| 版本 | `Version 2.04;241114210130;non-release` |
| 版权 | `© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.` |
| 商标 | `Source is a trademark of Adobe in the United States and/or other countries.` |
| 设计者 | Ryoko NISHIZUKA 西塚涼子（kana/bopomofo/ideographs）; Paul D. Hunt（Latin/Greek/Cyrillic）; Sandoll Communications（hangul） |
| 许可 | **SIL Open Font License, Version 1.1**（`name` 表 ID 13 原文；官方文本 <http://scripts.sil.org/OFL>） |
| 许可 URL | <http://scripts.sil.org/OFL> |

## 对 OFL 1.1 的合规说明

1. **可再分发与嵌入**：OFL 1.1 允许随软件分发、嵌入与修改（子集化属于修改）。
2. **保留字体名**：原字体保留名是 `Source`；本子集**未改字体族名**（仍叫 `Noto Sans SC`），因此不涉及使用保留名的情形。
3. **不单独售卖字体**：本子集只随本产品分发，不作为独立字体商品。
4. **同许可分发**：若单独分发本目录的字体文件，须同样以 OFL 1.1 分发并附带本声明。
5. **版权与许可声明保留在字体文件内**：`build-font-subset.mjs` 带 `--name-IDs=*` ⇒ 子集保留了
   `name` 表的 ID 0（版权）、13（许可描述）、14（许可 URL），实测可用 `fontTools` 读回（见决策稿 §复现）。

## 产物

| 文件 | 内容 |
| --- | --- |
| `noto-sans-sc-cjk.woff2` | 中文/全角片（含汉字、CJK 标点、全角形式） |
| `noto-sans-sc-latin.woff2` | Latin 片（基本拉丁 + Latin-1 + 常用标点/箭头/几何符号） |
| `noto-sans-sc.charset.json` | 旁证：真正打进字体的码点表 + 每个产物的 sha256 + 源字体 sha256（`check-font-subset.mjs` 消费） |

> 源字体本身（16.95 MB 的 `NotoSansSC-VF.ttf`）**不入库**：体积大、且系统已装；子集产物入库存档（约 328 KB）。
