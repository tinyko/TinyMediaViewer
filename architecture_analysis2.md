# TinyMediaViewer 项目架构与问题分析

## 一、 架构概览 (Architecture Overview)

本项目是一个包含全栈及桌面端包装的媒体预览工具，整体分为三个主要模块：
1. **Server (Fastify + TypeScript)**：提供核心的目录结构扫描、元数据解析和静态媒体文件按需服务。
2. **Web (Vite + React 19 + TypeScript)**：提供高性能的瀑布流/网格前端界面，以及大量粒子/心跳等视觉特效。
3. **Desktop (Tauri + Rust)**：一个轻量级的跨平台桌面壳，内嵌 Web 前端，并在后台管理 Server 的生命周期和系统托盘。

## 二、 核心组件与机制设计

### 1. Server 端 (`server/`)
- **扫描器 [MediaScanner](file:///Users/tiny/X/media-viewer/server/src/scanner.ts#98-741) (核心)**：实现了带并发度控制 ([mapWithConcurrency](file:///Users/tiny/X/media-viewer/server/src/scanner.ts#77-97)) 的目录树扫描。支持 [Light](file:///Users/tiny/X/media-viewer/server/src/scanner.ts#329-355) (仅浅层统计) 和 [Full](file:///Users/tiny/X/media-viewer/server/src/scanner.ts#293-328) (全量统计分类) 两种模式。
- **两级缓存机制**：
  - **内存 LRU 缓存**：通过估算快照大小 ([estimateSnapshotBytes](file:///Users/tiny/X/media-viewer/server/src/scanner.ts#728-740)) 并限制总字节数 (`cacheMaxBytes`) 与条目数 (`cacheMaxEntries`)，对高频访问的目录结果进行内存加速。
  - **磁盘索引持久化 ([IndexStore](file:///Users/tiny/X/media-viewer/server/src/index_store.ts#19-126))**：将大型目录快照序列化为 JSON 进行本地落盘，大幅降低重启或二次冷启动的扫描开销。
- **大文件与媒体支持**：路由通过 `createReadStream` 和 HTTP Range 实现了字节范围请求，以支持前端大型视频的拖拽快进播放。

### 2. Web 端 (`web/`)
- **功能模块化**：包含 `category` (分类)、`effects` (特效)、`preview` (弹窗预览)、[ui](file:///Users/tiny/X/media-viewer/server/src/app.ts#8-57) (主题/性能) 等细分 feature。
- **虚拟滚动 ([MediaGrid](file:///Users/tiny/X/media-viewer/web/src/components/MediaGrid.tsx#117-246))**：采用了 `@tanstack/react-virtual` 处理成百上千量级的媒体卡片渲染；配合响应式列数计算，保障了大量数据场景下的 DOM 性能。
- **渲染降级 (`useThemeAndPerf`)**：自适应性能监控，当检测到过多的长任务或低帧率时，可自动降级或停止复杂的 Canvas/WebGPU 粒子特效 (`ParticleField`, `HeartPulseLayer`)。
- **回填队列 (`usePreviewBackfillQueue`)**：对于按需加载的目录预览缩略图，使用了队列调度异步加载，避免初始瞬间的大量并发请求。

### 3. Desktop 端 (`desktop/`)
- 基于 Tauri 架构。使用 Rust [service_manager.rs](file:///Users/tiny/X/media-viewer/desktop/src-tauri/src/service_manager.rs) 来控制并保活 Node 后台服务。提供了系统级别的设置持久化（如开机自启、启动隐藏等），并对外暴露跨语言调用的应用状态。

---

## 三、 当前状态与已完成修复 (Current Status)

截至 2026-03-06，这份文档里原先列出的几条主问题已经全部落地。下面按问题线索同步当前真实状态：

### 1. **[已修复] 视频首帧爆炸式请求与渲染卡顿**
- **现状**：最新代码中引入了 `VideoThumbnailCache` 和 `/thumb/*` 专属代理路由，在后台使用 FFmpeg 统一调度生成并缓存视频缩略图。同时，前端完善了 `useThemeAndPerf` 的动态降级逻辑，在主线程长任务堆积时会自动关闭繁重的粒子特效。
- **验证**：此问题基本解决，大幅减轻了并发媒体浏览下的客户端解码和网络连接池崩溃压力。

### 2. **[已修复] `JSON.stringify` 导致的事件循环同步阻塞**
- **现状**：`IndexStore` 已改为分片 JSON 序列化写盘，不再一次性 `JSON.stringify(payload)` 后整体写入；同时 `MediaScanner` 的 `estimateSnapshotBytes` 也改成按结构近似估算，不再为 cache bookkeeping 再同步序列化整份快照。
- **结果**：大目录快照写盘和内存缓存估算都避免了“整对象同步 stringify” 这一类主线程阻塞点。

### 3. **[已修复] 持久化索引重新接回运行时读取链路，并从单一 `mtime` 升级为目录签名校验**
- **现状**：`MediaScanner` 的 `light` 模式现在会在内存缓存 miss 后先尝试命中 `IndexStore`，命中后直接恢复目录快照并回填内存缓存；`folder preview` 也已接入持久化索引。与此同时，索引命中条件不再只依赖目录自身 `mtime`，而是改成基于当前目录可见媒体/子目录状态生成的签名，能够覆盖“类别目录内已有文件内容更新但父目录 `mtime` 不变”这类场景。
- **结果**：服务重启后的根目录轻量首屏和目录 preview 都不再只能依赖全量重扫；磁盘索引重新成为真实运行时路径的一部分，并且比早期的“目录 `mtime` 命中”策略更不容易返回陈旧结果。

### 4. **[已修复] 大扁平目录引起的内存危机 (OOM Risk)**
- **现状**：`MediaScanner` 已把多个 `fs.readdir(..., { withFileTypes: true })` 扫描点收敛到统一的 `fs.opendir()` 流式遍历 helper。
- **结果**：目录扫描不再先把整批 `Dirent[]` 推入内存；`light`、`full`、preview 和类别目录扫描都改为边读边分类，显著降低了超大扁平目录下的瞬时堆占用。

### 5. **[已修复] 类别媒体的反复扫描**
- **现状**：`images`、`videos`、`gifs` 等特殊目录已经收敛到统一的扫描链路里；同一轮 snapshot/preview 构建中，每个类别目录只做一次顶层遍历，再直接产出媒体候选。
- **结果**：消除了原来“主目录扫描后再单独收类别目录”的分裂式实现，避免同一请求内的重复 I/O；同时仍保持只扁平吸收类别目录顶层媒体文件、不递归子目录的既有语义。

### 6. **[已修复] 相对路径系统级防护 (软链接越权读取漏洞)**
- **现状**：路径解析已经从“纯字符串归一化”升级为 `realpath` 物理边界校验。根目录内的 symlink 只有在目标物理路径仍位于 media root 下时才允许访问；越界目标会被统一按 `Path escapes media root` 拒绝。
- **结果**：`/api/folder`、`/media/*`、`/thumb/*` 都已经走同一套物理路径校验链路，堵住了根目录内 symlink 指向根外路径时的穿透读取问题。

### 7. **[已完成] 增量索引第一阶段：watcher 驱动的代际失效与热缓存**
- **现状**：`MediaScanner` 现在会对参与 `full` / `folder preview` 结果构建的目录建立 best-effort watcher，并在目录内容变化时向受影响路径及其祖先路径传播代际失效。基于这套机制，`full` 快照已经重新接回内存热缓存，preview 也新增了进程内热缓存；同时 `full` 在构建子目录摘要时不再直调裸 `buildFolderPreview`，而是会复用 preview 的热缓存和持久化索引。
- **结果**：同一进程生命周期内，热点目录的 `full` 请求与 preview 回填都可以直接命中热缓存；服务重启后，`full` 的子目录 preview 也能直接复用已持久化的 preview 结果。而像 `account/images/a.jpg` 这种类别目录内已有文件被修改的场景，也会触发上层目录结果失效并自动重建，形成真正意义上的“增量失效”闭环。

### 8. **[已完成] 目录 manifest 第一版：`full` / preview 共享目录级扫描结果，并接入持久化恢复**
- **现状**：`MediaScanner` 已新增 `DirectoryManifest` 层，用来缓存某个目录在“类别目录扁平化”语义下的直接媒体列表、非类别子目录列表、子目录计数以及需要恢复 watcher 的直系目录集合。`full` 快照与当前目录的 preview 构建会共享这层结果；当 manifest 已经处于热状态时，preview 的索引签名会直接从 manifest 派生，而不是再次扫描目录生成签名。与此同时，manifest 也已经接入 `IndexStore`。服务重启后，代码会先尝试用已持久化的 entry 记录做定向校验：根目录不变时，只对已知媒体做 `stat`，并按需局部重扫发生变化的类别目录，而不是先整目录重扫。
- **结果**：这让 `full` 与同目录 preview 的组合请求不再各自重复做一轮 `scanFolderEntries + buildMediaItems`，同进程热点路径上的目录枚举和逐文件 `stat` 明显收敛；而在服务重启后，`full` 路径也可以直接复用已持久化的 manifest，并在“已有文件内容变化但目录 `mtime` 未变”这类场景下通过定向校验恢复最新结果。当前仍未做到真正的“零扫描恢复”，因为目录新增/删除场景之外，校验链路仍然要对既有 entry 做逐项确认；但相比只持久化 snapshot/preview，重启后的 `full` 热点路径已经更接近真正可复用的目录级索引。

### 9. **[已完成] watcher 驱动的 entry 级 manifest 预热**
- **现状**：watcher 现在不再只做“路径代际失效”。当被监听目录发生 entry 级变化时，`MediaScanner` 会先把同一个 manifest key 上的多个 watcher 事件合并到串行队列里，再基于 `fs.watch` 提供的文件名，对已缓存的 `DirectoryManifest` 做定向增量更新，并把更新后的 manifest 再次写回 `IndexStore`。这套更新现在覆盖三类场景：当前目录直接媒体文件的增删改、类别目录（如 `images/videos/gifs`）顶层媒体的增删改，以及当前目录下普通子目录与类别目录本身的新增、删除和重命名。对于少数平台上 `fs.watch` 不返回 `filename` 的情况，代码也会回退到“按 owner 重建 manifest 再持久化”的兜底路径。
- **结果**：这让“目录内容变了，下一次 `full` 请求就整目录重扫”的路径进一步收缩成“目录内容变了，snapshot/preview 缓存失效，但 manifest 已经被后台预热”。在当前实现下，单个媒体文件的改动、普通子目录的新增/删除、`stash -> images` 这类目录重命名，以及一批快速连续发生的 root watcher 事件，都会在后台把父目录 manifest 更新到最新状态；如果服务在变更后重启，新的 scanner 也能直接命中 watcher 刚刚写回的 manifest 索引，而不必再次执行根目录级的 `scanFolderEntries + buildMediaItems`。

## 四、 结论

这份文档里原先列出的主问题，目前都已经有对应实现和回归测试支撑。若继续推进后端性能治理，下一步更适合关注的是：

1. 是否要把当前“watcher 预热 manifest + 持久化 manifest + 签名式 snapshot/preview 索引”的组合，继续推进成真正的目录 entry 级增量索引层，从而把 manifest 命中前的目录签名扫描也进一步压缩掉，并覆盖更复杂的批量变更和跨平台 watcher 语义差异。
2. 是否需要为超大目录建立更强的离线/重启后索引恢复能力，例如更细粒度的目录 entry 清单或预计算的 media stat 记录，而不仅依赖请求时重新做目录签名校验。
3. 现有 perf bench 已补上可重复的 `synthetic` 大目录模式，能够自动生成 account/category/media 结构并测量冷启动、持久化重启、大目录 `full` 分页以及“重启后的 persisted full 恢复”；后续更适合做的是把它继续扩展到更接近真实生产数据分布的 fixture，并补一轮真实大目录基准，而不是只停留在合成树的固定配方。
