/* =====================================================================
   SAKUMA Manutenção — etapa 4: CHECK LIST DE CAMPO

   O operador preenche no celular (sem sinal), o app:
     1. salva o check list com as respostas congeladas (texto do item de hoje);
     2. abre uma anomalia para cada item reprovado, sem duplicar reincidência;
     3. gera o relatório A4 com as não conformidades PRIMEIRO;
     4. manda ao responsável pela manutenção por WhatsApp.
   A mesma folha sai impressa em branco para quem prefere marcar no papel.
   ===================================================================== */

/* ---------------------------------------------------------------- escalas */

/* Cada tipo de resposta tem suas opções. "grau" é o que o app usa para contar
   e para decidir anomalia: bom / medio / ruim / na (não se aplica). */
const ESCALAS = {
  ESCALA_BMR:   [{ v: 'BOM', rot: 'BOM', grau: 'bom' }, { v: 'MEDIO', rot: 'MÉDIO', grau: 'medio' }, { v: 'RUIM', rot: 'RUIM', grau: 'ruim' }],
  OK_REPARO_NA: [{ v: 'OK', rot: 'OK', grau: 'bom' }, { v: 'REPARO', rot: 'Necessita reparo', grau: 'ruim' }, { v: 'NA', rot: 'Não se aplica', grau: 'na' }],
  SIM_NAO:      [{ v: 'SIM', rot: 'Sim', grau: 'bom' }, { v: 'NAO', rot: 'Não', grau: 'ruim' }],
  CONFORME:     [{ v: 'CONFORME', rot: 'Conforme', grau: 'bom' }, { v: 'NAO_CONFORME', rot: 'Não conforme', grau: 'ruim' }]
};
const ROTULO_ESCALA = {
  ESCALA_BMR: ['BOM', 'MÉDIO', 'RUIM'], OK_REPARO_NA: ['OK', 'Nec. reparo', 'N/A'],
  SIM_NAO: ['Sim', 'Não', ''], CONFORME: ['Conforme', 'Não conf.', '']
};

function opcaoDe(item, valor) {
  return (ESCALAS[item.tipo_resposta] || []).find(o => o.v === valor) || null;
}
function grauDe(item, valor) {
  const o = opcaoDe(item, valor); return o ? o.grau : (valor ? 'info' : null);
}
function rotuloResposta(item, valor) {
  const o = opcaoDe(item, valor); return o ? o.rot : (valor ?? '');
}

/* Regra da anomalia: RUIM (ou equivalente) sempre abre; MÉDIO abre se o
   parâmetro mandar; Sim/Não só quando o item diz qual resposta reprova. */
function geraAnomalia(item, valor) {
  if (!valor) return false;
  const grau = grauDe(item, valor);
  if (item.tipo_resposta === 'SIM_NAO') return !!item.gera_anomalia_se && item.gera_anomalia_se === valor;
  if (grau === 'ruim') return true;
  if (grau === 'medio') return parametro('anomalia_gera_medio', 'false') === 'true';
  return false;
}

