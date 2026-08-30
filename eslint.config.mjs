// ESLint flat config — uses the official Obsidian plugin guidelines.
// Docs: https://github.com/obsidianmd/eslint-plugin
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "main.js", "styles.css"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
  {
    // The WeChat transport is desktop-only and dynamically imports Node HTTPS
    // after checking Platform.isDesktopApp. The rest of the plugin remains
    // mobile-safe, so the blanket mobile rule is not applicable to this file.
    files: ["src/wechat.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
]);
