# TinyMediaViewer 架构与问题优先级分析

> 状态基线：2026-03-06。
> 本文以当前工作区代码为准，包含已落地但尚未正式发布的 `full` 分页修复和前端手动刷新改动。

## 1. 架构概览

项目目前仍然是一个三段式结构：

1. `server/`
   - Fastify 提供 API 与媒体文件回源。
   - `MediaScanner` 负责目录扫描、预览构建、缓存与索引相关逻辑。
   - 主要接口是 `GET /api/folder`、`POST /api/folder/previews`、`GET /media/*`。

2. `web/`
   - React 19 单页应用。
   - 主流程是“根目录轻量加载 -> 可见目录预览回填 -> 选中目录后 `full` 模式加载媒体 -> 网格虚拟滚动 -> 弹窗预览”。
   - 视觉特效、主题、性能监控是附加层，不是核心数据层。

3. `desktop/`
   - Tauri 负责桌面壳、托盘、设置与 sidecar 生命周期。
   - Rust 端会启动 Node server sidecar，再起一个 gateway 托管前端静态资源并代理 API。

整体上，这个拆分仍然合理：文件系统与安全边界留在后端，UI 复杂度留在 Web，桌面端主要负责分发和运行控制。

## 2. 当前真实的数据路径

### 2.1 Server

- `server/src/app.ts`
  - 创建 Fastify 实例。
  - 注入 `MediaScanner`。
  - 注册 CORS 和路由。

- `server/src/routes.ts`
  - `/api/folder` 读取目录数据。
  - `/api/folder/previews` 为根列表按需补齐预览。
  - `/media/*` 直接流式返回真实媒体文件，并支持 Range。

- `server/src/scanner.ts`
  - `light` 模式：快速返回目录骨架，适合根列表首屏。
  - `full` 模式：先构建当前目录完整媒体索引，按 `modified desc` 排序，再由 `cursor / limit / nextCursor` 返回当前页。

### 2.2 Web

- `web/src/features/root/useRootFolder.ts`
  - 首次挂载时加载根目录的 `light` 数据。
  - 刷新时负责重新请求根目录，并返回新的根目录快照给上层状态机。

- `web/src/features/previews/usePreviewBackfillQueue.ts`
  - 根据左侧列表可见项，批量请求 `/api/folder/previews`。
  - 逐步把根列表中的“占位目录”补成真实统计和真实预览。

- `web/src/features/category/useCategoryMedia.ts`
  - 用户选中目录后，以 `full` 模式加载媒体。
  - 本地维护目录级缓存，并处理分页拼接、刷新时的强制重拉和缓存失效。

- `web/src/App.tsx`
  - 负责把根目录加载、分类加载、弹窗预览、以及显式刷新流程串起来。

- `web/src/components/Toolbar.tsx`
  - 已提供显式“刷新”按钮。
  - 刷新时会中止在途请求、清空目录缓存并重启预览回填。

### 2.3 Desktop

- `desktop/src-tauri/src/service_manager.rs`
  - 启动和停止 sidecar/gateway。
  - 负责端口选择、日志输出、健康检查。

- `desktop/src-tauri/src/viewer_gateway.rs`
  - 提供 viewer 静态资源。
  - 代理 `/api` 和 `/media` 到本地 sidecar。
  - 接收前端发来的预览/性能诊断事件。

这里要特别说明：桌面端当前更像“桌面壳 + 生命周期管理器 + 局域网网关”，而不只是一个本地 WebView 容器。

## 3. 截至 2026-03-06 的当前状态与剩余问题优先级

先说结论：最影响结果正确性的两条主线、桌面端默认暴露面、视频列表首帧压力，以及第一阶段的协议抽取都已经落地；当前已经没有新的高优先级功能修复项，剩余工作主要是仓库治理与工具链协同。

### 已完成：`full` 模式结果正确性与分页语义

1. `full` 结果不再依赖容易失真的父目录快照复用，子目录内媒体更新后，父层 `full` 结果会重新构建。
2. `full` 模式的媒体分页源已经是完整、按 `modified desc` 排序后的媒体列表；`GET /api/folder` 继续保持原有 `cursor / limit / nextCursor` 形状，但语义已经变成真正的页结果。
3. `MAX_ITEMS_PER_FOLDER` 不再截断 `full` 模式的分页媒体，只保留给轻量预览链路作保护。

### 已完成：前端显式刷新闭环

1. 顶部工具栏已有显式刷新入口。
2. 刷新会中止 root/category/preview 的在途请求，清空 category 本地缓存，重启 root preview backfill，再按“原目录仍存在则回到原目录，否则切到新首项”的规则重载。
3. 这条链路没有新增公开 HTTP 接口，只是把现有 `light` / `full` 请求组织成可控的前端刷新流程。

