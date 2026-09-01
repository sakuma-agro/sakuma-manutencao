/* =====================================================================
   SAKUMA Manutenção — núcleo do aplicativo
   Base local completa em IndexedDB + fila de saída (outbox) + sincronização.
   Regra: nada é considerado salvo até o servidor confirmar.
   ===================================================================== */

const App = {
  sb: null,            // cliente Supabase
  usuario: null,       // registro da tabela usuarios
  locais: [],          // locais que o usuário enxerga
  dados: {},           // cópia em memória da base local, para a tela renderizar rápido
  online: navigator.onLine,
  pendentes: 0
};

/* Tabelas que o app baixa inteiras para funcionar sem sinal.
   Sem isto o mecânico abre a OS no pátio e não vê o código da peça. */
const TABELAS_BASE = [
  'locais', 'setores', 'tipos_equipamento', 'campos_tecnicos', 'tipos_manutencao',
  'marcas', 'fornecedores', 'mecanicos', 'listas_auxiliares', 'parametros',
  'equipamentos', 'pecas', 'pecas_equipamento', 'planos_manutencao',
  'checklist_modelos',
  // Etapa 3: o mecânico precisa abrir a OS no pátio, sem sinal.
  'ordens_servico', 'os_itens', 'os_pecas', 'manutencoes', 'anomalias'
];

/* ---------------------------------------------------------------- IndexedDB */
let idb = null;

function abrirBase() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open('sakuma-manutencao', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) {
        const s = db.createObjectStore('cache', { keyPath: ['tabela', 'id'] });
        s.createIndex('por_tabela', 'tabela');
      }
      if (!db.objectStoreNames.contains('fila')) {
        db.createObjectStore('fila', { keyPath: 'uuid' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'chave' });
      }
      // Fotos ficam guardadas como Blob até o servidor confirmar o envio.
      if (!db.objectStoreNames.contains('fotos')) {
        db.createObjectStore('fotos', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { idb = req.result; ok(idb); };
    req.onerror = () => erro(req.error);
  });
}

function tx(store, modo = 'readonly') {
  return idb.transaction(store, modo).objectStore(store);
}

function promessa(req) {
  return new Promise((ok, erro) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

/* A tabela parametros tem "chave" como identificador, não "id". */
const CHAVE_PK = { parametros: 'chave' };
function pk(tabela) { return CHAVE_PK[tabela] || 'id'; }
function idDe(tabela, registro) { return registro[pk(tabela)]; }

async function gravarLocal(tabela, linhas) {
  const s = tx('cache', 'readwrite');
  for (const l of linhas) s.put({ tabela, id: idDe(tabela, l), dado: l });
  return new Promise(ok => { s.transaction.oncomplete = () => ok(true); });
}

async function lerLocal(tabela) {
  const s = tx('cache').index('por_tabela');
  const res = await promessa(s.getAll(tabela));
  return res.map(r => r.dado);
}

async function meta(chave, valor) {
  if (valor === undefined) {
    const r = await promessa(tx('meta').get(chave));
    return r ? r.valor : null;
  }
  return promessa(tx('meta', 'readwrite').put({ chave, valor }));
}

/* ---------------------------------------------------------------- fila de saída */

/* Todo registro feito offline entra aqui com identificador próprio gerado no
   aparelho e carimbo do PREENCHIMENTO — não do envio. */
async function enfileirar(tabela, registro, operacao = 'upsert') {
  const item = {
    uuid: tabela + ':' + (idDe(tabela, registro) || crypto.randomUUID()),
    tabela, operacao, registro,
    preenchido_em: new Date().toISOString(),
    status: 'pendente',
    tentativas: 0,
    erro: null
  };
  await promessa(tx('fila', 'readwrite').put(item));
  await contarFila();
  sincronizar();          // tenta na hora; se não der, fica na fila
  return item;
}

async function itensDaFila() {
  return promessa(tx('fila').getAll());
}

async function contarFila() {
  const itens = await itensDaFila();
  let fotos = 0;
  try { fotos = (await promessa(tx('fotos').getAll())).filter(f => f.status !== 'enviada').length; }
  catch (e) { /* base antiga, sem a store de fotos */ }
  App.pendentes = itens.filter(i => i.status !== 'enviado').length + fotos;
  pintarEstado();
  return App.pendentes;
}

let sincronizando = false;

/* Envia a fila. Idempotente: o mesmo item reenviado usa o mesmo id,
   então o upsert no servidor não duplica. */
async function sincronizar() {
  if (sincronizando || !App.online || !App.sb || !App.usuario) return;
  sincronizando = true;
  try {
    const itens = (await itensDaFila()).filter(i => i.status !== 'enviado');
    for (const item of itens) {
      try {
        let r;
        if (item.operacao === 'upsert') {
          r = await App.sb.from(item.tabela)
                .upsert(item.registro, { onConflict: pk(item.tabela) });
        } else if (item.operacao === 'excluir') {
          // Cadastro em uso nunca é apagado: "excluir" aqui é inativar.
          r = await App.sb.from(item.tabela).update({ ativo: false })
                .eq(pk(item.tabela), idDe(item.tabela, item.registro));
        }
        if (r.error) throw r.error;
        // Só sai da fila depois do OK do servidor.
        await promessa(tx('fila', 'readwrite').delete(item.uuid));
      } catch (e) {
        item.status = 'erro';
        item.tentativas += 1;
        item.erro = e.message || String(e);
        await promessa(tx('fila', 'readwrite').put(item));
      }
    }
  } finally {
    sincronizando = false;
    await contarFila();
  }
}

/* ---------------------------------------------------------------- fotos

   A foto do adesivo é obrigatória para concluir a OS. Ela é comprimida no
   aparelho, guardada como Blob e só sobe depois — uma por vez, para não
   travar em conexão fraca de fazenda. */

async function comprimirFoto(arquivo, larguraMax = 1600) {
  const bitmap = await createImageBitmap(arquivo);
  const escala = Math.min(1, larguraMax / bitmap.width);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bitmap.width * escala);
  cv.height = Math.round(bitmap.height * escala);
  cv.getContext('2d').drawImage(bitmap, 0, 0, cv.width, cv.height);
  return new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.82));
}

