import { defineConfig } from "vitest/config"
import stringPlugin from "vite-plugin-string";
import checker from 'vite-plugin-checker'


export default defineConfig({
    build: {
        ssr: true,
        lib: {
            entry: "./src/index.ts",
            formats: ["es"],
        },
        rollupOptions: {
            external: [],
        },
        sourcemap: true,
    },
    test: {
        environment: "node"
    },
    plugins: [
        checker({
            typescript: true
        }),
        stringPlugin({
            include: "**/*.graphql",
            compress: false
        }),
    ]
});
