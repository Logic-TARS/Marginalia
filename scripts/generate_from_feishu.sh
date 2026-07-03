#!/bin/bash
# generate_from_feishu.sh
# End-to-end pipeline: fetch highlights from Feishu Bitable → generate video script
#
# Prerequisites:
#   1. lark-cli configured: npx @larksuite/cli config init
#   2. Set env vars: FEISHU_BASE_TOKEN, FEISHU_TABLE_ID
#
# Usage:
#   ./scripts/generate_from_feishu.sh [book_title]

set -euo pipefail

BOOK_TITLE="${1:-}"

echo "📖 Marginalia — Feishu → Video Script Generator"
echo "================================================"

# Check lark-cli availability
if ! command -v npx &> /dev/null; then
    echo "❌ npx not found — install Node.js first"
    exit 1
fi

# Fetch highlights from Feishu Bitable
echo ""
echo "📡 Fetching highlights from Feishu Bitable..."

if [ -n "$BOOK_TITLE" ]; then
    echo "   Filter: book_title = \"$BOOK_TITLE\""
    # TODO: Replace with actual lark-cli base record-list call
    # RECORDS=$(npx @larksuite/cli base +record-list \
    #   --params "$(jq -n --arg bt "$FEISHU_BASE_TOKEN" --arg ti "$FEISHU_TABLE_ID" \
    #     '{base_token: $bt, table_id: $ti}')" \
    #   --filter "$(jq -n --arg bt "$BOOK_TITLE" \
    #     '{field: "book_title", operator: "is", value: [$bt]}')")
    echo "   ⚠️  lark-cli integration not yet wired — using sample data"
else
    echo "   Fetching all records..."
    echo "   ⚠️  lark-cli integration not yet wired — using sample data"
fi

# Generate script via the Python agent
echo ""
echo "🤖 Generating video script..."
echo ""

# If we have real data, pipe it to agent.py
# For now, run the agent's built-in sample
cd "$(dirname "$0")/../backend"
python3 -c "
from agent import generate_script
import json, sys

# TODO: Replace sample with real data from lark-cli output
sample = [
    {
        'book_title': '沉思录',
        'book_author': '马可·奥勒留',
        'chapter': '卷二',
        'highlight_text': '一日之始就对自己说：我将遇见好管闲事的人、忘恩负义的人、傲慢的人、欺诈的人、嫉妒的人和孤僻的人。',
        'note': '斯多葛派的预演法',
        'tags': ['斯多葛', '心态'],
        'color': 'yellow',
        'progress_percent': 15,
    },
    {
        'book_title': '沉思录',
        'book_author': '马可·奥勒留',
        'chapter': '卷四',
        'highlight_text': '宇宙是变化，人生是看法。',
        'note': '极其浓缩的哲理',
        'tags': ['金句', '哲学'],
        'color': 'blue',
        'progress_percent': 35,
    },
]

result = generate_script(sample)
print(result['script'])
print()
print(f\"⏱  预计时长: {result['duration_estimate_seconds']} 秒\")
print(f\"📝 引用划线: {result['source_count']} 条\")
"

echo ""
echo "✅ Done"
echo ""
echo "📋 Next steps:"
echo "   1. Review the script above"
echo "   2. Paste into your video editor or teleprompter"
echo "   3. Record voiceover following the pacing cues"
echo "   4. Publish with social-auto-upload"
