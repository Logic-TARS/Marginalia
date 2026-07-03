# Marginalia 📖

**电子书划线笔记 → 飞书 → 短视频 Agent**

阅读时划线、加笔记，一键同步到飞书，自动生成短视频脚本。

## 快速开始

### 1. 启动后端

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

API 运行在 `http://localhost:8000`，自动生成文档在 `/docs`。

### 2. 打开阅读器

直接用浏览器打开 `frontend/index.html`：
- Chrome / Edge / Safari 均可
- 首次加载需要网络（加载 epub.js CDN），之后 Service Worker 会缓存
- iPhone Safari 可以选择「添加到主屏幕」作为 PWA 使用

### 3. 导入 EPUB 开始阅读

- 点击「导入 EPUB」，选择一个 `.epub` 文件
- 选中文字进行划线（支持 4 种颜色）
- 点击划线可以添加笔记和标签
- 点击「同步」推送到后端

### 4. 接入飞书（可选）

```bash
cp .env.example .env
# 编辑 .env，填入你的飞书 Webhook URL
```

配置好后，每次同步划线都会在飞书群里收到通知。

### 5. 生成短视频脚本（可选）

```bash
# 从划线生成视频脚本
curl -X POST http://localhost:8000/api/generate-script \
  -H "Content-Type: application/json" \
  -d '{"highlight_ids": ["uuid1", "uuid2", "uuid3"]}'
```

## 项目结构

```
frontend/       PWA 阅读器 (epub.js + IndexedDB)
backend/        FastAPI 后端 (Python)
scripts/        工具脚本 (飞书 → Agent)
docs/           架构文档 & 飞书配置指南
```

## MVP 路线

- [x] EPUB 阅读 + 划线 + 笔记（本地存储）
- [x] 手动同步到后端 API
- [x] 飞书 Webhook 集成
- [x] 短视频脚本生成 Agent
- [ ] 自动同步（Service Worker Background Sync）
- [ ] 飞书多维表格（Bitable）结构化存储
- [ ] AI 增强脚本生成（接入 LLM）

## 文档

- [架构概览](docs/ARCHITECTURE.md)
- [飞书配置指南](docs/FEISHU_SETUP.md)
