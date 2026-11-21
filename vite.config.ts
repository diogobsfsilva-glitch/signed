import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// As variáveis definidas na plataforma de build (Cloudflare) têm prioridade sobre os ficheiros
// .env.*. Se uma vier estragada (ex.: chave copiada já mascarada com "•••"), é ignorada e usa-se
// o valor público de .env.production, que está no repositório.
const VALID: Record<string, RegExp> = {
  VITE_SUPABASE_URL: /^https?:\/\/[A-Za-z0-9.:-]+\/?$/,
  VITE_SUPABASE_ANON_KEY: /^[A-Za-z0-9._-]{20,}$/,
};
for (const [name, re] of Object.entries(VALID)) {
  const v = process.env[name];
  if (v !== undefined && !re.test(v.trim())) {
    console.warn(`\n⚠ ${name} definida no ambiente de build é inválida e foi ignorada (usa-se o ficheiro .env).\n`);
    delete process.env[name];
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173 },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
