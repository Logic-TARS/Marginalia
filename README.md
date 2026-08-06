# Marginalia

**电子书划线笔记 → 本地素材库 → 短视频 / 公众号稿件 + Obsidian 导出**

阅读 EPUB 时划线、写感悟、打标签，手动同步到本地 FastAPI/SQLite 素材库，再用 AI 生成短视频脚本或公众号文章，也可以导出到 Obsidian 知识库。

## 快速开始

### 1. 启动服务

```bash
# 方式一：Docker Compose（含热重载 + 数据持久化）
docker compose up --build

# 方式二：项目级 .venv（Windows 用户可直接双击）
start.bat

# 或手动安装 Python 依赖并启动
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8720 --reload
```

API 运行在 `http://localhost:8720`，浏览器打开这个地址即可使用阅读器。自动生成文档在 `/docs`。

### 2. 导入 EPUB 开始阅读

- 点击「导入 EPUB」，选择一个 `.epub` 文件。
- 或者把 EPUB 文件放到 `backend/data/books/` 目录，刷新页面即可在书库看到。
- 服务器书籍在每台设备首次打开时下载一次，随后保存到浏览器本机；只有文件内容变化或浏览器数据被清理后才重新下载。
- 选中文字进行划线（支持 4 种颜色）。
- 点击划线可以写感悟、加标签。
- 点击「同步」保存到后端素材库。

### 3. 自动朗读章节

打开服务器书籍后，在阅读页点「工具 → 自动朗读 → 朗读」。后端按当前 EPUB 章节的 href 读取正文，清除 HTML/Markdown/导航内容，按自然段和句子分段；第一段生成后立即播放，后续段在后台继续生成。

- 使用免费的 `edge-tts`，无需 API Key；内置已通过当前声音列表确认的晓晓女声和云希男声。
- 支持 0.75×、1.0×、1.25×、1.5×、2.0×、播放/暂停、上一段/下一段和连续播放。
- 播放位置保存在浏览器 `localStorage`；音频按书籍、章节内容哈希、声音和语速缓存在 `backend/data/tts/`。
- 本机尚未上传成功的书不能朗读，因为章节正文必须由后端从受控书库读取，前端不会提交任意正文。

### 4. AI 问答与稿件生成（可选）

在 `.env` 中配置 OpenAI 兼容的 LLM 接口：

```env
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=deepseek-v4-pro
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=qwen3-embedding:0.6b
```

导入 EPUB 后，后端会异步建立全文向量索引。阅读面板中的「AI 问答」支持严格依据原文回答、连续追问、来源引用和跳转原文。创作面板仍可勾选素材生成视频号或公众号稿件。

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

```text
frontend/          PWA 阅读器 (epub.js + IndexedDB + vanilla JS)
  app.js           主界面入口 + 独立阅读页和创作页
                   素材管理（筛选、勾选、感悟编辑）
                   AI 稿件生成（视频号 + 公众号）
                   Obsidian 导出
backend/           FastAPI
  main.py          路由：health、highlights CRUD、drafts CRUD、script、obsidian export、books
  models.py        Pydantic 数据模型
  database.py      aiosqlite（highlights + drafts 两张表）
  agent.py         短视频脚本生成器（规则引擎）
  llm.py           OpenAI 兼容 LLM 客户端（稿件生成、书籍问答）
  obsidian.py      Markdown 导出（划线素材 + 稿件）
  books_api.py     服务端 EPUB 管理
  tts.py           章节清理/分段、edge-tts 任务、缓存、重试和清理
  config.py        环境变量配置
docs/              架构文档
```

## 页面结构

| 页面 | 功能 |
|------|------|
| **主界面** | 导入 EPUB、浏览书籍，并作为阅读和创作的唯一入口 |
| **阅读页** | 从主界面点击书籍进入；支持 EPUB 阅读、划线、感悟、全文搜索、AI 问答和书签 |
| **创作页** | 从主界面进入；支持素材筛选、AI 生成视频/文章稿件、编辑保存和导出 Obsidian |

