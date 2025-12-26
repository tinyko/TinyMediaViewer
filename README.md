# Media Viewer

面向 `/Users/tiny/X` 媒体库的全栈预览工具。后端用 TypeScript + Fastify 快速扫描目录并输出带快照的结构化数据，前端用 Vite + React 提供“无需进入子目录就能看预览”的浏览体验。

## 架构设计
- **后端（server）**：Fastify + TypeScript，按需扫描目录，提供 `/api/folder` 元数据接口，并通过 `/media/*` 直接回源真实文件。内置路径安全校验与目录级缓存（mtime 命中）。
- **前端（web）**：Vite + React + TypeScript。展示目录卡片（包含子目录内媒体的快照、数量统计）和当前目录媒体栅格，并附带预览弹窗、筛选和面包屑导航。
- **运行配置**：默认媒体根目录为项目上级路径 `/Users/tiny/X`，可通过环境变量 `MEDIA_ROOT` 覆盖；预览数量与扫描上限可通过 `PREVIEW_LIMIT`、`MAX_ITEMS_PER_FOLDER` 调整。

## 目录结构
```
media-viewer/
├─ server/        # Fastify 后端
│  ├─ src/config.ts     # 配置与默认值
│  ├─ src/scanner.ts    # 目录扫描与缓存
│  ├─ src/routes.ts     # API 路由
│  └─ src/server.ts     # 入口 & 静态文件服务
└─ web/           # Vite 前端
   ├─ src/App.tsx       # 页面逻辑与布局
   ├─ src/components/   # FolderCard、Preview Modal 等
   ├─ src/api.ts        # API 封装
   └─ src/types.ts      # 类型定义
```

## 后端接口
- `GET /api/folder?path=<相对路径>`：返回当前目录元数据：
  - `subfolders[]`：每个子目录的预览（前 `PREVIEW_LIMIT` 个媒体缩略 + 图像/视频数量 + 最近修改时间）。
  - `media[]`：当前目录下可预览媒体（图片/GIF/视频），含大小、修改时间、直链 URL（`/media/<path>`）。
  - `breadcrumb`：面包屑路径；`folder.absolutePath` 便于确认物理位置。
- 静态文件：`/media/<path>` 直接读取 `MEDIA_ROOT` 下的真实文件，支持前端视频/图片展示与下载。

## 运行方式
1) **后端开发/运行**
```bash
cd media-viewer/server
npm install          # 已执行过，可跳过
MEDIA_ROOT=/Users/tiny/X npm run dev   # 默认端口 4000，需时可修改 PORT/SERVER_HOST
```
2) **前端开发**
```bash
cd media-viewer/web
npm install          # 已执行过，可跳过
npm run dev          # Vite 默认 5173，已配置代理到 4000
```
3) **前端打包 & 后端生产启动**
```bash
cd media-viewer/web && npm run build
cd ../server && npm run build && npm run start
```
4) **一键同时起后端+前端（开发）**
```bash
cd media-viewer
./run-dev.sh        # 默认 MEDIA_ROOT=/Users/tiny/X，可自行覆盖
```

## 关键实现细节
- **无需进入子目录的预览**：后端在列出父目录时同步扫描每个子目录，返回前 `PREVIEW_LIMIT` 个媒体作为快照，前端卡片直接渲染小图/视频。
- **性能与安全**：
  - 扫描时跳过隐藏文件，限制单目录处理条目数（`MAX_ITEMS_PER_FOLDER`，默认 500）。
  - 路径规范化 + 根路径校验，避免越权访问。
  - 目录 mtime 缓存，减少重复扫描。
- **前端体验**：
  - 商业化布局：分区卡片、渐变头图、可筛选子目录、媒体网格、浮层预览（图片/视频播放）、下载按钮。
  - 面包屑和“回到根目录”快捷操作，快速切换不同层级。

## 可选下一步
1. 增加缩略图/视频首帧生成与缓存，降低大文件首屏加载成本。
2. 支持递归统计（目前为单层扫描）与排序/分页。
3. 增加全局搜索、标签/收藏、键盘导航等高频浏览功能。
4. 通过 Docker/PM2 部署脚本固化运行方式；接入鉴权或访问令牌。
