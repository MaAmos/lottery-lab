import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  // server: {
  //   proxy: {
  //     "/api": {
  //       target: "http://localhost:8787", // Local Worker
  //       changeOrigin: true,
  //     },
  //   },
  // },
});