阅读页与创作页互不直接跳转，均通过“返回主界面”退出。浏览器前进和后退会遵循相同的页面层级。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_BASE_URL` | OpenAI 兼容 API 地址 | （空） |
| `LLM_API_KEY` | API 密钥 | （空） |
| `LLM_MODEL` | 模型名称 | （空） |
| `EMBEDDING_BASE_URL` | 本地 OpenAI 兼容向量接口 | `http://127.0.0.1:11434/v1` |
| `EMBEDDING_API_KEY` | 向量接口兼容密钥 | `ollama` |
| `EMBEDDING_MODEL` | EPUB 语义索引使用的向量模型 | `qwen3-embedding:0.6b` |
| `LLM_EMBEDDING_MODEL` | 旧版向量模型变量，仅作兼容回退 | （空） |
| `MAX_EPUB_UPLOAD_MB` | AI 索引接受的 EPUB 大小上限 | `100` |
| `OBSIDIAN_VAULT_PATH` | Obsidian 仓库路径 | （空） |
| `DATABASE_URL` | SQLite 数据库路径 | `backend/data/marginalia.db` |
| `TTS_ENABLED` | 启用自动朗读；设为 `false` 可关闭 | `true` |
| `TTS_PROVIDER` | TTS 提供方，目前只允许 `edge-tts` | `edge-tts` |
| `TTS_STORAGE_PATH` | 音频及 `metadata.json` 缓存根目录 | `backend/data/tts` |
| `TTS_DEFAULT_VOICE` | 前端默认声音 | `zh-CN-XiaoxiaoNeural` |
| `TTS_MAX_CONCURRENCY` | 全局同时生成音频段数 | `3` |
| `TTS_MAX_RETRIES` | 单段失败后的最大重试次数 | `3` |
| `TTS_SEGMENT_MAX_CHARS` | 单段最大清理后字符数（100–1500） | `1000` |
| `TTS_REQUEST_TIMEOUT` | 单段生成超时（秒） | `120` |
| `TTS_CACHE_RETENTION_DAYS` | 未访问缓存保留天数 | `30` |
| `TTS_MAX_TASKS_PER_CLIENT` | 单客户端同时生成章节数 | `2` |
| `TTS_CREATE_RATE_LIMIT_PER_MINUTE` | 单客户端每分钟新建/重试限制 | `10` |
| `TTS_MIN_AUDIO_BYTES` | 判定音频文件非空/损坏的最小字节数 | `128` |

## TTS 接口与缓存维护

- `GET /api/tts/voices`：返回精选中文声音白名单。
- `POST /api/books/{book_id}/chapters/{chapter_id}/tts`：创建、命中缓存或合并相同任务；请求体只有 `voice` 和 `rate`。
- `GET /api/tts/tasks/{task_id}`：查询 `pending/generating/completed/failed` 状态和可播放段。
- `GET /api/tts/tasks/{task_id}/segments/{index}`：通过任务范围受控读取 MP3，不接受文件路径。

手动清理超过保留期且不在生成中的缓存：

```bash
cd backend
python tts.py --cleanup
# 临时覆盖保留期：python tts.py --cleanup --days 7
```

常见问题：`edge-tts 未安装` 时重新执行 `pip install -r backend/requirements.txt`；连接失败或超时通常是 Microsoft 在线语音服务不可达，任务会只重试失败段并在页面显示错误；磁盘不足时清理 `backend/data/tts/` 的过期缓存后重试。修改默认声音使用 `TTS_DEFAULT_VOICE`，关闭功能使用 `TTS_ENABLED=false` 并重启服务。

## MVP 路线

- [x] EPUB 阅读 + 本机离线缓存 + 服务器持久书库
- [x] 阅读进度、书签、划线和笔记跨设备自动同步
- [x] 短视频脚本生成（规则引擎）
- [x] AI 增强稿件生成（LLM，视频号 + 公众号）
- [x] Obsidian Markdown 导出
- [x] 服务端 EPUB 上传、哈希去重、索引与全端删除（`/api/books`）
- [x] 创作面板（素材筛选 → 稿件生成 → 编辑 → 导出）
- [x] Docker Compose 一键部署
- [x] edge-tts 按需章节朗读、分段续播和内容哈希缓存
- [ ] 自动同步（Service Worker Background Sync）

## 文档

- [架构概览](docs/ARCHITECTURE.md)
