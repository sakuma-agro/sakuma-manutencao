/* =====================================================================
   CONFIGURAÇÃO — o único arquivo que o Guilherme precisa editar.
   Pegue os dois valores em: Supabase → Project Settings → API.
   A chave "anon public" pode ficar aqui: ela é pública de propósito e
   quem protege os dados é o Row Level Security, no banco.
   ===================================================================== */
window.CONFIG = {
  SUPABASE_URL: 'https://jhwnmtekxsdkhvgcjzhj.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impod25tdGVreHNka2h2Z2NqemhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MzY4NTksImV4cCI6MjEwMzMxMjg1OX0.L6kwNPBh6K0snxrLahv3WnU1WGHSEeTA8WzMbOXprqk',

  // O app divide o projeto Supabase com o app de vistorias, então as tabelas
  // dele ficam no schema "manutencao". Precisa estar em Settings → API →
  // Exposed schemas, senão toda consulta volta vazia.
  SCHEMA: 'manutencao',

  // Versão da base local. Mudar este número força o app a baixar
  // os cadastros de novo na próxima entrada com internet.
  VERSAO_BASE: 1
};
