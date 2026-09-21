# K-Vault 项目介绍

## 项目定位

K-Vault 是一个开源的图片/文件托管系统，目标是提供低成本、可扩展的文件床方案。

本项目**只支持一种部署方式**：

- Cloudflare Pages：仓库根目录静态页面 + `functions/` 的 Serverless 运行形态


当前前端入口是仓库根目录下的静态页面，例如 `index.html`、`admin.html`、`paste.html`、`gallery.html`、`webdav.html`、`login.html`、`preview.html`。旧版 `frontend/` Vite/Vue UI 与 `_nuxt/` 产物已不再作为项目 UI 入口。

## 技术架构

### 1. 前端

- 技术形态：根目录静态 HTML/CSS/JS 页面
- Cloudflare Pages：直接发布仓库根目录，Build command 和 Build output directory 留空
- 主要页面：
  - `/`：上传首页
  - `/admin.html`：后台管理
  - `/gallery.html`：图片/文件浏览
  - `/webdav.html`：WebDAV 场景页面
  - `/login.html`：登录页
  - `/preview.html`：文件预览页

### 2. 后端

- Cloudflare Pages Functions：提供上传、文件代理、管理、API Token、API v1、短分享等接口

### 3. 数据层

- Cloudflare Pages：KV/R2 等绑定承载元数据与对象数据

## 功能能力

- 多后端文件存储：Telegram、R2、S3、Discord、HuggingFace、WebDAV、GitHub
- 多种上传方式：普通上传、URL 上传、分片上传
- 后台文件管理：搜索、筛选、目录、移动、重命名、删除、收藏
- 分享控制：上传时可设置有效期、访问密码、下载次数上限与自定义短链；网页端提供文本粘贴（Pastebin）
- API Token：支持 `upload`、`read`、`delete`、`paste` 权限，可在 `/admin.html` 的「工具 → API Token 管理」中维护
- API v1：支持文件上传/列表/下载/删除和文本 Paste 创建/读取/删除
- 分享入口：`/s/:slug` 短分享链
- 运行状态检查：存储连通性、上传限制、诊断信息

> 说明：`/api/manage/block|white/:id`（白名单/黑名单）后端接口仍然可用，但当前后台**没有 UI 入口** —— 此前唯一的入口 `admin-imgtc.html` 已随本次改造删除。

## 部署建议

- 唯一受支持的部署方式是 Cloudflare Pages，按 README 要求留空构建命令和输出目录
- 本仓库不提供 Docker / Nginx 自托管部署路径；上游 Node 运行时源码（`server/`）与相关服务端测试已一并移除
- 不再使用旧版 `frontend/dist`、`frontend/landing` 或 `_nuxt` 作为部署入口
