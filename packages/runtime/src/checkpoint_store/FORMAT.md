# checkpoint store v1 格式规范

> **状态**：冻结（PLAN-0653 M0 / T0.2，2026-11-04）。实现必须服从本文件；格式变更只能走 §12 changelog + 向后兼容读 + 惰性重写。
> **来源**：spike `A03-xihe/.local/spike-checkpoint-store/DESIGN.md` §2–§3（2026-11-03，gitignored）；本文件是**产品冻结版**，与 spike 的差异集中在 §9（codec 由 zstd 改 deflate、新增 GC journal 与迁移字段）。
> **上位**：`plans/PLAN-0653-XH-self-hosted-checkpoint-store/design.md`（D53-03/D53-04/D53-08）；`.agents/skills/db-design-checklist` 不适用（非 SQL）。

## 1. 总则

- **目标**：内容寻址、崩溃安全、运行期零进程 spawn、去 git 依赖；元数据（root/run/principal/nestedRoots）原生落在 slice 记录里。
- **编码**：JSON 一律 UTF-8 **无 BOM** + LF；哈希 SHA-256 小写 hex；时间戳 epoch 毫秒（UTC），同时给 ISO-8601 便于人读。
- **不可变性**：blob 与 manifest 内容寻址后永不改写；**唯一可见性单元是 slice 记录**（manifest 先落盘，slice 后落盘；崩溃最多留不可见的孤儿 manifest）。
- **原子写**：所有最终文件先写 `<store>/tmp/` → `fsync` → `rename` 到目标路径；目标目录永不出现半文件。
- **版本**：`<store>/VERSION` 内容为 `xh-checkpoint-store/1` + LF；不匹配 ⇒ **fail-closed**（拒绝读写并报 `STORE_VERSION_MISMATCH`），不得静默降级。
- **路径**：store 根在打开时 `canonicalize`；Windows 下得到 `\\?\` 前缀，长路径（>260）因此可用。

## 2. 目录布局

```text
<store>/                            默认 <hostRoot>/.xihe-store
  VERSION                           "xh-checkpoint-store/1"
  lock                              跨进程独占锁（崩溃自动释放）
  objects/<aa>/<bb>/<sha256>        blob（aa/bb = hash 前 2/次 2 个 hex）
  manifests/<aa>/<bb>/<sha256>.json manifest
  slices/<rootId>/<epochMs>-<hash12>.json   slice 记录（可见性单元）
  index/stat/<rootId>.json          stat cache（capture 优化）
  gc/<epoch>.json                   GC journal
  tmp/                              临时文件；只从这里 rename 出去
