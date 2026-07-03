# Feishu Integration Setup

## MVP: Custom Bot Webhook (方式 B)

The fastest way to validate the pipeline. Highlights appear as messages in a Feishu group chat.

### Step 1: Create a Feishu Group

1. Open Feishu desktop/mobile app
2. Create a new group chat (e.g., "Marginalia 划线通知")
3. Add any teammates who should see the highlights

### Step 2: Add a Custom Bot

1. In the group chat, click the group name → **Settings** → **Bots**
2. Click **Add Bot** → **Custom Bot**
3. Give it a name (e.g., "Marginalia Bot")
4. Copy the **Webhook URL** — it looks like:
   ```
   https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
5. Click **Add**

### Step 3: Configure the Backend

Add the webhook URL to your `.env` file in the project root:

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
```

### Step 4: Test

1. Start the backend: `cd backend && uvicorn main:app --reload`
2. Sync a highlight from the reader
3. Check the Feishu group — you should see an interactive card with:
   - Book title
   - Highlight text
   - Note (if added)
   - Tags
   - Reading progress

### Troubleshooting

| Problem | Solution |
|---------|----------|
| No message in group | Check `FEISHU_WEBHOOK_URL` is set; check backend logs |
| Card format looks wrong | Feishu card schema may have changed; check [Feishu docs](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/overview) |
| Webhook returns error | Bot may have been removed from group; re-add it |

---

## Future: Bitable Integration (方式 A)

After the webhook pipeline is validated, switch to structured storage in Feishu Bitable (多维表格).

### Setup

1. Create a Feishu app at [Feishu Open Platform](https://open.feishu.cn/app)
2. Enable **Bitable** permissions
3. Get `App ID` and `App Secret`
4. Create a Bitable base and table with these fields:
   - 书名 (text)
   - 作者 (text)
   - 章节 (text)
   - 划线原文 (text)
   - 笔记 (text)
   - 标签 (text)
   - 颜色 (text)
   - 进度% (number)
   - 时间 (datetime)
   - CFI (text)

### Configure lark-cli

```bash
# Install (if not already)
npm install -g @larksuite/cli

# Initialize
lark-cli config init
# Follow prompts to enter App ID and App Secret
```

### Use lark-cli to write records

```bash
# Create a record in Bitable
lark-cli base +record-create \
  --params '{"base_token":"xxx","table_id":"tblxxx"}' \
  --data '{"fields":{"书名":"沉思录","划线原文":"宇宙是变化，人生是看法。"}}'
```

### Automation

Once data is in Bitable, you can:
1. Use Feishu's built-in automation: **多维表格 → 自动化 → Webhook** to trigger your Agent API
2. Or have your Agent poll the Bitable API periodically
3. Or use `lark-cli base +record-list` in a cron job

---

## References

- [Feishu Custom Bot Docs](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [Feishu Card Builder](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/overview)
- [Bitable API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/overview)
