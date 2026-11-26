import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Module workers (the pdf.js worker of the /pdf editor) are emitted as ES modules with a .js extension,
  // which every web server serves with a JavaScript MIME type (a .mjs file is not in stock nginx's table).
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
