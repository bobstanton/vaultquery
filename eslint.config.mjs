import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";
import obsidianExtras from "eslint-plugin-obsidian-extras";

// Merge obsidian-extras rules into obsidianmd namespace so eslint-disable comments work
const mergedPlugin = {
  ...obsidianmd,
  rules: {
    ...obsidianmd.rules,
    ...obsidianExtras.rules,
  },
};

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
      obsidianmd: mergedPlugin,
      "@typescript-eslint": tseslint,
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

      // Core ESLint rules (Obsidian submission requirements)
      "no-var": "error",
      "no-console": ["warn", {
        "allow": ["warn", "error", "debug"],
      }],
      "no-useless-escape": "warn",
      "prefer-object-has-own": "warn",
      "no-restricted-globals": ["error",
        { "name": "alert", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "confirm", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "prompt", "message": "Use Obsidian's Modal API instead of native dialogs." },
        { "name": "localStorage", "message": "Use App.loadLocalStorage()/saveLocalStorage() instead." },
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
      "obsidianmd/no-obsidian-branding": "warn",

      // Type safety
      "obsidianmd/no-tfile-tfolder-cast": "warn",

      // iOS compatibility - critical for mobile
      "obsidianmd/regex-lookbehind": "error",

      // Performance best practices
      "obsidianmd/vault/iterate": "warn",
      "obsidianmd/vault/prefer-cached-read": "warn",

      // Obsidian API preferences
      "obsidianmd/prefer-obsidian-debounce": "warn",
      "obsidianmd/prefer-active-window": "warn",
      "obsidianmd/prefer-active-view-of-type": "warn",
      "obsidianmd/prefer-process-front-matter": "warn",
      "obsidianmd/prefer-stringify-yaml": "warn",
      "obsidianmd/prefer-editor-api": "warn",
      "obsidianmd/prefer-window-timers": "warn",
      "obsidianmd/use-normalize-path": "warn",
      "obsidianmd/prefer-abstract-input-suggest": "warn",
      "obsidianmd/prefer-instance-of": "warn",
      "obsidianmd/object-assign": "warn",
      "obsidianmd/hardcoded-config-path": "warn",
      "obsidianmd/editor-event-prevent-default": "warn",

      // Code quality
      "obsidianmd/no-empty-catch": "warn",
      "obsidianmd/no-object-to-string": "warn",

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
  // Disable sentence-case for help processor files (intentionally use title case for headings)
  {
    files: ["**/HelpBlockProcessor.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": "off",
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
    },
  },
  {
    ignores: ["node_modules/**", "main.js", "*.js", "*.mjs", "*.d.ts"],
  },
];