/* Guarda a foto no aparelho e devolve o caminho que ela terá no Storage. */
async function guardarFoto(arquivo, bucket, prefixo) {
  const blob = await comprimirFoto(arquivo);
  const id = crypto.randomUUID();
  const caminho = prefixo + '/' + id + '.jpg';
  await promessa(tx('fotos', 'readwrite').put({
    id, bucket, caminho, blob, status: 'pendente',
    registrado_em: new Date().toISOString()
  }));
  await contarFila();
  enviarFotos();
  return caminho;
}

async function fotosPendentes() {
  const todas = await promessa(tx('fotos').getAll());
  return todas.filter(f => f.status !== 'enviada');
}

let enviandoFotos = false;
async function enviarFotos() {
  if (enviandoFotos || !App.online || !App.sb) return;
  enviandoFotos = true;
  try {
    for (const f of await fotosPendentes()) {
      const { error } = await App.sb.storage.from(f.bucket)
        .upload(f.caminho, f.blob, { contentType: 'image/jpeg', upsert: true });
      if (!error || (error.message || '').includes('already exists')) {
        f.status = 'enviada';
        await promessa(tx('fotos', 'readwrite').put(f));
      }
    }
  } finally {
    enviandoFotos = false;
    await contarFila();
  }
}

/* ---------------------------------------------------------------- gravação */

/* Grava um registro: aplica na base local na hora (o usuário vê o resultado
   mesmo sem sinal) e põe na fila para subir. */
async function gravar(tabela, registro) {
  const chave = pk(tabela);
  if (!registro[chave]) registro[chave] = crypto.randomUUID();
  await gravarLocal(tabela, [registro]);
  const lista = App.dados[tabela] || [];
  const i = lista.findIndex(x => x[chave] === registro[chave]);
  if (i >= 0) lista[i] = registro; else lista.push(registro);
  App.dados[tabela] = lista;
  await enfileirar(tabela, registro);
  return registro;
}

async function inativar(tabela, id) {
  const reg = (App.dados[tabela] || []).find(x => x[pk(tabela)] === id);
  if (reg) { reg.ativo = false; await gravar(tabela, reg); }
}

/* ---------------------------------------------------------------- carga da base */

async function baixarBase(forcar = false) {
  if (!App.online) return false;
  const versao = await meta('versao_base');
  const baixadaEm = await meta('baixada_em');
  const recente = baixadaEm && (Date.now() - new Date(baixadaEm).getTime() < 6 * 3600 * 1000);
  if (!forcar && recente && versao === CONFIG.VERSAO_BASE) return false;

  for (const t of TABELAS_BASE) {
    const { data, error } = await App.sb.from(t).select('*');
    if (error) { console.warn('não baixou', t, error.message); continue; }
    await gravarLocal(t, data);
    App.dados[t] = data;
  }
  await meta('versao_base', CONFIG.VERSAO_BASE);
  await meta('baixada_em', new Date().toISOString());
  return true;
}

