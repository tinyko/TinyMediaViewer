# TinyMediaViewer

<p align="center">
  <img alt="TinyMediaViewer" src="https://img.shields.io/badge/TinyMediaViewer-Rust%20Backend-2d76ff?style=for-the-badge">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react&logoColor=black">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-Backend-000000?style=for-the-badge&logo=rust&logoColor=white">
</p>

面向本机媒体库的预览工具。当前主线已经收口为 Rust-only 后端：`backend-rs` 是唯一服务实现，`web` 保留 React viewer，`desktop` 使用 Tauri 2 作为桌面壳层并拉起 Rust sidecar。

## 当前设计
- 根目录列表走 `/api/root` 轻量摘要；分类媒体走 `/api/category` 服务端分页，避免首次加载就扫描整库。
- `tmv-backend-core` 已经按职责拆成 `runtime`、`snapshot`、`manifest`、`preview`、`favorites`、`system_usage`、`diagnostics`、`thumbnail/*` 以及 `paths/media/scan/service_types` 等内部模块；`lib.rs` 只保留公开导出、`BackendService` 装配和少量共享入口。
- 后端运行时缓存不再共用一把大锁：根目录 light snapshot、目录 manifest、folder preview 和 path generation 都按子系统拆开维护；watch 失效会级联路径 generation，收藏切换会显式打掉根目录 light snapshot。
- 左侧账号列表和右侧媒体网格都做了虚拟化；根目录数据在前端走归一化 store，预览和计数按可见账号批量回填，回填队列会在超时或部分失败时自动降并发。
- 分类媒体请求由 React Query 管理：`useInfiniteQuery` 负责分页、缓存和失效，查询 key 按账号路径、媒体类型、后端排序方向和根目录版本隔离；前端对已加载页做 append-only 聚合，并给聚合结果加了固定 24 项的 LRU 缓存，避免翻页时重建整段媒体数组，也避免旧 `rootVersion` 常驻内存。
- 左侧账号列表支持 `按时间`、`按名称`、`按收藏` 和 `按随机`。`按收藏` 会筛出收藏账号；`按随机` 使用稳定 seed 打散顺序，只有再次点击按钮才会重新洗牌。
- 账号胶囊整行都可点击切换，右侧收藏按钮独立浮层可点；收藏状态通过 Rust backend 写入 SQLite 并持久化。
- 右侧媒体网格支持 `按时间+`、`按时间-` 和 `按随机`。媒体随机顺序在前端基于当前已加载条目稳定重排，再次点击按钮才会换一组，不会为重洗牌重新拉接口。
- Viewer 的本地偏好通过 Rust backend 写入 SQLite：搜索词、账号排序、账号随机 seed、媒体筛选、媒体排序、媒体随机 seed、当前账号、主题、手动主题、特效模式和渲染器在刷新或重启后都会恢复。前端现在由 `useViewerSession` 作为 facade，内部拆成 `useRootSession`、`useCategorySession`、`useViewerPersistence`、`useAuthRedirect`、`useCategorySelectionCoordinator` 和 `useRefreshCoordinator`，不再把所有副作用塞进一个大 hook。
- 工具栏提供“系统占用情况”弹窗，按默认媒体根目录统计账号总占用、图片占用、视频占用、其它占用，并展示单个账号的 Top 5 大文件；前端仍有 30 秒缓存，但后端现在会后台维护一份完整热快照，手动刷新会显式绕过缓存并等待最新一轮统计完成。
- 前端特效层已经收口成共享 `EffectsStage`，默认请求 `webgpu`，初始化失败时自动回退到 `canvas2d`，工具栏显示 `WG×`。
- 前后端契约由 Rust DTO 生成 TypeScript 文件，前端不再依赖旧的 `shared-types` 包。
- 桌面端和开发态都只走 Rust backend，不再依赖旧的 Node/Fastify 服务链路。
- 缩略图链路不再依赖 `ffmpeg`：图片和 GIF 首帧由 Rust 本地生成，macOS 上的视频缩略图走 AVFoundation；视频缩略图按 `/thumb/*` 请求懒生成并缓存到文件系统和 SQLite。
- 预览弹窗会锁定背景滚动，移动端和平板上的上下手势不会再把底层主页面带着滚动。
- SQLite 持久化层使用 `deadpool-sqlite` 连接池，每条连接在创建时都会补齐 `WAL`、`busy_timeout` 和相关 PRAGMA，再统一复用到 manifest、收藏和缩略图状态读写中。当前 schema 已到 `v6`：`folder_manifest` 只保留目录统计和 watched 目录元数据，`media_entry` 以 `(folder_path, media_path)` 为身份键，manifest 持久化改成事务内差量 upsert + 删除缺失项，不再写 `media_json/media_bin/default_page_media_json` 这套 legacy blob。