```

- `rootId` 目录名：仅当 rootId 匹配 `[A-Za-z0-9._-]{1,64}` 时用原名；否则用 `h-<SHA-256(rootId) 前 16 位>`（记录内部仍保存原值）。安全例外：rootId 为 `.` 或 `..` 时即使匹配字符集也强制走 hashed 形式，避免路径逃逸。
- 分片规则：`objects/<hash[0..2]>/<hash[2..4]>/<hash>`；manifest 同理。

## 3. blob 文件

```text
offset 0   magic "XCS1"   4 bytes
offset 4   codec          1 byte    0=raw, 1=deflate(zlib), 2..=255 保留（v1 禁止写）
offset 5   raw_len        u64 LE
offset 13  payload        codec 编码后的字节
```

- `blob_hash = SHA-256(raw content)`，小写 hex；**文件名即哈希**，扩展名不参与语义。
- 压缩：`codec=1` 用 flate2 的 zlib 编码（默认级别 6）；`raw_len < 64` 或压缩后无收益（payload ≥ raw_len）时存 `codec=0`。
- **去重**：目标路径已存在即跳过（不重写、不重新压缩、不校验内容——由 fsck 兜底）。
- **原子写**：tmp → fsync 文件 → rename；capture 路径每个新 blob fsync（后续允许批量 fsync，但**slice 提交前所有引用 blob 必须已落盘**）。
- **读取三重校验**：codec 合法且受支持；解码长度 == `raw_len`；`SHA-256(payload 解码结果)` == 文件名。任一不符 ⇒ 拒绝（`BLOB_CORRUPT`，错误携带路径与期望哈希）。
- **读侧压缩比门**：`raw_len > payload_len * 4096` ⇒ 拒绝（`CompressionRatioTooHigh`），在创建解码器/分配内存之前判定。
- **写侧不变式**：writer 不得产出 reader 会拒收的 blob；zlib 结果若 `raw_len > compressed_len * 4096`，强制回落 raw（与 `<64 B` / 压缩无收益同一判定）。
- **说明**：合法 flate2/deflate 输出压缩比上限约 1032×，因此 4096× 回落是面向未来 codec/后端的防御门，不是当前 writer 的常规分支（当前 writer 不会产出会被读侧拒收的 blob）。

## 4. manifest 文件

canonical JSON（无多余空白，键序固定：`v`、`entries`、`merkle_root`、`total_bytes`）：

```json
{"v":1,"entries":[["src/main.rs","100644",1234,"<64 hex>"]],"merkle_root":"<64 hex>","total_bytes":1234}
```

- `entries` 元素：`[path, mode, size, blob_hash]`；按 `path` 的 **UTF-8 字节序严格升序**且唯一。
- **rename 语义（v1）**：**不做 rename 检测**；文件改名按 delete + add 表示。与 git 输出对拍时必须传 `--no-renames`，否则 git 的 `R100` 会造成假红。
- `path`：`/` 分隔、无空段、无 `..`、无 `\`、不以 `/` 开头；非 UTF-8 文件名由 walker 跳过并计入 warnings（不伪造）。
- `mode` ∈ {`100644`（普通）, `100755`（可执行）, `120000`（符号链接，blob 内容为 link target）}。
- `size`：普通/可执行文件的原始内容字节数；**symlink 的 `size` = link target 路径字符串的 UTF-8 字节长度，`blob_hash` = 该 target 字符串的 SHA-256**（不是目标文件内容长度）。
- **symlink 读取**：symlink entry 的 blob 内容就是 target 路径字符串本身；读 symlink 时**不解析、不跟随**目标文件（不得读取目标内容来补 size/hash）。
- `manifest_id = SHA-256(canonical bytes)`；相同内容 ⇒ 相同 id（跨时间/跨 root 复用）。
- **merkle**：叶子 `SHA-256(0x00 || path || 0x00 || mode || 0x00 || size_decimal || 0x00 || blob_hash_hex)`；内部 `SHA-256(0x01 || left || right)`（32 字节二进制拼接）；奇数节点上提；空 manifest root = 64 个 `0`。
- **读取严格校验**（任一失败即拒绝，**绝不按空 manifest 处理**）：JSON 可解析、`v==1`、entries 有序唯一、path/mode/size/hash 合法、`total_bytes == Σsize`、merkle 复算一致、文件字节 SHA-256 == manifest_id。

## 5. slice 记录

路径 `slices/<rootId>/<epochMs 13 位>-<manifest_id 前 12 位>.json`（字典序 ≈ 时间序）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | int | 固定 1 |
| `id` | string | `<epochMs>-<hash12>`，文件名同 |
| `parent` | string \| null | 同 root 的字典序前一个 slice（无则 null） |
| `root_id` | string | 逻辑根 id（workspace id 或 declared root id） |
| `run_id` / `principal_id` | string \| null | 捕获者上下文；迁移来的旧数据为 null |
| `captured_at_ms` / `captured_at` | int / string | UTC 毫秒 + ISO-8601 |
| `manifest` / `merkle_root` | string | manifest_id 与根哈希 |
| `entry_count` / `total_bytes` | int | 条目数与原始总字节 |
| `exclusion_patterns` | string[] | 生效的静态模式 + `gitignore:.gitignore` 形式条目 |
| `gitignore_files` | string[] | 实际生效的 `.gitignore` 相对路径 |
| `nested_roots` | object[] | `{path, head, branch, dirty, git_dir_kind}`；直接解析 `.git`（不调 git） |
| `stats` | object | `{scanned_files, hashed_files, hashed_bytes, cache_hits, blobs_new, blobs_dedup, reparse_skipped, non_utf8_skipped, suspects, warnings, duration_ms}` |
| `state` | string | `captured` \| `migrated` |
| `migrated_from` | string \| null | 迁移来源 ref 名（`refs/xihe/slices/<id>`） |

- **提交语义**：content 完整写入 + rename 完成后才算可见；`no_change` 时**不写 slice**，直接返回 tail id。
- **读取**：按 id 升序；校验 `manifest` 存在、merkle 与 manifest 一致、`entry_count/total_bytes` 与 manifest 相符；不符 ⇒ `SLICE_CORRUPT`。
- **迁移记录**：`state=migrated` 时缺失字段一律 null（不伪造 runId/principalId/nestedRoots）。

## 6. stat cache

`index/stat/<rootId>.json`：`{"v":1,"entries":{"<path>":{"hash":"<64 hex>","size":123,"mtime_ns":1793...,"file_id":"<opaque>"}}}`

- 仅 capture 优化：`size + mtime_ns + file_id` 与上次一致 ⇒ 复用 hash（不读内容）。
- `file_id`：Unix `dev:ino`，Windows `volume_serial:file_index`（`GetFileInformationByHandle`）。用于识别「同 size/mtime 但文件被替换」；旧 cache 无该字段时视为不命中（严格优先），仅在同平台无法取得身份时回退 size+mtime。
- **已知限制**：若平台/文件系统拿不到 `file_id`（或读取旧 v1 cache 无该字段且实现选择回退），仍存在 racy-clean 盲区：同一 size/mtime 窗口内改内容会漏检；与 git `last-index` 同级。测试覆盖 replacement 的 file_id 变化；同 inode 原地改内容 + 强制还原 mtime 的场景无法稳定构造，不做测试，v1 不做可疑窗口强制重哈希。
- cache 写入在 slice 提交**之后**；损坏/缺失只退化为全量哈希。

## 7. 锁与并发

- `<store>/lock`：跨进程独占（Windows `share_mode=0`；Unix `flock`）；进程崩溃由 OS 自动释放。lock 文件内容为 JSON `{pid, created_at_ms, process_start_token}`，**仅用于诊断**；OS 锁是唯一权威。判断 PID 复用必须比较 `process_start_token`（Windows=进程创建 FILETIME ticks；Linux=`/proc/<pid>/stat` starttime），不能只看 `pid`。
- v1：store 级锁串行化 capture/restore/GC/fsck；第二进程立即失败（`STORE_BUSY`，exit 4），**不排队不阻塞**。
- P2/P3 目标（本文件不冻结实现）：per-root 锁 + GC 全局锁，固定获取顺序 **root → global** 防死锁。

## 8. GC journal

`gc/<epochMs>.json`：

```json
{"v":1,"started_at_ms":1793,"grace_hours":24,"state":"planned",
 "reachable_slices":["<id>"],"reachable_manifests":["<id>"],"reachable_blobs":["<hash>"],
 "deleted":{"manifests":[],"blobs":[],"tmp":[]}}
