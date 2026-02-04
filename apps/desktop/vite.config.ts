import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: true,
    port: 1420,
    strictPort: true,
    allowedHosts: true
  }
});
