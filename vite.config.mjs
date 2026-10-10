import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'";

const CSP_DEV =
  "default-src 'self' http://localhost:5173 http://127.0.0.1:5173; " +
  "script-src 'self' 'unsafe-inline' http://localhost:5173 http://127.0.0.1:5173; " +
  "style-src 'self' 'unsafe-inline' http://localhost:5173 http://127.0.0.1:5173; " +
  "img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173; object-src 'none'";

export default defineConfig(({ command }) => ({
  // The built app is loaded from file://, so every asset must be relative.
  base: "./",
  root: "src",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "csp-meta",
      transformIndexHtml: (html) =>
        html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${command === "build" ? CSP_PROD : CSP_DEV}" />`),
    },
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "../out", emptyOutDir: true },
}));
