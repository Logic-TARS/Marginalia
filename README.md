# Marginalia 📖

**电子书划线笔记 → 飞书 → 短视频 / 公众号稿件 + Obsidian 导出**

阅读时划线、写感悟，一键同步到飞书，AI 自动生成短视频脚本或公众号文章，导出到 Obsidian 知识库。

## 快速开始

### 1. 启动服务

```bash
# 方式一：Docker Compose（推荐，含热重载 + 数据持久化）
docker compose up --build

# 方式二：直接启动
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8720

# Windows 用户也可以双击 start.bat
```

API 运行在 `http://localhost:8720`，浏览器打开这个地址即可使用阅读器。自动生成文档在 `/docs`。

### 2. 导入 EPUB 开始阅读

- 点击「导入 EPUB」，选择一个 `.epub` 文件
- 或者把 EPUB 文件放到 `backend/data/books/` 目录，刷新页面即可在书库看到
- 选中文字进行划线（支持 4 种颜色）
- 点击划线可以写感悟、加标签
- 点击「同步」推送到后端

### 3. 接入飞书（可选）

```bash
cp .env.example .env
# 编辑 .env，填入 FEISHU_WEBHOOK_URL
```

配置好后，每次同步划线都会在飞书群里收到通知。

### 4. AI 稿件生成（可选）

在 `.env` 中配置 OpenAI 兼容的 LLM 接口：

```env
LLM_BASE_URL=https://your-llm-endpoint/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=gpt-4o
```

然后在创作面板中勾选素材，选择「生成视频号稿」或「生成公众号稿」，AI 会自动根据划线和感悟生成稿件。

也可以通过 API 直接调用：

```bash
# 基础脚本生成（规则引擎，无需 LLM）
curl -X POST http://localhost:8720/api/generate-script \
  -H "Content-Type: application/json" \
  -d '{"highlight_ids": ["uuid1", "uuid2", "uuid3"]}'

# AI 稿件生成（需要配置 LLM）
curl -X POST http://localhost:8720/api/drafts/generate \
  -H "Content-Type: application/json" \
  -d '{"target": "video", "highlight_ids": ["uuid1", "uuid2"], "topic": "阅读分享"}'
```

### 5. 导出到 Obsidian（可选）

在 `.env` 中设置 Obsidian 仓库路径：

```env
OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault
```

然后在创作面板中点击「导出到 Obsidian」，划线素材和生成的稿件都会以 Markdown 格式写入你的 Obsidian 仓库。

## 项目结构

```
frontend/          PWA 阅读器 (epub.js + IndexedDB + vanilla JS)
  app.js           三视图：书库、阅读、创作
                   素材管理（筛选、勾选、感悟编辑）
                   AI 稿件生成（视频号 + 公众号）
                   Obsidian 导出
backend/           FastAPI (Python 3.12+)
  main.py          路由：health、highlights CRUD、drafts CRUD、script、obsidian export、books
  models.py         Pydantic 数据模型
  database.py       aiosqlite（highlights + drafts 两张表）
  agent.py          短视频脚本生成器（规则引擎，"剪辑先行"思路）
  llm.py            OpenAI 兼容 LLM 客户端（稿件生成）
  feishu.py         飞书自定义机器人 Webhook
  obsidian.py       Markdown 导出（划线素材 + 稿件）
  books_api.py      服务端 EPUB 管理
  config.py         环境变量配置
scripts/           工具脚本
docs/              架构文档 & 飞书配置指南
```

## 三视图导航

| 视图 | 功能 |
|------|------|
| **书库** | 导入 EPUB、浏览书籍、进入创作 |
| **阅读** | EPUB 阅读、划线标注、写感悟、全文搜索、AI 问答、书签 |
| **创作** | 素材筛选管理、AI 生成视频/文章稿件、编辑保存、导出 Obsidian |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_WEBHOOK_URL` | 飞书机器人 Webhook | （空） |
| `LLM_BASE_URL` | OpenAI 兼容 API 地址 | （空） |
| `LLM_API_KEY` | API 密钥 | （空） |
| `LLM_MODEL` | 模型名称 | （空） |
| `OBSIDIAN_VAULT_PATH` | Obsidian 仓库路径 | （空） |
| `DATABASE_URL` | SQLite 数据库路径 | `backend/data/marginalia.db` |

## MVP 路线

- [x] EPUB 阅读 + 划线 + 笔记（本地 IndexedDB 存储）
- [x] 手动同步到后端 API
- [x] 飞书 Webhook 集成
- [x] 短视频脚本生成（规则引擎）
- [x] AI 增强稿件生成（LLM，视频号 + 公众号）
- [x] Obsidian Markdown 导出
- [x] 服务端 EPUB 管理（`/api/books`）
- [x] 创作面板（素材筛选 → 稿件生成 → 编辑 → 导出）
- [x] Docker Compose 一键部署
- [ ] 自动同步（Service Worker Background Sync）
- [ ] 飞书多维表格（Bitable）结构化存储

## 文档

- [架构概览](docs/ARCHITECTURE.md)
- [飞书配置指南](docs/FEISHU_SETUP.md)
