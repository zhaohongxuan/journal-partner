#!/bin/bash

# Journal Partner - Deploy Script
# 构建项目并部署到 Obsidian 插件目录

set -e  # Exit on error

VAULT_PATH="/Users/xuan/Library/Mobile Documents/iCloud~md~obsidian/Documents/xuan"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/journal-partner"

echo "📦 Building Journal Partner..."
npm run build

echo ""
echo "📤 Syncing to Obsidian..."
mkdir -p "$PLUGIN_DIR"
cp main.js "$PLUGIN_DIR/"
cp styles.css "$PLUGIN_DIR/"
cp manifest.json "$PLUGIN_DIR/"

echo ""
echo "✅ Build & Sync complete!"
echo "📍 Installed to: $PLUGIN_DIR"
echo ""
echo "💡 Tip: Reload the plugin in Obsidian (⌘+P → Reload app without saving)"