## 仓库结构
- `backend-rs/`
  Rust workspace，当前唯一后端主线。
  - `tmv-backend-app`: 可执行入口，提供 HTTP 服务和静态 viewer。
  - `tmv-backend-api`: Axum 路由层，暴露 `/api/root`、`/api/category`、`/api/folder/previews`、`/api/folder/favorite`、`/api/viewer-preferences`、`/api/system-usage`、`/__tmv/diag/*`、`/media/*`、`/thumb/*`。
  - `tmv-backend-core`: 目录扫描、运行时缓存、分页、排序、预览构建、收藏状态叠加、viewer 偏好读写、系统占用热缓存、缩略图调度。内部已拆成多模块，不再是单文件大实现。
  - `tmv-backend-index`: SQLite 持久化，基于 `deadpool-sqlite` 保存索引、收藏、viewer 偏好、缩略图 job/asset 等本地状态；当前 schema `v6` 已清掉 manifest legacy blob 列。
  - `tmv-backend-watch`: 文件系统 watch，目录变化时失效缓存。
  - `tmv-contract-export`: 从 Rust DTO 生成前端 TypeScript 契约。
- `web/`
  React 19 + Vite viewer。根目录数据通过本地归一化 store 管理，分类媒体通过 React Query 分页缓存、append-only 聚合和 LRU 聚合缓存，账号和媒体列表都支持稳定随机重排，Viewer 偏好通过后端 SQLite 持久化，session 状态按 root/category/persistence/refresh/auth 协调拆开，特效层支持真实 `canvas2d/webgpu` 双分支。
- `desktop/`
  Tauri 2 桌面壳层。负责托盘、设置面板、sidecar 生命周期和 DMG 打包，并在打包时把当前 `git rev-parse --short HEAD` 和 UTC 构建时间注入 viewer 指纹。
- `archive/node-legacy/`
  归档的 Node/Fastify 旧实现，仅作历史参考，不参与主线运行、构建或 CI。目录内仍保留 legacy smoke 脚本，脚本会自行构建依赖的后端并在失败时保存错误截图。

## 运行方式
### 开发态
先安装前端依赖：

```bash
cd /Users/tiny/X/media-viewer/web
npm install

cd /Users/tiny/X/media-viewer/desktop
npm install
```

然后一键启动 Rust backend + Web viewer：

```bash
cd /Users/tiny/X/media-viewer
./run-dev.sh
```

默认行为：
- Rust backend 监听 `0.0.0.0:4000`
- Vite viewer 监听 `5173`
- `MEDIA_ROOT` 默认是仓库上一级目录，也就是当前机器上的 `/Users/tiny/X`
- 本地开发和 DMG 打包都不需要额外安装 `ffmpeg`
- 默认缩略图缓存目录在 `~/Library/Application Support/TinyMediaViewer/thumbnails`
- 默认 SQLite 索引目录在 `~/Library/Application Support/TinyMediaViewer/backend-index`

如需单独启动后端：

```bash
cd /Users/tiny/X/media-viewer/backend-rs
TMV_RUNTIME_MODE=legacy \
TMV_MEDIA_ROOT=/Users/tiny/X \
TMV_BIND_HOST=0.0.0.0 \
TMV_PORT=4000 \
TMV_VIEWER_DIR=/Users/tiny/X/media-viewer/desktop/src-tauri/resources/viewer \
cargo run -p tmv-backend-app
```

## 契约生成
Rust DTO 定义在 `backend-rs/crates/tmv-backend-core/src/contracts.rs`，生成结果提交到 `web/src/generated/tmv-contract.ts`。

生成：

```bash
cd /Users/tiny/X/media-viewer/backend-rs
cargo run -p tmv-contract-export
```

校验生成文件没有漂移：

```bash
cd /Users/tiny/X/media-viewer/backend-rs
cargo run -p tmv-contract-export -- --check
```

## 打包
构建桌面 DMG：

```bash
cd /Users/tiny/X/media-viewer/desktop
npm run build:dmg
```

这个脚本会先：
- 编译 `backend-rs` 的 `tmv-backend-app`
- 把 Rust sidecar 复制到 `desktop/src-tauri/binaries/`
- 构建 `web` viewer 并复制到 `desktop/src-tauri/resources/viewer/`
- 最后通过 Tauri 打出 DMG

DMG 打包不再依赖系统 `ffmpeg`。在 macOS 桌面包内，视频缩略图由系统 AVFoundation 生成。
当前仓库默认打出的 DMG 仍是未签名、未公证产物，本机测试可直接使用；如果要分发到其它机器，还需要补 Apple Developer 签名和 notarization。

默认产物路径：

```bash
/Users/tiny/X/media-viewer/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/TinyMediaViewer_0.1.0_aarch64.dmg
```

## 常用验证
Rust workspace：

```bash
cd /Users/tiny/X/media-viewer/backend-rs
cargo fmt --check --all
cargo check --workspace
cargo clippy -p tmv-backend-core --all-targets -- -D warnings
cargo test -p tmv-backend-core
cargo test -p tmv-backend-index
cargo doc -p tmv-backend-core --no-deps
cargo run -p tmv-contract-export -- --check
```

Web：

```bash
cd /Users/tiny/X/media-viewer/web
npm run lint
npm test
npm run build
```

Desktop：

```bash
cd /Users/tiny/X/media-viewer/desktop/src-tauri
cargo check
```

## 相关说明
- `desktop/README.md` 说明桌面壳层和 DMG 打包。
- `web/README.md` 说明 viewer 开发命令、SQLite 偏好持久化、系统占用弹窗、收藏筛选、账号/媒体随机排序、渲染器和契约生成。
- 旧的 Node 代码已迁到 `archive/node-legacy/`，不要再把 `server/` 当成主线服务入口。
