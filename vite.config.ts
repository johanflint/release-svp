import { configDefaults, defineConfig } from "vitest/config"
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
        environment: "node",
        // Integration tests (test/integration/**) run under their own config via `npm run test:integration` —
        // they're slower (they drive a real in-process HTTP fake) and deliberately opt-in, not part of the
        // fast default `npm test` unit-test run. See vitest.integration.config.ts.
        exclude: [...configDefaults.exclude, "test/integration/**"],
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
