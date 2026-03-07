# TinyMediaViewer

<p align="center">
  <img alt="TinyMediaViewer" src="https://img.shields.io/badge/TinyMediaViewer-Rust%20Backend-2d76ff?style=for-the-badge">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react&logoColor=black">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-Backend-000000?style=for-the-badge&logo=rust&logoColor=white">
</p>

面向本机媒体库的预览工具。当前主线已经收口为 Rust-only 后端：`backend-rs` 是唯一服务实现，`web` 保留 React viewer，`desktop` 使用 Tauri 2 作为桌面壳层并拉起 Rust sidecar。

## 当前设计
- 根目录列表走轻量快照，账号切换走完整分页接口和服务端分页，避免首次加载就扫描整库。
- 左侧账号列表和右侧媒体网格都做了虚拟化；根目录数据在前端走归一化 store，预览和计数按可见账号批量回填。
- 账号行右侧支持收藏按钮，收藏状态通过 Rust backend 写入 SQLite；顶部 `按收藏` 会筛出收藏账号，不是简单排序置顶。
- 前端特效层已经收口成共享 `EffectsStage`，默认请求 `webgpu`，初始化失败时自动回退到 `canvas2d`，工具栏显示 `WG×`。
- 前后端契约由 Rust DTO 生成 TypeScript 文件，前端不再依赖旧的 `shared-types` 包。
- 桌面端和开发态都只走 Rust backend，不再依赖旧的 Node/Fastify 服务链路。
- 缩略图链路不再依赖 `ffmpeg`：图片和 GIF 首帧由 Rust 本地生成，macOS 上的视频缩略图走 AVFoundation；视频缩略图按 `/thumb/*` 请求懒生成并缓存到文件系统和 SQLite。
- macOS 视频缩略图不是只截首帧，而是按 `100ms -> 2s -> 5s -> 10s` 多时间点探测；遇到黑场帧会自动后移，尽量避开开头黑屏。

## 仓库结构
- `backend-rs/`
  Rust workspace，当前唯一后端主线。
  - `tmv-backend-app`: 可执行入口，提供 HTTP 服务和静态 viewer。
  - `tmv-backend-api`: Axum 路由层，暴露 `/api/folder`、`/api/folder/previews`、`/api/folder/favorite`、`/__tmv/diag/*`、`/media/*`、`/thumb/*`。
  - `tmv-backend-core`: 目录扫描、缓存、分页、排序、预览构建、LAN 鉴权、收藏状态叠加、缩略图调度。
  - `tmv-backend-index`: SQLite 持久化，保存索引、收藏、缩略图 job/asset 等本地状态。
  - `tmv-backend-watch`: 文件系统 watch，目录变化时失效缓存。
  - `tmv-contract-export`: 从 Rust DTO 生成前端 TypeScript 契约。
- `web/`
  React 19 + Vite viewer。根目录数据通过本地归一化 store 管理，分类媒体缓存和分页逻辑在 hooks 内收口，特效层支持真实 `canvas2d/webgpu` 双分支。
- `desktop/`
  Tauri 2 桌面壳层。负责托盘、设置面板、sidecar 生命周期和 DMG 打包。
- `archive/node-legacy/`
  归档的 Node/Fastify 旧实现，仅作历史参考，不参与主线运行、构建或 CI。

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

默认产物路径：

```bash
/Users/tiny/X/media-viewer/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/TinyMediaViewer_0.1.0_aarch64.dmg
```

## 常用验证
Rust workspace：

```bash
cd /Users/tiny/X/media-viewer/backend-rs
cargo fmt --check
cargo test --workspace
cargo build -p tmv-backend-app
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
- `web/README.md` 说明 viewer 开发命令、收藏筛选、渲染器和契约生成。
- 旧的 Node 代码已迁到 `archive/node-legacy/`，不要再把 `server/` 当成主线服务入口。
