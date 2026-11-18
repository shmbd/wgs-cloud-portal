import { defineConfig } from "vite";
import netlify from "@netlify/vite-plugin";

export default defineConfig({
  plugins: [netlify()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