async function carregarDaBaseLocal() {
  for (const t of TABELAS_BASE) App.dados[t] = await lerLocal(t);
}

/* ---------------------------------------------------------------- consultas */

const q = {
  ativos: t => (App.dados[t] || []).filter(x => x.ativo !== false),
  todos:  t => (App.dados[t] || []),
  por_id: (t, id) => (App.dados[t] || []).find(x => x.id === id),
  nome:   (t, id) => { const r = q.por_id(t, id); return r ? (r.nome || r.descricao) : ''; },
  ordenado: (t, campo = 'nome') =>
    q.ativos(t).slice().sort((a, b) => String(a[campo] || '').localeCompare(String(b[campo] || ''), 'pt-BR'))
};

/* ---------------------------------------------------------------- interface */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let avisoTimer;
function aviso(texto, erro = false) {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = 'aviso' + (erro ? ' erro' : '');
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.add('oculto'), 3600);
}

function abrirModal(titulo, html, aoAbrir) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = html;
  $('#modal').classList.remove('oculto');
  if (aoAbrir) aoAbrir($('#modal-corpo'));
}
function fecharModal() {
  $('#modal').classList.add('oculto');
  $('#modal-corpo').innerHTML = '';
}

function pintarEstado() {
  const ponto = $('#ponto-conexao'), txt = $('#txt-conexao'), fila = $('#btn-fila');
  ponto.className = 'ponto ' + (App.online ? 'online' : 'offline');
  txt.textContent = App.online ? 'conectado' : 'sem internet';
  if (App.pendentes > 0) {
    fila.textContent = App.pendentes + (App.pendentes === 1
      ? ' registro aguardando envio' : ' registros aguardando envio');
    fila.classList.remove('oculto');
  } else {
    fila.classList.add('oculto');
  }
}

/* ---------------------------------------------------------------- fila: tela */
async function telaFila() {
  const itens = await itensDaFila();
  const html = itens.length === 0
    ? '<div class="vazio"><p>Nada esperando. Tudo que você registrou já está no servidor.</p></div>'
    : '<ul class="lista">' + itens.map(i => `
        <li>
          <div class="info">
            <strong>${esc(i.tabela)}</strong>
            <small>preenchido em ${new Date(i.preenchido_em).toLocaleString('pt-BR')}</small>
            ${i.erro ? `<small style="color:var(--urgente)">${esc(i.erro)}</small>` : ''}
          </div>
          <span class="etq ${i.status === 'erro' ? 'urgente' : 'atencao'}">${esc(i.status)}</span>
        </li>`).join('') + '</ul>'
      + '<div class="acoes"><button type="button" class="btn" id="btn-sinc">Sincronizar agora</button></div>';
  abrirModal('Registros aguardando envio', html, corpo => {
    const b = corpo.querySelector('#btn-sinc');
    if (b) b.onclick = async () => {
      if (!App.online) return aviso('Sem internet. A fila sobe sozinha quando o sinal voltar.', true);
      await sincronizar();
      aviso(App.pendentes === 0 ? 'Tudo enviado.' : 'Ainda restam ' + App.pendentes + '.');
      telaFila();
    };
  });
}

/* ---------------------------------------------------------------- login */

function telaLogin(mensagem) {
  $('#menu').hidden = true;
  $('#tela').innerHTML = `
    <h1>Entrar</h1>
    <p class="sub">Use o e-mail e a senha cadastrados por quem administra o app.</p>
    ${mensagem ? `<p class="sub" style="color:var(--urgente)">${esc(mensagem)}</p>` : ''}
    <div style="max-width:400px">
      <div class="campo"><label for="lg-email">E-mail</label>
        <input type="email" id="lg-email" autocomplete="username"></div>
      <div class="campo"><label for="lg-senha">Senha</label>
        <input type="password" id="lg-senha" autocomplete="current-password"></div>
      <button type="button" class="btn" id="lg-entrar">Entrar</button>
    </div>`;
  $('#lg-entrar').onclick = entrar;
  $('#lg-senha').onkeydown = e => { if (e.key === 'Enter') entrar(); };
}

