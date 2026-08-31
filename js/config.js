/* =====================================================================
   CONFIGURAÇÃO — o único arquivo que o Guilherme precisa editar.
   Pegue os dois valores em: Supabase → Project Settings → API.
   A chave "anon public" pode ficar aqui: ela é pública de propósito e
   quem protege os dados é o Row Level Security, no banco.
   ===================================================================== */
window.CONFIG = {
  SUPABASE_URL: 'https://COLE-AQUI.supabase.co',
  SUPABASE_ANON_KEY: 'COLE-AQUI-A-CHAVE-ANON',

  // O app divide o projeto Supabase com o app de vistorias, então as tabelas
  // dele ficam no schema "manutencao". Precisa estar em Settings → API →
  // Exposed schemas, senão toda consulta volta vazia.
  SCHEMA: 'manutencao',

  // Versão da base local. Mudar este número força o app a baixar
  // os cadastros de novo na próxima entrada com internet.
  VERSAO_BASE: 1
};