```

- 顺序：锁内计算可达集（所有 store slice 引用闭包 + 活跃 restore 租约的 slice + grace 内新增对象）→ 写 `state=planned` journal → 删除（先 manifest 后 blob）→ 写 `state=done`。
- 崩溃恢复：重启后读 journal；`planned` ⇒ 重放删除（幂等，已删跳过）；`done` ⇒ 清理 journal。
- 判活期间任何读取/解析失败 ⇒ **中止 GC**（保留 journal，`state=aborted`），宁泄漏不误删。
- restore 租约：`.xhs-restore-inprogress`（JSON：`{pid, slice_id, started_at_ms}`）存在时，该 slice 全部对象视为可达。

## 9. 与 spike 格式的差异（产品化改动）

| 项 | spike（2026-11-03） | v1 产品 | 原因 |
|---|---|---|---|
| blob 压缩 | zstd level 3（codec 1） | **deflate/zlib**（codec 1），raw=0 | 不新增原生依赖（Lead 2026-11-04 裁定）；codec 2 保留给 zstd 以后单独批 |
| blob 文件名 | `<sha>.zst` | `<sha>` | 扩展名不参与语义 |
| slice 字段 | 见 DESIGN §3.3 | + `state` / `migrated_from` | 迁移与审计需要 |
| GC journal | 未实现 | 新增 §8 | 产品化并发/崩溃重放 |
| 锁 | store 级 | store 级（v1）；per-root 为后续 | 分阶段 |
| 目录名 | `<rootId>` 或 `h-<hash16>` | 同（规则写入 §2） | 冻结 |

> 压缩口径提醒：v1 用 deflate 后压缩比预期低于 spike 的 zstd（2.15–2.28×），体积可能比 git（zlib）持平或略差；P3 前以 V2/V7 判据实测为准，不在此处承诺数字。

### 9.1 与现状 git slice 的字段映射（迁移口径）

现状 slice = 影子库里的一个 ref + commit（`checkpoint.rs:39,45,733`）；v1 slice 记录要与它可逆映射：

| 现状（git 影子库） | v1 slice 记录 | 说明 |
|---|---|---|
| ref `refs/xihe/slices/<epochMs>-<commitHash>` | `id` = `<epochMs>-<manifest_id 前 12>` | 时间前缀保留；提交哈希不再可用，改为 manifest 前缀 |
| ref 名里的 `epochMs` | `captured_at_ms` / `captured_at` | 直接解析 |
| commit message `runId:` / `actor:` / `callId:` 三行 trailer | `run_id` / `principal_id` | `actor` 即捕获主体；`callId` 无对应字段（v1 记入 `stats.warnings` 之外不保存，避免伪造） |
| 前驱 = 同 root 字典序最新既有 ref | `parent` | 语义相同（现状 commit 无 parent，迁移时按 ref 序推出） |
| `git ls-tree -r` 的 `(mode, oid, path)` | `entries`（`blob_hash` 替换 oid） | mode 白名单一致（100644/100755/120000） |
| 无 | `merkle_root` / `state` / `migrated_from` | git 侧无等价物：迁移时重算/显式标记，缺失的 run/principal/nestedRoots 一律 null |

## 10. git 桥接契约（T0.3）

### 10.1 `export --git <store> --slice <id> --out <dir>`

- 输出标准裸仓：`git --git-dir=<dir> fsck|log|show|cat-file` 全部可用。
- 步骤：读 slice → manifest → blobs；blob 写成 loose object（`blob <len>\0<content>` + zlib，文件名=git oid）；按 path 分层写 tree object（mode 100644/100755/120000）；写 commit（`parent` = 前一 slice 的 commit，author/committer = `captured_at`，message 尾部落 trailer）。
- trailer 键：`XH-Slice-Id`、`XH-Root-Id`、`XH-Run-Id`、`XH-Principal-Id`、`XH-Merkle`、`XH-Nested-Roots`（JSON 单行）、`XH-Store-Version`。
- ref：`refs/xihe/slices/<slice_id>`。
- 成本：≈一次全量 restore + zlib 重压（10k 档约数秒）；只用于排障/校验，不在运行期调用。
- 退出码：`0` 成功 / `2` 数据损坏（store 侧校验失败）/ `3` 参数或环境错误。

### 10.2 `import`（迁移，`checkpoint-migrate`）

- 输入：`<hostRoot>/.xihe-shadow/<rootId>.git`；输出：store 内同 root 的 slice。
- 遍历：`git for-each-ref refs/xihe/slices/` 按 ref 名升序 → `ls-tree -r -z <commit>` → `cat-file --batch` 读 blob 原始字节。
- 门禁：每个迁移 slice 双路 restore（store vs `git checkout`）到临时目录，逐文件 SHA-256 + mode 比对，差异 0 才写入 migrated slice；失败列出前 10 个差异路径且**不写该 slice**。
- 幂等：已存在同 id 且 merkle 一致 ⇒ 跳过；可中断（按 ref 游标重跑）。
- 旧 commit 无 trailer：`run_id/principal_id/nested_roots = null`、`exclusion_patterns = []`；`state=migrated`、`migrated_from=<ref>`。
- 退出码：`0` 全部成功 / `2` 存在 slice 校验失败 / `3` 参数或环境错误。

### 10.3 不做

- 不把 store 改成 git 可直接读的对象库；运行期不调用 git；不引入 `gix` / `libgit2`。
- 不导出/导入 git 的 branch/merge/rebase/远端语义；桥接只覆盖 blob/tree/commit/ref 四类对象。

## 11. 错误码（摘要）

| 码 | 场景 | 行为 |
|---|---|---|
| `STORE_VERSION_MISMATCH` | VERSION 不匹配 | 拒绝启动/读写（fail-closed） |
| `STORE_BUSY` | 另一进程持有锁 | exit 4，快速失败 |
| `BLOB_CORRUPT` | 三重校验失败 | exit 2，报路径与期望哈希，不写目标文件 |
| `MANIFEST_CORRUPT` | 解析/排序/merkle 校验失败 | exit 2，目标目录 0 文件（绝不静默返回空） |
| `SLICE_CORRUPT` | slice 与 manifest 不一致 | exit 2，跳过该 slice 并报错 |
| `RESTORE_INCOMPLETE` | 上次 restore 被中断 | `status` 报 `incomplete=true`；重跑幂等补完 |

## 12. changelog

- **2026-11-04 v1 冻结**（PLAN-0653 M0）：blob/manifest/slice/stat cache/VERSION/GC journal 字段与校验规则定稿。后续变更必须新增条目并说明向后兼容策略；禁止原地修改已发布格式。
- **2026-11-04 v1 校验补充**（PLAN-0653 T1.2）：读侧新增 4096× 压缩比门，写侧同条件回落 raw；字节布局与 `VERSION` 不变。合法 flate2 输出最大压缩比约 1032×，因此既有 blob 不会被新增的门拒收。
- **2026-11-04 stat cache 可选 `file_id`**（PLAN-0653 T1.7）：entries 增加可选 `file_id` 字符串；缺省解析为 `None`，旧 cache 仍可读但视为不命中，不影响 VERSION/其他格式。用于收紧同 size+mtime 替换盲区；取不到身份的降级路径已在上文标注。