### 已完成：Desktop gateway 默认改为仅本地访问

- 当前事实：`desktop/src-tauri/src/viewer_gateway.rs` 会按设置决定绑定地址；默认 `local` 模式仅绑定 `127.0.0.1`，只有显式切到 `lan` 模式才会绑定 `0.0.0.0`。
- 在 `lan` 模式下，gateway 会对静态资源、`/api`、`/media`、`/thumb` 和诊断接口统一做 `HTTP Basic Auth`；只有认证通过后才继续代理并注入 sidecar token。
- 桌面设置面板已暴露访问模式和 LAN 密码；托盘菜单与设置面板里的“打开 Viewer”都统一走本机 URL，不再默认打开 LAN 地址。

### 已完成：列表视频缩略图缓存层

- 当前事实：`server` 已提供 `/thumb/*` 路由，缩略图会通过 `ffmpeg` 生成 JPEG，并以“文件路径 + 修改时间”为键落到本地缓存目录。
- `web/src/components/MediaGrid.tsx` 已优先消费 `thumbnailUrl`，缩略图加载失败时才回退到原来的 `<video>` 首帧链路。
- `desktop` gateway 与 Vite dev server 都已补 `/thumb` 代理，所以桌面版、开发环境和直接跑 web 都会走同一条缩略图接口。

### 已完成：`server <-> web` 共享协议包

- 当前事实：`server` 与 `web` 已通过本地 `file` 依赖接入 `@tmv/shared-types`，`FolderPayload`、`FolderPreview`、`MediaItem`、`FolderPreviewBatch*` 等 viewer HTTP 契约现在只在一处定义。
- `server/src/scanner.ts` 继续 re-export 这些协议类型，`web/src/types.ts` 也继续作为前端统一类型出口，因此这轮没有引入全仓库 import 路径重写。
- 这一步只解决了 `server <-> web` 的契约重复问题；`desktop` 的 Tauri payload 与 Rust 结构体仍保持各自边界。

### P3. workspace 与依赖版本仍延后

- 当前事实：仓库仍然不是 root workspace；`web` 与 `desktop` 的 React/Vite/TypeScript 版本仍有漂移。
- 为什么重要：共享协议已经把接口漂移风险降下来了，但工具链升级、跨包脚本和版本治理仍然是分散的。
- 建议方向：先观察共享协议包是否已经覆盖主要痛点，再决定是否需要继续推进 workspace 化或版本统一；不要把这一步和已经完成的协议共享重新绑成一次大改。

## 4. 截至 2026-03-06 已完成并验证的内容

### 4.1 服务端 `full` 分页与排序修复

- `server/src/scanner.ts`
  - `full` 模式会构建当前目录完整媒体索引，并按 `modified desc` 排序后交给 `getFolder` 做 `cursor / limit / nextCursor` 切页。
  - 根目录直系媒体与 `images/videos/gifs/...` 这类特殊类别目录里的媒体，仍然会合并成同一条时间线后再分页。
  - `MAX_ITEMS_PER_FOLDER` 只保留给轻量预览与批量预览链路，不再默默截断 `full` 分页结果。

- `server/src/server.test.ts`
  - 已覆盖“子目录媒体更新后父层 `full` 结果刷新”。
  - 已覆盖“超过旧上限后的完整分页排序”。
  - 已覆盖“预览链路仍保留上限保护”。

### 4.2 Web 显式刷新与缓存失效

- `web/src/components/Toolbar.tsx`
  - 已提供显式刷新按钮。

- `web/src/App.tsx`
  - 负责把 root 重载、category 重载、preview 队列重启、以及弹窗选中媒体同步到同一条刷新流程。

- `web/src/features/root/useRootFolder.ts` 与 `web/src/features/category/useCategoryMedia.ts`
  - 支持刷新时的请求中止、缓存失效和强制重拉，避免把旧分页结果继续拼到新数据上。

- `web/src/App.light.test.tsx`
  - 已覆盖“刷新后保留原目录或回退到新首项”。
  - 已覆盖“刷新不混拼旧分页”。
  - 已覆盖“刷新后 root preview backfill 重启并忽略旧批次结果”。
  - 已覆盖“刷新后当前弹窗媒体失效时自动关闭”。

### 4.3 Desktop gateway 本地/LAN 模式与鉴权

- `desktop/src-tauri/src/config.rs` 与 `desktop/src-tauri/src/commands.rs`
  - 新增 `viewerAccessMode` 与 `lanPassword`，并兼容旧设置文件缺少新字段的情况。

