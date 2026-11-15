import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import purgeCSS from "@fullhuman/postcss-purgecss";

export default defineConfig(({ command }) => ({
    root: fileURLToPath(new URL("./web/", import.meta.url)),
    appType: "mpa",
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    css: {
        postcss: {
            plugins:
                command === "build"
                    ? [
                          purgeCSS({
                              content: [
                                  fileURLToPath(new URL("./web/**/*.{html,js}", import.meta.url)),
                                  fileURLToPath(new URL("./src/Documents.ts", import.meta.url)),
                              ],
                              defaultExtractor: (content) => content.match(/[A-Za-z0-9_-]+/gu) ?? [],
                              safelist: { standard: [/^:/u], deep: [/aria-/u, /data-/u] },
                              variables: true,
                              keyframes: true,
                          }),
                      ]
                    : [],
        },
    },
    build: {
        target: "esnext",
        license: { fileName: "vendor/DEPENDENCIES-LICENSE.txt" },
        modulePreload: { polyfill: false },
        outDir: fileURLToPath(new URL("./dist/client/", import.meta.url)),
        emptyOutDir: true,
    },
}));
