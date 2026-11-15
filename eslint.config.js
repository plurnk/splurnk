import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import otm from "on_the_money/eslint-config";
import noUnsanitized from "eslint-plugin-no-unsanitized";

// {§splurnk-http-lifecycle} Gate JavaScript and browser OTM authoring boundaries at lint time.
export default defineConfig(
    {
        ignores: [
            "dist/**",
            "data/**",
            "node_modules/**",
            "web/public/**",
            "playwright-report*/**",
            "test-results*/**",
            "**/*.ts",
            "**/*.d.ts",
        ],
    },
    {
        files: ["**/*.{js,mjs}"],
        extends: [js.configs.recommended],
        linterOptions: { reportUnusedDisableDirectives: "error" },
        rules: {
            "no-var": "error",
            "prefer-const": "error",
            "no-throw-literal": "error",
            "eqeqeq": ["error", "always", { null: "ignore" }],
            "no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", caughtErrors: "all", ignoreRestSiblings: true },
            ],
        },
    },
    {
        files: ["*.js"],
        languageOptions: { globals: globals.nodeBuiltin },
    },
    {
        files: ["web/**/*.js"],
        languageOptions: { globals: globals.browser },
        extends: [otm, noUnsanitized.configs.recommended],
    },
);