async function entrar() {
  const email = $('#lg-email').value.trim(), senha = $('#lg-senha').value;
  if (!email || !senha) return aviso('Preencha e-mail e senha.', true);
  if (!App.online) return aviso('A primeira entrada precisa de internet.', true);
  $('#lg-entrar').disabled = true;
  const { error } = await App.sb.auth.signInWithPassword({ email, password: senha });
  $('#lg-entrar').disabled = false;
  if (error) return telaLogin('E-mail ou senha não conferem.');
  iniciarSessao();
}

async function sair() {
  if (App.pendentes > 0 &&
      !confirm(`Há ${App.pendentes} registro(s) que ainda não subiram. Sair mesmo assim?`)) return;
  await App.sb.auth.signOut();
  location.reload();
}

async function iniciarSessao() {
  const { data: sessao } = await App.sb.auth.getSession();
  if (!sessao || !sessao.session) { telaLogin(); return; }

  // Quem é o usuário e quais locais ele enxerga
  const { data: u } = await App.sb.from('usuarios')
    .select('*').eq('id', sessao.session.user.id).maybeSingle();
  App.usuario = u || { nome: sessao.session.user.email, perfil: 'CONSULTA' };
  await meta('usuario', App.usuario);

  $('#btn-sair').classList.remove('oculto');
  $('#menu').hidden = false;

  $('#tela').innerHTML = '<section class="carregando"><p>Baixando os cadastros para uso sem internet…</p></section>';
  await baixarBase();
  await carregarDaBaseLocal();

  // O usuário precisa enxergar em qual local está trabalhando.
  const locais = q.ativos('locais');
  $('#lbl-local').textContent = App.usuario.perfil === 'ADMINISTRADOR'
    ? 'Todos os locais'
    : locais.map(l => l.nome).join(' · ');

  irPara('inicio');
  sincronizar();
}

/* ---------------------------------------------------------------- navegação */

function irPara(nome) {
  $$('.menu button').forEach(b => b.classList.toggle('ativo', b.dataset.tela === nome));
  const fn = TELAS[nome];
  if (fn) fn($('#tela'));
}

/* ---------------------------------------------------------------- partida */

window.addEventListener('online',  () => { App.online = true;  pintarEstado(); sincronizar(); enviarFotos(); });
window.addEventListener('offline', () => { App.online = false; pintarEstado(); });

window.addEventListener('beforeunload', e => {
  if (App.pendentes > 0) { e.preventDefault(); e.returnValue = ''; }
});

let promptInstalar = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); promptInstalar = e;
  $('#btn-instalar').classList.remove('oculto');
});

document.addEventListener('DOMContentLoaded', async () => {
  $('#modal-fechar').onclick = fecharModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') fecharModal(); });
  $('#btn-fila').onclick = telaFila;
  $('#btn-sair').onclick = sair;
  $('#btn-instalar').onclick = async () => {
    if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; $('#btn-instalar').classList.add('oculto'); }
    else abrirModal('Instalar no iPhone',
      '<p>No iPhone a instalação é pelo Safari: toque em <strong>Compartilhar</strong> e depois em ' +
      '<strong>Adicionar à Tela de Início</strong>. O app abre em janela própria, sem a barra do navegador.</p>');
  };
  $$('.menu button').forEach(b => b.onclick = () => irPara(b.dataset.tela));

  pintarEstado();
  await abrirBase();
  await contarFila();

  if (CONFIG.SUPABASE_URL.includes('COLE-AQUI')) {
    $('#tela').innerHTML = `<h1>Falta configurar o Supabase</h1>
      <p class="sub">Abra o arquivo <code>js/config.js</code> e cole a URL do projeto e a chave
      <em>anon public</em>. Elas estão em Supabase → Project Settings → API.</p>`;
    return;
  }

  App.sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY,
    { db: { schema: CONFIG.SCHEMA || 'public' } });
  await carregarDaBaseLocal();
  iniciarSessao();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const novo = reg.installing;
        novo.addEventListener('statechange', () => {
          if (novo.state === 'installed' && navigator.serviceWorker.controller) {
            aviso('Nova versão disponível. Feche e abra o app para atualizar.');
          }
        });
      });
    });
  }
});

/* Os arquivos são scripts clássicos: `const` no topo não vira propriedade de
   window. Publico o que telas.js usa, para a ordem de carga não importar. */
Object.assign(window, {
  App, q, $, $$, esc, aviso, abrirModal, fecharModal,
  gravar, inativar, irPara, sincronizar, pk,
  guardarFoto, enviarFotos
});