function parametro(chave, padrao) {
  const p = q.todos('parametros').find(x => x.chave === chave);
  return p && p.valor != null ? p.valor : padrao;
}
function hoje() { return new Date().toISOString().slice(0, 10); }
function somarDias(data, n) {
  const d = new Date(data + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) { // b - a, em dias
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

/* ---------------------------------------------------------------- modelo × máquina */

/* Qual modelo esta máquina usa: o vínculo direto ganha do padrão do tipo. */
function modeloDaMaquina(e) {
  const vinc = q.todos('checklist_equipamento').find(v => v.equipamento_id === e.id);
  let modelo = vinc ? q.por_id('checklist_modelos', vinc.modelo_id) : null;
  if (!modelo || modelo.ativo === false)
    modelo = q.ativos('checklist_modelos').find(m => m.tipo_equipamento_id === e.tipo_equipamento_id) || null;
  return { modelo, vinculo: vinc || null };
}
function versaoVigente(modeloId) {
  const vs = q.todos('checklist_versoes').filter(v => v.modelo_id === modeloId);
  return vs.find(v => v.vigente) || vs.sort((a, b) => (b.versao || 0) - (a.versao || 0))[0] || null;
}
function gruposDaVersao(versaoId) {
  return q.ativos('checklist_grupos').filter(g => g.versao_id === versaoId)
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
}
function itensDoGrupo(grupoId) {
  return q.ativos('checklist_itens').filter(i => i.grupo_id === grupoId)
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
}
/* A definição mais específica ganha: máquina > modelo > parâmetro geral. */
function periodicidadeDias(e, modelo, vinculo) {
  if (vinculo && vinculo.periodicidade_dias) return Number(vinculo.periodicidade_dias);
  if (modelo && modelo.periodicidade_dias) return Number(modelo.periodicidade_dias);
  return Number(parametro('prazo_checklist_dias', 10)) || 10;
}
function ultimoChecklist(eId) {
  return q.todos('checklists').filter(c => c.equipamento_id === eId)
    .sort((a, b) => (b.data_verificacao || '').localeCompare(a.data_verificacao || ''))[0] || null;
}

/* ---------------------------------------------------------------- agenda */

/* Situação de cada máquina que tem check list: nunca feito, atrasado,
   vence hoje, vence esta semana ou em dia. Máquina vendida/baixada não entra;
   suspensa (parada, entressafra) também não gera atraso falso. */
function agendaChecklists() {
  const aviso = Number(parametro('aviso_checklist_dias', 2)) || 2;
  const linhas = [];
  for (const e of q.ativos('equipamentos')) {
    if (['VENDIDO', 'BAIXADO'].includes(e.status)) continue;
    const { modelo, vinculo } = modeloDaMaquina(e);
    if (!modelo) continue;
    if (vinculo && vinculo.suspenso) continue;
    const dias = periodicidadeDias(e, modelo, vinculo);
    const ultimo = ultimoChecklist(e.id);
    let status, vence = null, atraso = 0;
    if (!ultimo) { status = 'nunca'; }
    else {
      vence = ultimo.proximo_vencimento || somarDias(ultimo.data_verificacao, dias);
      atraso = diasEntre(vence, hoje());          // positivo = já passou
      status = atraso > 0 ? 'atrasado' : atraso === 0 ? 'hoje'
             : (-atraso <= Math.max(aviso, 7)) ? 'semana' : 'ok';
    }
    linhas.push({ e, modelo, vinculo, dias, ultimo, vence, atraso, status });
  }
  const peso = { atrasado: 0, nunca: 1, hoje: 2, semana: 3, ok: 4 };
  return linhas.sort((a, b) => (peso[a.status] - peso[b.status]) || (b.atraso - a.atraso)
                            || a.e.codigo.localeCompare(b.e.codigo, 'pt-BR'));
}

/* ---------------------------------------------------------------- tela principal */

let abaChecklist = 'agenda';

TELAS.checklist = el => {
  el.innerHTML = `
    <h1>Check list de campo</h1>
    <p class="sub">Preencha no celular ou imprima a folha em branco. Ao finalizar, cada item
       reprovado vira anomalia aberta e o relatório sai pronto para o WhatsApp.</p>
    <div class="abas">
      <button type="button" data-aba="agenda">Agenda</button>
      <button type="button" data-aba="realizados">Realizados</button>
    </div>
    <div id="ck-corpo"></div>`;
  el.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { abaChecklist = b.dataset.aba; TELAS.checklist(el); });
  el.querySelector(`[data-aba="${abaChecklist}"]`).classList.add('ativo');
  (abaChecklist === 'agenda' ? desenharAgenda : desenharRealizados)(el.querySelector('#ck-corpo'));
};

function desenharAgenda(el) {
  const linhas = agendaChecklists();
  const locais = q.ordenado('locais');
  const n = s => linhas.filter(l => l.status === s).length;

  el.innerHTML = `
    <div class="painel" style="margin-bottom:14px">
      <div class="cartao ${n('atrasado') ? 'alerta' : ''}"><b>${n('atrasado')}</b><span>atrasados</span></div>
      <div class="cartao"><b>${n('hoje') + n('semana')}</b><span>vencem esta semana</span></div>
      <div class="cartao"><b>${n('nunca')}</b><span>nunca fizeram</span></div>
      <div class="cartao"><b>${n('ok')}</b><span>em dia</span></div>
    </div>
    <div class="filtros">
      <input type="search" id="ck-busca" placeholder="Buscar por código ou descrição">
      <select id="ck-local"><option value="">Todos os locais</option>
        ${locais.map(l => `<option value="${esc(l.id)}">${esc(l.nome)}</option>`).join('')}</select>
      <select id="ck-st">
        <option value="pendentes">Atrasados, de hoje e nunca feitos</option>
        <option value="todos">Todos</option>
        <option value="atrasado">Só atrasados</option>
        <option value="ok">Em dia</option>
      </select>
    </div>
    <div class="acoes">
      <button type="button" class="btn" id="ck-novo">Novo check list</button>
      <button type="button" class="btn neutro" id="ck-lote">Imprimir folhas em branco</button>
      <button type="button" class="btn-fantasma" id="ck-atualizar" title="Baixar do servidor os check lists feitos em outros aparelhos">Atualizar dados</button>
    </div>
    <ul class="lista ck-agenda" id="ck-lista"></ul>`;

  const desenhar = () => {
    const busca = ($('#ck-busca').value || '').toLowerCase();
    const local = $('#ck-local').value, st = $('#ck-st').value;
    const lista = linhas.filter(l => {
      if (local && l.e.local_id !== local) return false;
      if (st === 'pendentes' && !['atrasado', 'hoje', 'nunca'].includes(l.status)) return false;
      if (st === 'atrasado' && l.status !== 'atrasado') return false;
      if (st === 'ok' && !['ok', 'semana'].includes(l.status)) return false;
      if (busca && !(l.e.codigo + ' ' + l.e.descricao).toLowerCase().includes(busca)) return false;
      return true;
    });
    $('#ck-lista').innerHTML = lista.length === 0
      ? '<div class="vazio"><p>Nada com esses filtros.</p></div>'
      : lista.map(l => {
        const etq = { atrasado: ['urgente', l.atraso + (l.atraso === 1 ? ' dia de atraso' : ' dias de atraso')],
                      hoje: ['vencido', 'vence hoje'], semana: ['atencao', 'vence em ' + (-l.atraso) + ' dias'],
                      ok: ['ok', 'em dia'], nunca: ['neutro', 'nunca feito'] }[l.status];
        return `<li class="st-${l.status}">
          <div class="info">
            <strong><span class="codigo">${esc(l.e.codigo)}</span> ${esc(l.e.descricao)}</strong>
            <small>${esc(q.nome('locais', l.e.local_id))} · ${esc(l.modelo.nome)} · a cada ${l.dias} dias</small>
            <small>${l.ultimo ? 'último em ' + formatarData(l.ultimo.data_verificacao) + ' · próximo ' + formatarData(l.vence) : 'sem check list registrado'}</small>
          </div>
          <span class="etq ${etq[0]}">${etq[1]}</span>
          <button type="button" class="btn" data-preencher="${esc(l.e.id)}">Preencher</button>
          <button type="button" class="btn-fantasma" data-branco="${esc(l.e.id)}">Folha em branco</button>
        </li>`;
      }).join('');
    $('#ck-lista').querySelectorAll('[data-preencher]').forEach(b => b.onclick = () => preencherChecklist(b.dataset.preencher));
    $('#ck-lista').querySelectorAll('[data-branco]').forEach(b => b.onclick = () => imprimirLote([b.dataset.branco]));
  };
  ['ck-busca', 'ck-local', 'ck-st'].forEach(id => { const x = document.getElementById(id); x.oninput = desenhar; x.onchange = desenhar; });
  desenhar();

  $('#ck-novo').onclick = () => escolherMaquina(linhas);
  $('#ck-atualizar').onclick = async () => {
    if (!App.online) return aviso('Sem internet: mostrando o que está neste aparelho.', true);
    aviso('Atualizando…'); await baixarBase(true); irPara('checklist');
  };
  $('#ck-lote').onclick = () => {
    const local = $('#ck-local').value;
    const ids = linhas.filter(l => !local || l.e.local_id === local).map(l => l.e.id);
    if (!ids.length) return aviso('Nenhuma máquina com modelo de check list neste filtro.', true);
    if (ids.length > 12 && !confirm(`Vão sair ${ids.length} folhas. Continuar?`)) return;
    imprimirLote(ids);
  };
}

function escolherMaquina(linhas) {
  abrirModal('Novo check list', `
    <p class="sub">Só aparecem máquinas que têm um modelo de check list — pelo tipo ou por vínculo direto.</p>
    <div class="campo"><label for="nm-busca">Máquina</label>
      <input type="search" id="nm-busca" placeholder="Digite o código ou parte da descrição" autofocus></div>
    <ul class="lista" id="nm-lista"></ul>`, corpo => {
    const lst = corpo.querySelector('#nm-lista'), inp = corpo.querySelector('#nm-busca');
    const desenhar = () => {
      const b = inp.value.toLowerCase();
      const sel = linhas.filter(l => !b || (l.e.codigo + ' ' + l.e.descricao).toLowerCase().includes(b)).slice(0, 15);
      lst.innerHTML = sel.map(l => `<li><div class="info"><span class="codigo">${esc(l.e.codigo)}</span> ${esc(l.e.descricao)}
        <small>${esc(q.nome('locais', l.e.local_id))} · ${esc(l.modelo.nome)}</small></div>
        <button type="button" class="btn" data-id="${esc(l.e.id)}">Abrir</button></li>`).join('');
      lst.querySelectorAll('[data-id]').forEach(x => x.onclick = () => { fecharModal(); preencherChecklist(x.dataset.id); });
    };
    inp.oninput = desenhar; desenhar();
  });
}

function desenharRealizados(el) {
  const lista = q.todos('checklists').slice()
    .sort((a, b) => (b.preenchido_em || '').localeCompare(a.preenchido_em || ''));
  el.innerHTML = `
    <div class="filtros"><input type="search" id="ck-rb" placeholder="Buscar por máquina"></div>
    <ul class="lista" id="ck-rl"></ul>`;
  const desenhar = () => {
    const b = ($('#ck-rb').value || '').toLowerCase();
    const sel = lista.filter(c => {
      const e = q.por_id('equipamentos', c.equipamento_id) || {};
      return !b || ((e.codigo || '') + ' ' + (e.descricao || '')).toLowerCase().includes(b);
    }).slice(0, 80);
    $('#ck-rl').innerHTML = sel.length === 0
      ? '<div class="vazio"><p>Nenhum check list registrado ainda.</p></div>'
      : sel.map(c => {
        const e = q.por_id('equipamentos', c.equipamento_id) || {};
        const anom = q.todos('anomalias').filter(a => a.checklist_id === c.id).length;
        const cls = { 'Liberada': 'ok', 'Liberada com ressalva': 'atencao', 'Máquina parada': 'urgente' }[c.resultado_geral] || 'neutro';
        return `<li>
          <div class="info">
            <strong>${c.numero ? 'Nº ' + c.numero + ' · ' : ''}<span class="codigo">${esc(e.codigo)}</span> ${esc(e.descricao)}</strong>
            <small>${formatarData(c.data_verificacao)} · ${esc(c.operador || '')} ·
              ${c.total_bom} bom · ${c.total_medio} médio · ${c.total_ruim} ruim
              ${anom ? ' · ' + anom + (anom === 1 ? ' anomalia' : ' anomalias') : ''}
              ${c.enviado_whatsapp_em ? ' · enviado' : (anom ? ' · <span style="color:var(--urgente)">não enviado</span>' : '')}</small>
          </div>
          <span class="etq ${cls}">${esc(c.resultado_geral || '')}</span>
          <button type="button" class="btn" data-abrir="${esc(c.id)}">Abrir</button>
        </li>`;
      }).join('');
    $('#ck-rl').querySelectorAll('[data-abrir]').forEach(x => x.onclick = () => abrirRelatorioChecklist(x.dataset.abrir));
  };
  $('#ck-rb').oninput = desenhar; desenhar();
}

/* ---------------------------------------------------------------- preenchimento */

/* O rascunho fica no aparelho (IndexedDB): fechar o app no meio não perde nada. */
async function lerRascunho(eId) { return (await meta('ck_rascunho:' + eId)) || null; }
async function salvarRascunho(r) { await meta('ck_rascunho:' + r.equipamento_id, r); }
async function apagarRascunho(eId) { await meta('ck_rascunho:' + eId, null); }

const urlsFotos = new Map();
async function urlFoto(caminho) {
  if (urlsFotos.has(caminho)) return urlsFotos.get(caminho);
  const blob = await blobDaFoto(caminho);
  if (blob) { const u = URL.createObjectURL(blob); urlsFotos.set(caminho, u); return u; }
  // Foto já enviada e apagada do aparelho (ou feita em outro aparelho): pede ao Storage.
  if (App.online && App.sb) {
    const { data } = await App.sb.storage.from('manutencao-checklists').createSignedUrl(caminho, 3600);
    if (data && data.signedUrl) { urlsFotos.set(caminho, data.signedUrl); return data.signedUrl; }
  }
  return null;
}

async function preencherChecklist(eId) {
  const e = q.por_id('equipamentos', eId);
  const { modelo, vinculo } = modeloDaMaquina(e);
  if (!modelo) return aviso('Esta máquina não tem modelo de check list. Vincule um em Cadastros.', true);
  const versao = versaoVigente(modelo.id);
  if (!versao) return aviso('O modelo "' + modelo.nome + '" não tem versão vigente.', true);

  let r = await lerRascunho(eId);
  if (!r || r.versao_id !== versao.id) {
    r = { equipamento_id: eId, modelo_id: modelo.id, versao_id: versao.id, data: hoje(),
          leitura: e.leitura_atual != null ? String(e.leitura_atual) : '', operador: '',
          respostas: {}, fotos_gerais: [], obs_geral: '', iniciado_em: new Date().toISOString() };
    await salvarRascunho(r);
  }
  const grupos = gruposDaVersao(versao.id).map(g => ({ g, itens: itensDoGrupo(g.id) }));
  const unidade = e.unidade_controle === 'HODOMETRO' ? 'km' : 'h';
  const el = $('#tela');
  $$('.menu button').forEach(b => b.classList.toggle('ativo', b.dataset.tela === 'checklist'));

  el.innerHTML = `
    <h1>${esc(modelo.nome)}</h1>
    <p class="sub">Toque em uma opção por item. Item reprovado pede observação escrita — é o que
       o responsável vai ler para decidir se para a máquina.</p>

    <div class="ck-cab">
      <p class="maquina"><strong><span class="codigo">${esc(e.codigo)}</span> ${esc(e.descricao)}</strong>
        <small>${[q.nome('locais', e.local_id), e.setor_id ? q.nome('setores', e.setor_id) : '',
                  [q.nome('marcas', e.marca_id), e.modelo || ''].join(' ').trim()].filter(Boolean).map(esc).join(' · ')}</small></p>
      <div class="colunas">
        ${campoTexto('Data da verificação', 'data', r.data, 'date')}
        ${campoTexto('Horímetro atual (' + unidade + ')', 'leitura', r.leitura, 'number',
          e.leitura_atual != null ? 'Última leitura: ' + Number(e.leitura_atual).toLocaleString('pt-BR') + ' ' + unidade + (e.leitura_data ? ' em ' + formatarData(e.leitura_data) : '') : 'Sem leitura registrada')}
        ${campoTexto('Operador', 'operador', r.operador, 'text', 'Quem opera a máquina')}
        <div class="campo"><label>Avaliador</label><input type="text" value="${esc(App.usuario.nome || '')}" disabled></div>
      </div>
    </div>

    ${grupos.map(({ g, itens }) => `
      <section class="ck-grupo" data-grupo="${esc(g.id)}">
        <h2>${esc(g.nome)} <small>${itens.length} itens</small></h2>
        ${itens.map(it => desenharItem(it, r.respostas[it.id] || {})).join('')}
      </section>`).join('')}

    <div class="ck-cab">
      <h2 style="margin-top:0">Observações gerais e fotos da inspeção</h2>
      ${campoArea('Observações', 'obs_geral', r.obs_geral)}
      <div class="ck-extra">
        <label class="ck-foto">📷 Fotos gerais<input type="file" accept="image/*" multiple id="ck-fg"></label>
        <div class="ck-miniaturas" id="ck-fg-min"></div>
      </div>
    </div>

    <div class="ck-barra">
      <span class="chip" id="ck-chip">Situação prevista: —</span>
      <span id="ck-prog" class="sub" style="margin:0"></span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn neutro" id="ck-limpar">Limpar</button>
        <button type="button" class="btn neutro" id="ck-voltar">Voltar</button>
        <button type="button" class="btn" id="ck-finalizar">Finalizar</button>
      </div>
    </div>`;

  const todosItens = grupos.flatMap(x => x.itens);
  const salvarCab = async () => {
    r.data = $('#f-data').value; r.leitura = $('#f-leitura').value;
    r.operador = $('#f-operador').value; r.obs_geral = $('#f-obs_geral').value;
    await salvarRascunho(r);
  };
  ['f-data', 'f-leitura', 'f-operador', 'f-obs_geral'].forEach(id => $('#' + id).onchange = salvarCab);

  const atualizarChip = () => {
    let bom = 0, medio = 0, ruim = 0, resp = 0;
    todosItens.forEach(it => {
      const v = (r.respostas[it.id] || {}).v; if (!v) return; resp++;
      const g = grauDe(it, v); if (g === 'bom') bom++; else if (g === 'medio') medio++; else if (g === 'ruim') ruim++;
    });
    const chip = $('#ck-chip');
    if (resp === 0) { chip.className = 'chip'; chip.textContent = 'Situação prevista: —'; }
    else if (ruim > 0) { chip.className = 'chip parada'; chip.textContent = `${ruim} ${ruim === 1 ? 'item reprovado' : 'itens reprovados'}`; }
    else if (medio > 0) { chip.className = 'chip ressalva'; chip.textContent = 'Liberada com ressalva'; }
    else { chip.className = 'chip ok'; chip.textContent = 'Liberada'; }
    $('#ck-prog').textContent = `${resp} de ${todosItens.length} respondidos`;
  };

  const ligarItem = it => {
    const bloco = el.querySelector(`[data-item="${it.id}"]`);
    const resp = r.respostas[it.id] || (r.respostas[it.id] = {});
    bloco.querySelectorAll('.ck-btn').forEach(b => b.onclick = async () => {
      resp.v = resp.v === b.dataset.v ? null : b.dataset.v;     // toque repetido desmarca
      bloco.outerHTML = desenharItem(it, resp); ligarItem(it);
      await salvarRascunho(r); atualizarChip();
    });
    const num = bloco.querySelector('.ck-num, .ck-txt');
    if (num) num.onchange = async () => {
      resp.v = num.value.trim() || null;
      bloco.outerHTML = desenharItem(it, resp); ligarItem(it);
      await salvarRascunho(r); atualizarChip();
    };
    const obs = bloco.querySelector('input.obs');
    if (obs) obs.onchange = async () => { resp.obs = obs.value.trim(); obs.classList.toggle('obrigatoria', geraAnomalia(it, resp.v) && !resp.obs); await salvarRascunho(r); };
    const foto = bloco.querySelector('input[type=file]');
    if (foto) foto.onchange = async () => {
      resp.fotos = resp.fotos || [];
      for (const f of Array.from(foto.files)) {
        const caminho = await guardarFoto(f, 'manutencao-checklists', 'checklists/' + e.codigo.replace(/[^\w.-]/g, '_'));
        urlsFotos.set(caminho, URL.createObjectURL(f));
        resp.fotos.push(caminho);
      }
      await salvarRascunho(r);
      bloco.outerHTML = desenharItem(it, resp); ligarItem(it); pintarMiniaturas(it.id, resp.fotos);
    };
    if (resp.fotos && resp.fotos.length) pintarMiniaturas(it.id, resp.fotos);
  };
  const pintarMiniaturas = async (idItem, fotos) => {
    const alvo = el.querySelector(`[data-item="${idItem}"] .ck-miniaturas`); if (!alvo) return;
    alvo.innerHTML = '';
    for (const c of fotos) { const u = await urlFoto(c); if (u) alvo.insertAdjacentHTML('beforeend', `<img src="${u}" alt="">`); }
  };
  todosItens.forEach(ligarItem);

  const pintarGerais = async () => {
    const alvo = $('#ck-fg-min'); alvo.innerHTML = '';
    for (const c of r.fotos_gerais) { const u = await urlFoto(c); if (u) alvo.insertAdjacentHTML('beforeend', `<img src="${u}" alt="">`); }
  };
  $('#ck-fg').onchange = async ev => {
    for (const f of Array.from(ev.target.files)) {
      const caminho = await guardarFoto(f, 'manutencao-checklists', 'checklists/' + e.codigo.replace(/[^\w.-]/g, '_'));
      urlsFotos.set(caminho, URL.createObjectURL(f)); r.fotos_gerais.push(caminho);
    }
    await salvarRascunho(r); pintarGerais();
  };
  pintarGerais(); atualizarChip();

  $('#ck-voltar').onclick = () => { salvarCab(); irPara('checklist'); aviso('Rascunho guardado neste aparelho.'); };
  $('#ck-limpar').onclick = async () => {
    if (!confirm('Apagar todas as marcações deste check list?')) return;
    await apagarRascunho(eId); preencherChecklist(eId);
  };
  $('#ck-finalizar').onclick = async () => { await salvarCab(); finalizarChecklist(e, modelo, vinculo, versao, grupos, r); };
}

function desenharItem(it, resp) {
  const escala = ESCALAS[it.tipo_resposta];
  const reprova = geraAnomalia(it, resp.v);
  let controle;
  if (escala) {
    controle = `<div class="ck-resp">${escala.map(o =>
      `<button type="button" class="ck-btn ${o.grau} ${resp.v === o.v ? 'sel' : ''}" data-v="${o.v}">${esc(o.rot)}</button>`).join('')}</div>`;
  } else if (it.tipo_resposta === 'NUMERO') {
    controle = `<input class="ck-num" type="number" step="any" inputmode="decimal" value="${esc(resp.v ?? '')}" placeholder="${esc(it.unidade || 'valor')}">`;
  } else {
    controle = `<input class="ck-txt" type="text" value="${esc(resp.v ?? '')}" placeholder="anotar">`;
  }
  const mostrarExtra = resp.v || resp.obs || (resp.fotos && resp.fotos.length);
  return `<div class="ck-item ${!resp.v && it.obrigatorio ? 'pendente' : ''}" data-item="${esc(it.id)}">
    <div class="texto">${esc(it.texto)}${it.obrigatorio ? '' : ' <small>opcional</small>'}${it.unidade && it.tipo_resposta === 'NUMERO' ? ` <small>${esc(it.unidade)}</small>` : ''}</div>
    ${controle}
    ${mostrarExtra ? `<div class="ck-extra">
      <input class="obs ${reprova && !resp.obs ? 'obrigatoria' : ''}" type="text" value="${esc(resp.obs || '')}"
        placeholder="${reprova ? 'Observação obrigatória: o que está errado?' : 'Observação (opcional)'}">
      <label class="ck-foto">📷 Foto<input type="file" accept="image/*" multiple></label>
      <div class="ck-miniaturas"></div>
    </div>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------- finalização */

async function finalizarChecklist(e, modelo, vinculo, versao, grupos, r) {
  const todos = grupos.flatMap(x => x.itens.map(it => ({ it, g: x.g })));
  const faltam = todos.filter(({ it }) => it.obrigatorio !== false && !(r.respostas[it.id] || {}).v);
  if (faltam.length) {
    const p = $(`[data-item="${faltam[0].it.id}"]`); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return aviso(`Faltam ${faltam.length} ${faltam.length === 1 ? 'item obrigatório' : 'itens obrigatórios'}. O primeiro é "${faltam[0].it.texto}".`, true);
  }
  const semObs = todos.filter(({ it }) => { const x = r.respostas[it.id] || {}; return geraAnomalia(it, x.v) && !x.obs; });
  if (semObs.length) {
    const p = $(`[data-item="${semObs[0].it.id}"]`); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return aviso(`"${semObs[0].it.texto}" está reprovado sem observação. Escreva o que está errado.`, true);
  }
  const semFoto = todos.filter(({ it }) => { const x = r.respostas[it.id] || {}; return geraAnomalia(it, x.v) && it.foto_se_ruim && !(x.fotos && x.fotos.length); });
  if (semFoto.length && !confirm(`${semFoto.length} ${semFoto.length === 1 ? 'item reprovado está' : 'itens reprovados estão'} sem foto. Finalizar mesmo assim?`)) return;
  if (!r.data) return aviso('Informe a data da verificação.', true);

  // Contagem por grau
  let bom = 0, medio = 0, ruim = 0;
  todos.forEach(({ it }) => { const g = grauDe(it, (r.respostas[it.id] || {}).v);
    if (g === 'bom') bom++; else if (g === 'medio') medio++; else if (g === 'ruim') ruim++; });

  const leitura = r.leitura !== '' && r.leitura != null ? Number(String(r.leitura).replace(',', '.')) : null;
  const leituraMenor = leitura != null && e.leitura_atual != null && leitura < Number(e.leitura_atual);

  // Resultado geral: quem decide parar a máquina é o avaliador, não o app.
  const padrao = ruim > 0 ? 'Liberada com ressalva' : medio > 0 ? 'Liberada com ressalva' : 'Liberada';
  abrirModal('Finalizar o check list', `
    <p class="sub"><strong>${esc(e.codigo)}</strong> — ${esc(e.descricao)} · ${formatarData(r.data)}</p>
    <div class="painel" style="margin-bottom:14px">
      <div class="cartao"><b>${bom}</b><span>bom</span></div>
      <div class="cartao"><b>${medio}</b><span>médio</span></div>
      <div class="cartao ${ruim ? 'alerta' : ''}"><b>${ruim}</b><span>ruim</span></div>
    </div>
    ${campoLista('Resultado geral', 'resultado', [
      { id: 'Liberada', nome: 'Liberada' },
      { id: 'Liberada com ressalva', nome: 'Liberada com ressalva' },
      { id: 'Máquina parada', nome: 'Máquina parada (quebrada)' }], padrao, '')}
    ${leituraMenor ? `<p class="os-alerta">O horímetro informado (${leitura.toLocaleString('pt-BR')}) é <strong>menor</strong> que a última
      leitura (${Number(e.leitura_atual).toLocaleString('pt-BR')}). Ele fica registrado no check list, mas não atualiza a máquina.
      Se o aparelho foi trocado, registre em Lançar horímetro.</p>` : ''}
    <p class="ajuda">Ao finalizar: ${ruim ? ruim + (ruim === 1 ? ' anomalia é aberta' : ' anomalias são abertas') : 'nenhuma anomalia é aberta'},
       o relatório fica pronto e o próximo check list vence em ${formatarData(somarDias(r.data, periodicidadeDias(e, modelo, vinculo)))}.</p>
    <div class="acoes">
      <button type="button" class="btn" id="fz-ok">Finalizar e gerar relatório</button>
      <button type="button" class="btn neutro" id="fz-cancelar">Voltar</button>
    </div>`, corpo => {
    corpo.querySelector('#fz-cancelar').onclick = fecharModal;
    corpo.querySelector('#fz-ok').onclick = async () => {
      const b = corpo.querySelector('#fz-ok'); b.disabled = true; b.textContent = 'Salvando…';
      const resultado = corpo.querySelector('#f-resultado').value || padrao;
      const id = await gravarChecklist(e, modelo, vinculo, versao, grupos, r, { bom, medio, ruim, resultado, leitura, leituraMenor });
      fecharModal();
      await apagarRascunho(e.id);
      irPara('checklist');
      abrirRelatorioChecklist(id);
    };
  });
}

async function gravarChecklist(e, modelo, vinculo, versao, grupos, r, t) {
  const agora = new Date().toISOString();
  const ckId = crypto.randomUUID();
  const dias = periodicidadeDias(e, modelo, vinculo);
  const avaliador = App.usuario.nome || '';

  // 1. Leitura de horímetro, se informada e coerente. O gatilho do banco
  //    atualiza a máquina; aqui atualizo a cópia local para a tela.
  let leituraId = null;
  if (t.leitura != null && !t.leituraMenor) {
    leituraId = crypto.randomUUID();
    await gravar('leituras', {
      id: leituraId, uuid_dispositivo: crypto.randomUUID(), equipamento_id: e.id,
      data_leitura: r.data, valor: t.leitura, origem: 'CHECKLIST',
      observacao: 'Lançada no check list', registrado_em: agora, criado_por: App.usuario.id || null
    });
    if (e.leitura_data == null || r.data >= e.leitura_data) { e.leitura_atual = t.leitura; e.leitura_data = r.data; }
  }

  // 2. O check list em si
  await gravar('checklists', {
    id: ckId, uuid_dispositivo: crypto.randomUUID(), equipamento_id: e.id, versao_id: versao.id,
    local_id: e.local_id, data_verificacao: r.data, operador: r.operador || null,
    avaliador_id: App.usuario.id || null, leitura: t.leitura, leitura_id: leituraId,
    resultado_geral: t.resultado, total_bom: t.bom, total_medio: t.medio, total_ruim: t.ruim,
    observacao_geral: r.obs_geral || null, proximo_vencimento: somarDias(r.data, dias),
    preenchido_em: r.iniciado_em || agora, criado_por: App.usuario.id || null
  });

  // 3. Respostas com o texto congelado + fotos + anomalias
  const limite = Number(parametro('reincidencia_sobe_prioridade', 3)) || 3;
  for (const { g, itens } of grupos) {
    for (const it of itens) {
      const x = r.respostas[it.id] || {};
      const respId = crypto.randomUUID();
      await gravar('checklist_respostas', {
        id: respId, checklist_id: ckId, item_id: it.id, grupo_texto: g.nome, item_texto: it.texto,
        resposta: x.v ?? null, valor_numerico: it.tipo_resposta === 'NUMERO' && x.v ? Number(x.v) : null,
        observacao: x.obs || null
      });
      for (const c of (x.fotos || []))
        await gravar('checklist_fotos', { id: crypto.randomUUID(), resposta_id: respId, checklist_id: ckId, storage_path: c, enviada_em: agora });

      if (!geraAnomalia(it, x.v)) continue;
      const grau = grauDe(it, x.v);
      // Reincidência: item que já tem anomalia aberta não duplica, sobe o contador.
      const aberta = q.todos('anomalias').find(a => a.equipamento_id === e.id && a.checklist_item_id === it.id && a.status !== 'Fechado');
      if (aberta) {
        aberta.reincidencias = (aberta.reincidencias || 0) + 1;
        if (aberta.reincidencias + 1 >= limite && aberta.prioridade !== 'Alta') aberta.prioridade = 'Alta';
        aberta.descricao = (aberta.descricao || '') + `\nReincidiu em ${formatarData(r.data)}` + (x.obs ? ': ' + x.obs : '');
        aberta.atualizado_em = agora; aberta.atualizado_por = App.usuario.id || null;
        await gravar('anomalias', aberta);
        continue;
      }
      const prioridade = t.resultado === 'Máquina parada' && grau === 'ruim' ? 'Alta' : grau === 'ruim' ? 'Média' : 'Baixa';
      await gravar('anomalias', {
        id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
        data_abertura: r.data, tipo: 'Anomalia de Check List', solicitante: r.operador || avaliador,
        equipamento_id: e.id, local_id: e.local_id, tipo_manutencao_id: null,
        descricao: `${g.nome} · ${it.texto}: ${x.obs || rotuloResposta(it, x.v)}`, item_texto: it.texto,
        setor_responsavel: 'Manutenção', prioridade, procedencia: null,
        prazo: somarDias(r.data, prioridade === 'Alta' ? 3 : prioridade === 'Média' ? 7 : 15),
        status: 'Aberto', checklist_id: ckId, resposta_id: respId, checklist_item_id: it.id,
        reincidencias: 0, criado_em: agora, criado_por: App.usuario.id || null,
        atualizado_em: agora, atualizado_por: App.usuario.id || null
      });
    }
  }
  for (const c of (r.fotos_gerais || []))
    await gravar('checklist_fotos', { id: crypto.randomUUID(), resposta_id: null, checklist_id: ckId, storage_path: c, legenda: 'Foto geral', enviada_em: agora });

  const nAnom = q.todos('anomalias').filter(a => a.checklist_id === ckId).length;
  aviso('Check list salvo.' + (nAnom ? ` ${nAnom} ${nAnom === 1 ? 'anomalia aberta' : 'anomalias abertas'}.` : ''));
  return ckId;
}

/* ---------------------------------------------------------------- folha A4 */

/* Uma função só desenha a folha em branco (para o papel) e o relatório
   preenchido: o desenho é o mesmo do formulário que o campo já conhece. */
function folhaChecklist(e, modelo, opts) {
  const preenchido = !!opts.ck;
  const ck = opts.ck || {};
  const versao = preenchido ? q.por_id('checklist_versoes', ck.versao_id) : versaoVigente(modelo.id);
  const grupos = versao ? gruposDaVersao(versao.id) : [];
  const respostas = preenchido ? q.todos('checklist_respostas').filter(x => x.checklist_id === ck.id) : [];
  const respDe = itemId => respostas.find(x => x.item_id === itemId) || {};
  const anomDe = respId => q.todos('anomalias').find(a => a.resposta_id === respId);
  const unidade = e.unidade_controle === 'HODOMETRO' ? 'km' : 'h';
  const { vinculo } = modeloDaMaquina(e);
  const dias = periodicidadeDias(e, modelo, vinculo);
  const res = ck.resultado_geral || '';
  const resCls = { 'Liberada': 'ok', 'Liberada com ressalva': 'ressalva', 'Máquina parada': 'parada' }[res] || '';
  const cx = (marcado) => marcado ? '☒' : '☐';

  // Itens: em branco todos entram; preenchido, mostra os que tinham resposta na versão do dia.
  const linhasGrupo = grupos.map(g => {
    let itens = itensDoGrupo(g.id);
    if (preenchido) {
      const respostasDoGrupo = respostas.filter(x => x.grupo_texto === g.nome);
      itens = respostasDoGrupo.length
        ? respostasDoGrupo.map(x => q.por_id('checklist_itens', x.item_id) || { id: x.item_id, texto: x.item_texto, tipo_resposta: 'ESCALA_BMR' })
        : itens;
    }
    const tipoRef = itens[0] ? itens[0].tipo_resposta : 'ESCALA_BMR';
    const rot = ROTULO_ESCALA[tipoRef] || ROTULO_ESCALA.ESCALA_BMR;
    const rows = itens.map(it => {
      const x = respDe(it.id);
      const grau = preenchido ? grauDe(it, x.resposta) : null;
      const escala = ESCALAS[it.tipo_resposta];
      let cels;
      if (escala) {
        cels = [0, 1, 2].map(i => escala[i] ? `<td class="c">${cx(preenchido && x.resposta === escala[i].v)}</td>` : '<td class="c"></td>').join('');
      } else {
        cels = `<td colspan="3" style="text-align:center">${preenchido ? esc(x.resposta ?? '') : ''}</td>`;
      }
      const cls = grau === 'ruim' ? 'nc' : grau === 'medio' ? 'md' : '';
      return `<tr class="${cls}"><td>${esc(it.texto)}</td>${cels}<td class="obs">${preenchido ? esc(x.observacao || '') : ''}</td></tr>`;
    }).join('');
    // Nome do grupo e colunas na mesma faixa verde: é o que faz a folha caber em uma página.
    return `<table class="grp">
      <thead><tr><th class="nome">${esc(g.nome)}</th><th class="c">${rot[0]}</th><th class="c">${rot[1]}</th><th class="c">${rot[2]}</th><th>OBS.</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }).join('');

  // Não conformidades primeiro — é isso que o responsável precisa ler.
  let blocoNC = '';
  if (preenchido) {
    const nc = respostas.map(x => ({ x, it: q.por_id('checklist_itens', x.item_id) || { tipo_resposta: 'ESCALA_BMR' } }))
      .filter(({ x, it }) => ['ruim', 'medio'].includes(grauDe(it, x.resposta)));
    blocoNC = nc.length === 0
      ? '<div class="nc-ok">Nenhuma não conformidade apontada.</div>'
      : `<table class="nc"><tr><th>Grupo</th><th>Item</th><th>Situação</th><th>Observação</th><th>Anomalia</th></tr>` +
        nc.map(({ x, it }) => {
          const a = anomDe(x.id);
          return `<tr><td>${esc(x.grupo_texto)}</td><td><strong>${esc(x.item_texto)}</strong></td>
            <td>${esc(rotuloResposta(it, x.resposta))}</td><td>${esc(x.observacao || '')}</td>
            <td>${a ? (a.numero ? 'Nº ' + a.numero : 'aberta') + (a.prazo ? ' · prazo ' + formatarData(a.prazo) : '') : '—'}</td></tr>`;
        }).join('') + '</table>';
  }

  const proximo = preenchido ? (ck.proximo_vencimento || somarDias(ck.data_verificacao, dias)) : null;
  const avaliador = preenchido ? (ck.avaliador_id === (App.usuario.id || null) ? App.usuario.nome : (q.nome('usuarios', ck.avaliador_id) || '')) : '';
  return `<div class="ck-folha ${opts.quebra ? 'quebra' : ''}" data-ck="${esc(ck.id || '')}">
    <div class="cab">
      <img src="sakuma-logo-horizontal.svg" alt="SAKUMA Agronegócios">
      <h2>${esc(modelo.nome)}<small>${preenchido ? 'CHECK LIST Nº ' + (ck.numero || '(aguardando envio)') : 'A CADA ' + dias + ' DIAS'}</small></h2>
    </div>
    <table class="id">
      <tr><td class="rot">Máquina</td><td class="val" colspan="3">${esc(e.codigo)} — ${esc(e.descricao)}</td>
          <td class="rot">Fazenda</td><td class="val">${esc(q.nome('locais', e.local_id))}</td></tr>
      <tr><td class="rot">Marca / modelo</td><td class="val">${esc(q.nome('marcas', e.marca_id))} ${esc(e.modelo || '')}</td>
          <td class="rot">Horímetro</td><td class="val">${preenchido && ck.leitura != null ? Number(ck.leitura).toLocaleString('pt-BR') + ' ' + unidade : '&nbsp;'}</td>
          <td class="rot">Data</td><td class="val">${preenchido ? formatarData(ck.data_verificacao) : '____ / ____ / ______'}</td></tr>
      <tr><td class="rot">Operador</td><td class="val">${preenchido ? esc(ck.operador || '') : '&nbsp;'}</td>
          <td class="rot">Avaliador</td><td class="val">${esc(avaliador)}</td>
          <td class="rot">Resultado</td><td class="val res">${preenchido ? esc(res) : '☐ Liberada &nbsp;☐ Ressalva &nbsp;☐ Parada'}</td></tr>
    </table>
    ${preenchido ? `<div class="resumo">
      <div><b>${(ck.total_bom || 0) + (ck.total_medio || 0) + (ck.total_ruim || 0)}</b>verificados</div>
      <div><b>${ck.total_bom || 0}</b>bom</div><div><b>${ck.total_medio || 0}</b>médio</div><div><b>${ck.total_ruim || 0}</b>ruim</div>
      <div class="res ${resCls}"><b>${esc(res)}</b>resultado</div></div>
      <h3>NÃO CONFORMIDADES</h3>${blocoNC}<h3>CHECK LIST COMPLETO</h3>` : ''}
    ${linhasGrupo}
    ${preenchido ? (ck.observacao_geral ? `<h3>OBSERVAÇÕES</h3><div class="obs-geral">${esc(ck.observacao_geral)}</div>` : '')
                 : '<div class="obs-geral"><span style="color:var(--cinza-claro);font-size:8pt">OBS.:</span></div>'}
    <table class="assin"><tr><td><div>Ass. avaliador</div></td><td><div>Ass. operador</div></td></tr></table>
    ${preenchido ? '<div class="fotos" data-fotos></div>' : ''}
    <div class="rod">
      <span>${preenchido && proximo ? '<strong>Próximo check list: ' + formatarData(proximo) + '</strong>' : 'Periodicidade: a cada ' + dias + ' dias'}</span>
      <span>SAKUMA Agronegócios · <strong>Guilherme Lopes</strong> · Desenvolvido por LOP · Inteligência para o agronegócio</span>
    </div>
  </div>`;
}

/* Preenche a galeria de fotos do relatório (assíncrono: pode vir do aparelho ou do Storage). */
async function pintarFotosRelatorio(raiz, ckId) {
  const alvo = raiz.querySelector('[data-fotos]'); if (!alvo) return;
  const fotos = q.todos('checklist_fotos').filter(f => f.checklist_id === ckId);
  if (!fotos.length) return;
  const figs = [];
  for (const f of fotos) {
    const u = await urlFoto(f.storage_path);
    const resp = f.resposta_id ? q.por_id('checklist_respostas', f.resposta_id) : null;
    const legenda = resp ? resp.grupo_texto + ' · ' + resp.item_texto : (f.legenda || 'Foto geral');
    figs.push(u ? `<figure><img src="${u}" alt=""><figcaption>${esc(legenda)}</figcaption></figure>`
                : `<figure><div style="height:52mm;border:1px dashed var(--linha);display:flex;align-items:center;justify-content:center;font-size:9pt;color:var(--cinza-claro)">foto ainda não disponível neste aparelho</div><figcaption>${esc(legenda)}</figcaption></figure>`);
  }
  alvo.innerHTML = `<h3>REGISTRO FOTOGRÁFICO (${fotos.length})</h3><div class="grade">${figs.join('')}</div>`;
}

/* ---------------------------------------------------------------- relatório */

async function abrirRelatorioChecklist(ckId) {
  let ck = q.por_id('checklists', ckId);
  if (!ck) {
    // Chegou pelo link do WhatsApp em outro aparelho: busca só este check list.
    if (!App.online) return aviso('Check list não está neste aparelho e não há internet.', true);
    aviso('Buscando o check list…');
    for (const [t, col] of [['checklists', 'id'], ['checklist_respostas', 'checklist_id'], ['checklist_fotos', 'checklist_id'], ['anomalias', 'checklist_id']]) {
      const { data } = await App.sb.from(t).select('*').eq(col, ckId);
      if (data && data.length) {
        App.dados[t] = (App.dados[t] || []).filter(x => !data.some(d => d.id === x.id)).concat(data);
      }
    }
    ck = q.por_id('checklists', ckId);
    if (!ck) return aviso('Check list não encontrado.', true);
  }
  const e = q.por_id('equipamentos', ck.equipamento_id);
  const versao = q.por_id('checklist_versoes', ck.versao_id);
  const modelo = versao ? q.por_id('checklist_modelos', versao.modelo_id) : modeloDaMaquina(e).modelo;
  const anomalias = q.todos('anomalias').filter(a => a.checklist_id === ckId);

  abrirModal('Check list ' + (ck.numero ? 'nº ' + ck.numero : '') + ' — ' + e.codigo, `
    <div id="os-impresso">${folhaChecklist(e, modelo, { ck })}</div>
    <div class="acoes">
      <button type="button" class="btn" id="rc-imprimir">Imprimir / salvar PDF</button>
      <button type="button" class="btn secundario" id="rc-zap">Enviar ao responsável</button>
      ${anomalias.length ? '<button type="button" class="btn neutro" id="rc-anom">Ver anomalias</button>' : ''}
    </div>
    ${ck.enviado_whatsapp_em ? `<p class="sub">Enviado em ${new Date(ck.enviado_whatsapp_em).toLocaleString('pt-BR')} para ${esc(ck.enviado_whatsapp_para || '')}.</p>` : ''}`,
  corpo => {
    pintarFotosRelatorio(corpo, ckId);
    corpo.querySelector('#rc-imprimir').onclick = () => {
      document.body.classList.add('imprimindo-os'); window.print();
      setTimeout(() => document.body.classList.remove('imprimindo-os'), 500);
    };
    corpo.querySelector('#rc-zap').onclick = () => enviarWhatsApp(ck, e, anomalias);
    const ba = corpo.querySelector('#rc-anom');
    if (ba) ba.onclick = () => { fecharModal(); irPara('anomalias'); };
  });
}

/* Responsável pela manutenção: o mais específico ganha (local + tipo > local > tipo > geral). */
function responsavelDe(e) {
  const lista = q.ativos('responsaveis_manutencao');
  return lista.find(r => r.local_id === e.local_id && r.tipo_equipamento_id === e.tipo_equipamento_id)
      || lista.find(r => r.local_id === e.local_id && !r.tipo_equipamento_id)
      || lista.find(r => !r.local_id && r.tipo_equipamento_id === e.tipo_equipamento_id)
      || lista.find(r => !r.local_id && !r.tipo_equipamento_id) || null;
}

async function enviarWhatsApp(ck, e, anomalias) {
  if (!App.online) return aviso('O envio por WhatsApp precisa de internet.', true);
  const resp = responsavelDe(e);
  const link = location.origin + location.pathname + '?checklist=' + ck.id;
  const nc = anomalias.map(a => '• ' + (a.item_texto || a.descricao)).slice(0, 8).join('\n');
  const msg = `*Check list ${ck.numero ? 'nº ' + ck.numero : ''} — ${e.codigo}*\n${e.descricao}\n` +
    `${q.nome('locais', e.local_id)} · ${formatarData(ck.data_verificacao)}\n` +
    `Resultado: *${ck.resultado_geral}* (${ck.total_bom} bom · ${ck.total_medio} médio · ${ck.total_ruim} ruim)\n` +
    (anomalias.length ? `\nNão conformidades (${anomalias.length}):\n${nc}${anomalias.length > 8 ? '\n…' : ''}\n` : '\nSem não conformidades.\n') +
    `\nRelatório: ${link}`;
  const tel = resp && resp.telefone ? resp.telefone.replace(/\D/g, '') : '';
  const numero = tel ? (tel.length <= 11 ? '55' + tel : tel) : '';
  if (!numero && !confirm('Nenhum responsável pela manutenção cadastrado para este local. Abrir o WhatsApp sem destinatário?')) return;
  window.open('https://wa.me/' + numero + '?text=' + encodeURIComponent(msg), '_blank');
  ck.enviado_whatsapp_em = new Date().toISOString();
  ck.enviado_whatsapp_para = resp ? resp.nome + (resp.telefone ? ' ' + resp.telefone : '') : '(sem responsável cadastrado)';
  await gravar('checklists', ck);
  aviso('Registrado o envio' + (resp ? ' para ' + resp.nome : '') + '.');
}

/* ---------------------------------------------------------------- impressão em branco */

function imprimirLote(ids) {
  // A div fica direto no body: na impressão em lote todo o resto é escondido.
  let alvo = document.getElementById('impressao-lote');
  if (!alvo) { alvo = document.createElement('div'); alvo.id = 'impressao-lote'; document.body.appendChild(alvo); }
  const folhas = ids.map((id, i) => {
    const e = q.por_id('equipamentos', id); const { modelo } = modeloDaMaquina(e);
    return modelo ? folhaChecklist(e, modelo, { quebra: i < ids.length - 1 }) : '';
  }).join('');
  if (!folhas) return aviso('Nenhuma folha para imprimir.', true);
  alvo.innerHTML = folhas;
  document.body.classList.add('imprimindo-lote');
  window.print();
  setTimeout(() => { document.body.classList.remove('imprimindo-lote'); alvo.innerHTML = ''; }, 800);
}

Object.assign(window, { preencherChecklist, abrirRelatorioChecklist, imprimirLote, agendaChecklists, geraAnomalia, ESCALAS });