- `desktop/src-tauri/src/viewer_gateway.rs` 与 `desktop/src-tauri/src/service_manager.rs`
  - `local` 模式绑定 `127.0.0.1`，`lan` 模式绑定 `0.0.0.0`。
  - `lan` 模式下对非 loopback 请求统一执行 `HTTP Basic Auth`。
  - 认证通过后才继续透传 `/api`、`/media` 与 `/thumb` 到后端 sidecar。

- `desktop/src/App.tsx`
  - 已提供访问模式切换、LAN 密码输入、固定用户名提示，以及局域网 URL 的启用状态展示。

### 4.4 视频缩略图缓存层

- `server/src/video_thumbnail_cache.ts` 与 `server/src/routes.ts`
  - 已引入独立的视频缩略图缓存层，并通过 `/thumb/*` 对外提供缩略图内容。
  - 缩略图缓存按“文件路径 + 修改时间”失效，不再把列表首帧渲染压力压到真实视频流上。

- `server/src/scanner.ts`
  - `MediaItem` 已附带 `thumbnailUrl`，视频列表可以直接拿到缩略图地址。

- `web/src/components/MediaGrid.tsx`
  - 已优先渲染视频缩略图图片，并在图片失败时回退到旧视频元素，避免因为缩略图生成异常直接出现空白卡片。

### 4.5 `server <-> web` 共享协议包

- `shared-types/package.json` 与 `shared-types/index.d.ts`
  - 已新增本地共享包 `@tmv/shared-types`，只承载 viewer HTTP 契约类型，不包含运行时代码、桌面设置类型或 Rust/Tauri payload。

- `server/package.json` 与 `web/package.json`
  - 已通过 `file:../shared-types` 接入共享协议包，并刷新各自锁文件。

- `server/src/scanner.ts` 与 `web/src/types.ts`
  - `server` 继续 re-export 契约类型，`web` 继续通过本地 `types.ts` 做统一出口，因此现有组件、hooks 与测试不需要在这轮重写导入路径。

### 4.6 接口兼容性结论

- 这轮修复保留了现有 `/api/folder`、`/api/folder/previews` 与 `/media/*` 语义，并新增了独立的缩略图资源路由 `/thumb/*`。
- `/api/folder` 仍保持原有 `cursor / limit / nextCursor` 形状，只修正了 `full` 模式的语义。
- 前端刷新仍只复用了现有 `light` / `full` / `previews` 接口。
- 视频缩略图新增的是独立资源路由 `/thumb/*`，没有改变原有媒体详情和弹窗预览所依赖的 `/media/*` 语义。
- 共享协议包改变的是 TypeScript 包边界，不是 HTTP 形状；这轮没有新增或改名任何公开 viewer 接口。

## 5. 后续路线图

### 已完成

1. `full` 模式的数据正确性修复，包括子目录更新失效、全量排序后分页，以及 `MAX_ITEMS_PER_FOLDER` 不再截断 `full` 分页结果。
2. Web 显式刷新闭环，包括在途请求中止、category cache 失效、root preview backfill 重启，以及刷新后目录/弹窗状态同步。
3. `Desktop gateway` 默认切回本地模式，并在显式启用 LAN 分享时增加独立 `HTTP Basic Auth`。
4. 视频缩略图缓存层，包括 `/thumb/*` 路由、本地缓存、桌面/Vite 代理，以及列表卡片优先消费缩略图。
5. `server <-> web` 共享协议包 `@tmv/shared-types`，让 viewer HTTP 契约只在一处定义，并保持 `server/src/scanner.ts` 与 `web/src/types.ts` 的兼容出口。

### 下一优先级

- 当前没有新的高优先级功能修复项。
- 如果继续推进工程治理，最先需要评估的是：共享协议包是否已经覆盖主要痛点，还是确实值得继续投入到 root workspace 与依赖版本统一。

### 中期治理

- `workspace / 依赖版本治理`
  - 问题：`web` 与 `desktop` 的 React/Vite/TypeScript 版本仍然漂移，仓库脚本和安装边界仍然分散。
  - 为什么重要：后续做统一升级、跨包检查或发布流程收敛时，维护成本会继续上升。
  - 建议方向：先保留当前“共享协议包 + 独立应用”的结构，只有在版本治理和跨包脚本开始反复造成摩擦时，再评估是否值得引入 root workspace。

- 目录扫描、列表缩略图、弹窗原始媒体流应继续保持解耦，避免后续治理把已经拆开的链路重新耦合回去。
