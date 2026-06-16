import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";
import sdl from "@microsoft/eslint-plugin-sdl";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        ecmaVersion: 2020,
        sourceType: "module",
      },
    },
    plugins: {
      obsidianmd,
      "@typescript-eslint": tseslint,
      "@microsoft/sdl": sdl,
    },
    rules: {
      // TypeScript strict rules (Obsidian submission requirements)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-expect-error": "allow-with-description",
      }],
      "@typescript-eslint/no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
      }],
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/unbound-method": ["warn", {
        "ignoreStatic": true,
      }],
      "@typescript-eslint/no-this-alias": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-misused-promises": ["error", {
        "checksVoidReturn": {
          "arguments": true,
          "attributes": false,
        }
      }],

      // Security rules (critical for plugin approval)
      "@microsoft/sdl/no-inner-html": "error",
      "@microsoft/sdl/no-document-write": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Import restrictions (mobile compatibility & best practices)
      "no-restricted-imports": ["error", {
        paths: [
          { "name": "axios", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "superagent", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "got", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "ofetch", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "ky", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "node-fetch", "message": "Use Obsidian's requestUrl() instead." },
          { "name": "moment", "message": "Import moment from 'obsidian' - it's bundled." },
          { "name": "fs", "message": "Node modules are not available on mobile." },
          { "name": "path", "message": "Node modules are not available on mobile." },
          { "name": "os", "message": "Node modules are not available on mobile." },
          { "name": "crypto", "message": "Node modules are not available on mobile." },
          { "name": "child_process", "message": "Node modules are not available on mobile." },
          { "name": "stream", "message": "Node modules are not available on mobile." },
          { "name": "util", "message": "Node modules are not available on mobile." },
          { "name": "buffer", "message": "Node modules are not available on mobile." },
          { "name": "url", "message": "Node modules are not available on mobile." },
        ],
        patterns: [
          { group: ["node:*"], message: "Node modules are not available on mobile." },
        ],
      }],

      // Core ESLint rules (Obsidian submission requirements)
      "no-var": "error",
      "no-console": ["warn", {
        "allow": ["warn", "error", "debug"],
      }],
      "no-useless-escape": "warn",
      "prefer-object-has-own": "warn",
      "no-alert": "error",
      "no-implicit-globals": "error",
      "no-self-compare": "warn",
      "no-restricted-globals": ["error",
        { "name": "app", "message": "Use this.app from your plugin instance instead of the global app object." },
        { "name": "alert", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "confirm", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "prompt", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "localStorage", "message": "Use App.loadLocalStorage()/saveLocalStorage() instead." },
        { "name": "fetch", "message": "Use Obsidian's requestUrl() function instead of fetch." },
      ],

      // Sample code detection
      "obsidianmd/no-sample-code": "error",
      "obsidianmd/sample-names": "error",

      // Command naming
      "obsidianmd/commands/no-command-in-command-id": "warn",
      "obsidianmd/commands/no-command-in-command-name": "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id": "warn",
      "obsidianmd/commands/no-plugin-name-in-command-name": "warn",
      "obsidianmd/commands/no-default-hotkeys": "warn",

      // Memory leak prevention
      "obsidianmd/no-plugin-as-component": "error",
      "obsidianmd/no-view-references-in-plugin": "error",
      "obsidianmd/detach-leaves": "error",

      // Best practices
      "obsidianmd/prefer-file-manager-trash-file": "warn",
      "obsidianmd/no-forbidden-elements": "error",
      "obsidianmd/no-static-styles-assignment": "warn",
      "obsidianmd/platform": "warn",

      // Type safety
      "obsidianmd/no-tfile-tfolder-cast": "warn",

      // iOS compatibility - critical for mobile
      "obsidianmd/regex-lookbehind": "error",

      // Performance best practices
      "obsidianmd/vault/iterate": "warn",

      // Obsidian API preferences
      "obsidianmd/prefer-abstract-input-suggest": "warn",
      "obsidianmd/object-assign": "warn",
      "obsidianmd/hardcoded-config-path": "warn",

      // Settings tab
      "obsidianmd/settings-tab/no-manual-html-headings": "warn",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "warn",

      // UI text
      "obsidianmd/ui/sentence-case": "warn",

      // Validation
      "obsidianmd/validate-manifest": "warn",
      "obsidianmd/validate-license": "warn",
    },
  },
  // Generated help files - inline comments handle most rules, these cover the rest
  {
    files: ["**/generated-help/**/*.ts"],
    rules: {
      // Generated files may have unused ctx parameter when no dynamic content
      "@typescript-eslint/no-unused-vars": "off",
      // Help text mentions .obsidian as example path (documentation, not code)
      "obsidianmd/hardcoded-config-path": "off",
      // Generated help uses fire-and-forget pattern for MarkdownRenderer
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    ignores: ["node_modules/**", "main.js", "*.js", "*.mjs", "*.d.ts"],
  },
];
