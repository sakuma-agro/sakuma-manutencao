/* =====================================================================
   SAKUMA Manutenção — etapa 2
   Horímetro: lançamento manual, correção com histórico, ajuste de
   contador de implemento e importação do relatório Realtec.

   Regras que não podem ser quebradas (procedimento da empresa):
     1. Máquina: a leitura atual é sempre o campo FIM do lançamento
        mais recente. Nunca o Início, nunca a Quantidade.
     2. Implemento: não tem painel. As horas dele são a SOMA da coluna
        Quantidade, acumulada para sempre. Um lançamento pode ter até
        três implementos e cada um recebe as horas cheias.
     3. A unidade vem do bem que puxou o implemento: trator soma hora,
        caminhão soma quilômetro — em contadores separados.
     4. Nenhum lançamento é filtrado. Documento terminado em "hrm" é
        código interno da empresa e conta normalmente.
     5. O número do documento se repete e NUNCA é chave sozinho.
        A chave do uso é documento + máquina + implemento + data +
        início + fim + quantidade.
     6. Reimportar o mesmo arquivo não pode somar de novo. Em contador
        acumulado, erro não se corrige sozinho.
   ===================================================================== */

/* ---------------------------------------------------------------- utilitários */

/* Número no formato brasileiro: 1.234,5 vira 1234.5 */
function numeroBR(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/\s/g, '');
  // Se tem vírgula, a vírgula é o decimal e o ponto é separador de milhar.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/* Data em qualquer um dos formatos que o relatório costuma sair. */
function dataISO(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let a = m[3]; if (a.length === 2) a = '20' + a;
    return `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // Data serial do Excel (quando a planilha vem sem formatação)
  const n = Number(s);
  if (!isNaN(n) && n > 20000 && n < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/* Texto sem acento, em caixa alta, para comparar cabeçalho e código de bem. */
function chave(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/* Grava um bem sem perder, na tela, as colunas que o banco calcula
   sozinho (horas_acumuladas e km_acumulados são geradas). */
async function gravarBem(bem, mudancas, acumuladas) {
  const reg = Object.assign({}, bem, mudancas || {});
  const hor = reg.horas_acumuladas, km = reg.km_acumulados;
  delete reg.horas_acumuladas; delete reg.km_acumulados;
  await gravar('equipamentos', reg);
  reg.horas_acumuladas = (acumuladas && 'horas' in acumuladas) ? acumuladas.horas : hor;
  reg.km_acumulados = (acumuladas && 'km' in acumuladas) ? acumuladas.km : km;
  return reg;
}

/* Identificador estável: o mesmo texto gera sempre o mesmo UUID.
   É o que faz a releitura do mesmo arquivo não criar registro novo. */
async function uuidEstavel(texto) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-a' +
         h.slice(17, 20) + '-' + h.slice(20, 32);
}

function numBR(v, casas = 1) {
  return v === null || v === undefined || v === '' ? '—'
    : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

/* Unidade do contador do bem, para somar hora e quilômetro separados. */
function unidadeDoBem(e) {
  if (!e) return 'HORIMETRO';
  if (e.unidade_controle === 'HODOMETRO') return 'HODOMETRO';
  if (e.unidade_controle === 'ACUMULADO') return e.rege_preventiva === 'KM' ? 'HODOMETRO' : 'HORIMETRO';
  return 'HORIMETRO';
}

function sufixo(u) { return u === 'HODOMETRO' ? 'km' : 'h'; }

/* ---------------------------------------------------------------- TELA: HORÍMETRO */

TELAS.horimetro = el => {
  el.innerHTML = `
    <h1>Horímetro</h1>
    <p class="sub">A leitura da máquina é o campo <strong>Fim</strong> do lançamento mais recente.
       Implemento não tem painel: as horas dele são a soma da coluna Quantidade, acumulada.
       Aqui você lança na mão, corrige o que já foi lançado e importa o relatório da Realtec.</p>

    <div class="acoes">
      <button type="button" class="btn" id="hr-importar">Importar relatório Realtec</button>
      <button type="button" class="btn neutro" id="hr-historico-geral">Últimas importações</button>
    </div>

    <div class="filtros">
      <input type="search" id="hr-busca" placeholder="Buscar por código ou descrição">
      <select id="hr-local"><option value="">Todos os locais</option>
        ${q.ordenado('locais').map(l => `<option value="${esc(l.id)}">${esc(l.nome)}</option>`).join('')}
      </select>
      <select id="hr-tipo">
        <option value="medidos">Só quem tem contador</option>
        <option value="maquinas">Só máquinas (painel)</option>
        <option value="implementos">Só implementos (acumulado)</option>
        <option value="parados">Sem leitura há mais de 15 dias</option>
        <option value="todos">Todos os bens</option>
      </select>
    </div>
    <div id="hr-lista"></div>`;

  const desenhar = () => {
    const busca = chave($('#hr-busca').value);
    const local = $('#hr-local').value;
    const tipo = $('#hr-tipo').value;
    const hoje = Date.now();

    let lista = q.ativos('equipamentos').filter(e => {
      if (local && e.local_id !== local) return false;
      if (busca && !chave(e.codigo + ' ' + e.descricao).includes(busca)) return false;
      const medido = e.unidade_controle && e.unidade_controle !== 'CALENDARIO';
      if (tipo === 'medidos' && !medido) return false;
      if (tipo === 'maquinas' && !(e.unidade_controle === 'HORIMETRO' || e.unidade_controle === 'HODOMETRO')) return false;
      if (tipo === 'implementos' && e.unidade_controle !== 'ACUMULADO') return false;
      if (tipo === 'parados') {
        if (!medido) return false;
        const d = e.leitura_data || e.ultimo_uso_data;
        if (d && (hoje - new Date(d + 'T00:00:00')) < 15 * 86400000) return false;
      }
      return true;
    }).sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

    const atrasados = lista.filter(e => {
      const d = e.leitura_data || e.ultimo_uso_data;
      return !d || (hoje - new Date(d + 'T00:00:00')) >= 15 * 86400000;
    }).length;

    $('#hr-lista').innerHTML = `
      <div class="painel">
        <div class="cartao"><b>${lista.length}</b><span>bens na lista</span></div>
        <div class="cartao ${atrasados ? 'alerta' : ''}"><b>${atrasados}</b>
          <span>sem marcação há 15 dias ou mais</span></div>
      </div>
      ${lista.length === 0 ? '<div class="vazio"><p>Nenhum bem com esses filtros.</p></div>' : `
      <table class="tabela"><thead><tr>
        <th>Código</th><th>Descrição</th><th>Contador</th>
        <th class="num">Leitura atual</th><th class="num">Última marcação</th><th></th>
      </tr></thead><tbody>` + lista.map(e => {
        const u = unidadeDoBem(e);
        const leitura = leituraDe(e);
        const data = e.unidade_controle === 'ACUMULADO' ? e.ultimo_uso_data : e.leitura_data;
        const velha = !data || (hoje - new Date(data + 'T00:00:00')) >= 15 * 86400000;
        return `<tr>
          <td class="codigo">${esc(e.codigo)}</td>
          <td>${esc(e.descricao)}</td>
          <td>${esc(rotuloUnidade(e.unidade_controle))}</td>
          <td class="num"><strong>${numBR(leitura)}</strong> ${sufixo(u)}</td>
          <td class="num">${data ? formatarData(data) : '<span class="etq atencao">nunca</span>'}
              ${data && velha ? ' <span class="etq atencao">atrasada</span>' : ''}</td>
          <td>
            <button type="button" class="btn-fantasma" data-lancar="${esc(e.id)}">
              ${e.unidade_controle === 'ACUMULADO' ? 'Ajustar' : 'Lançar'}</button>
            <button type="button" class="btn-fantasma" data-hist="${esc(e.id)}">Histórico</button>
          </td>
        </tr>`;
      }).join('') + '</tbody></table>'}`;

    $('#hr-lista').querySelectorAll('[data-lancar]').forEach(b => b.onclick = () => {
      const e = q.por_id('equipamentos', b.dataset.lancar);
      if (e.unidade_controle === 'ACUMULADO') formAjusteContador(e); else formLeitura(e);
    });
    $('#hr-lista').querySelectorAll('[data-hist]').forEach(b =>
      b.onclick = () => historicoLeituras(b.dataset.hist));
  };

  ['hr-busca', 'hr-local', 'hr-tipo'].forEach(id => {
    const e = document.getElementById(id); e.oninput = desenhar; e.onchange = desenhar;
  });
  $('#hr-importar').onclick = telaImportarRealtec;
  $('#hr-historico-geral').onclick = historicoImportacoes;
  desenhar();
};

/* ---------------------------------------------------------------- lançar leitura */

/* Máquina com painel. O valor digitado é o que está no mostrador agora. */
function formLeitura(e, aoSalvar) {
  const u = unidadeDoBem(e);
  const atual = leituraDe(e);
  const hoje = new Date().toISOString().slice(0, 10);

  abrirModal('Lançar leitura — ' + e.codigo, `
    <p class="sub">${esc(e.descricao)} · ${esc(rotuloUnidade(e.unidade_controle))}.
      Leitura atual: <strong>${numBR(atual)} ${sufixo(u)}</strong>
      ${e.leitura_data ? ' em ' + formatarData(e.leitura_data) : ' (nunca lançada)'}.</p>
    <div class="colunas">
      ${campoTexto('Data da leitura', 'data_leitura', hoje, 'date')}
      ${campoTexto('Leitura no mostrador (' + sufixo(u) + ')', 'valor', '', 'number',
        'O valor exato que está no painel, nunca estimado')}
    </div>
    ${campoArea('Observação', 'observacao', '')}
    <div id="lc-alerta"></div>
    <div class="acoes">
      <button type="button" class="btn" id="lc-salvar">Salvar a leitura</button>
      <button type="button" class="btn neutro" id="lc-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#lc-cancelar').onclick = fecharModal;

    corpo.querySelector('#lc-salvar').onclick = async () => {
      const d = lerForm(corpo);
      const valor = num(d.valor);
      if (!d.data_leitura) return aviso('Informe a data da leitura.', true);
      if (valor === null) return aviso('Informe a leitura.', true);
      if (d.data_leitura > hoje) return aviso('A data da leitura está no futuro.', true);

      // Horímetro não anda para trás. Ou o número está errado, ou o
      // aparelho foi trocado — já aconteceu na frota, no T.22.
      if (atual !== null && valor < atual) {
        corpo.querySelector('#lc-alerta').innerHTML = `
          <div class="vazio" style="border-color:var(--urgente)">
            <p><strong>A leitura nova é menor que a anterior.</strong><br>
               Antes: ${numBR(atual)} ${sufixo(u)} · agora: ${numBR(valor)} ${sufixo(u)}.</p>
            <p class="sub">Ou o número foi digitado errado, ou o aparelho foi trocado
               e voltou do zero. Escolha o que aconteceu.</p>
            <div class="acoes">
              <button type="button" class="btn neutro" id="lc-corrigir">Corrigir o número</button>
              <button type="button" class="btn secundario" id="lc-troca">Foi troca de aparelho</button>
            </div>
          </div>`;
        corpo.querySelector('#lc-corrigir').onclick = () => {
          corpo.querySelector('#lc-alerta').innerHTML = '';
          corpo.querySelector('#f-valor').focus();
        };
        corpo.querySelector('#lc-troca').onclick = () =>
          salvarLeitura(e, d, valor, true, atual, aoSalvar);
        return;
      }
      await salvarLeitura(e, d, valor, false, null, aoSalvar);
    };
  });
}

async function salvarLeitura(e, d, valor, troca, acumuladoAnterior, aoSalvar) {
  const reg = {
    id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
    equipamento_id: e.id, data_leitura: d.data_leitura, valor,
    origem: 'MANUAL', observacao: d.observacao || null,
    troca_aparelho: !!troca, acumulado_anterior: troca ? acumuladoAnterior : null,
    registrado_em: new Date().toISOString()
  };
  await gravar('leituras', reg);

  // O banco também faz isso no gatilho; aqui é para a tela responder
  // na hora, mesmo sem sinal.
  if (!e.leitura_data || d.data_leitura >= e.leitura_data) {
    await gravarBem(e, { leitura_atual: valor, leitura_data: d.data_leitura });
  }

  fecharModal();
  if (troca) {
    abrirModal('Troca de aparelho registrada', `
      <p>Guardei que o ${esc(e.codigo)} tinha <strong>${numBR(acumuladoAnterior)}
         ${sufixo(unidadeDoBem(e))}</strong> no aparelho antigo, e a contagem recomeça
         em ${numBR(valor)}.</p>
      <p class="sub">Confira agora a <strong>última troca</strong> de cada item do plano
         desta máquina: os valores gravados são do mostrador velho e, sem ajustar,
         o painel de vencimentos vai mostrar tudo vencido.</p>
      <div class="acoes">
        <button type="button" class="btn" id="tr-planos">Ajustar o plano agora</button>
        <button type="button" class="btn neutro" id="tr-depois">Depois</button>
      </div>`, c => {
      c.querySelector('#tr-depois').onclick = fecharModal;
      c.querySelector('#tr-planos').onclick = () => {
        fecharModal(); irPara('planos');
        setTimeout(() => {
          const s = document.querySelector('#pl-maquina');
          if (s) { s.value = e.id; s.dispatchEvent(new Event('change')); }
        }, 30);
      };
    });
  } else {
    aviso(App.online ? 'Leitura lançada e vencimentos recalculados.'
                     : 'Salva no aparelho. Sobe quando a internet voltar.');
  }
  if (aoSalvar) aoSalvar(); else if (TELAS.horimetro) irPara('horimetro');
}

/* ---------------------------------------------------------------- ajuste de implemento */

/* Implemento não tem painel: o número dele é um acumulado.
   Corrigir aqui não apaga uso nenhum — grava um ajuste, com motivo,
   e o acumulado passa a bater com a realidade. */
function formAjusteContador(e) {
  const u = unidadeDoBem(e);
  const campo = u === 'HODOMETRO' ? 'km' : 'horas';
  const base = Number(e[campo === 'km' ? 'km_iniciais' : 'horas_iniciais'] || 0) +
               Number(e[campo === 'km' ? 'km_importados' : 'horas_importadas'] || 0);
  const ajusteAtual = Number(e[campo === 'km' ? 'ajuste_km' : 'ajuste_horas'] || 0);
  const acumulado = base + ajusteAtual;

  abrirModal('Ajustar o contador — ' + e.codigo, `
    <p class="sub">${esc(e.descricao)}. Implemento não tem mostrador: o número dele é a soma
       das horas dos lançamentos. Hoje o acumulado é
       <strong>${numBR(acumulado)} ${sufixo(u)}</strong>
       (${numBR(base)} vindos dos lançamentos ${ajusteAtual ? ' e ' + numBR(ajusteAtual) + ' de ajuste' : ''}).</p>
    <div class="colunas">
      ${campoTexto('Acumulado correto (' + sufixo(u) + ')', 'valor_novo', acumulado, 'number')}
    </div>
    ${campoArea('Motivo do ajuste', 'motivo', '')}
    <p class="ajuda">O motivo é obrigatório: o ajuste fica no histórico com o seu nome e a data.
       Os lançamentos importados continuam intactos.</p>
    <div class="acoes">
      <button type="button" class="btn" id="aj-salvar">Salvar o ajuste</button>
      <button type="button" class="btn neutro" id="aj-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#aj-cancelar').onclick = fecharModal;
    corpo.querySelector('#aj-salvar').onclick = async () => {
      const d = lerForm(corpo);
      const novo = num(d.valor_novo);
      if (novo === null) return aviso('Informe o acumulado correto.', true);
      if (!d.motivo) return aviso('Escreva o motivo do ajuste.', true);
      if (novo === acumulado) return aviso('O valor é o mesmo que já está gravado.', true);

      await gravar('ajustes_contador', {
        id: crypto.randomUUID(), equipamento_id: e.id, campo,
        valor_anterior: acumulado, valor_novo: novo, motivo: d.motivo,
        criado_em: new Date().toISOString()
      });
      // O acumulado é coluna gerada: quem muda é o ajuste.
      const mud = {}; mud[campo === 'km' ? 'ajuste_km' : 'ajuste_horas'] = novo - base;
      await gravarBem(e, mud, campo === 'km' ? { km: novo } : { horas: novo });

      fecharModal(); irPara('horimetro');
      aviso('Contador ajustado para ' + numBR(novo) + ' ' + sufixo(u) + '.');
    };
  });
}

/* ---------------------------------------------------------------- histórico e correção */

async function historicoLeituras(idEquipamento) {
  const e = q.por_id('equipamentos', idEquipamento);
  const u = unidadeDoBem(e);
  abrirModal('Histórico — ' + e.codigo, '<p class="sub">Buscando…</p>');

  let leituras = [], ajustes = [], usos = [], erro = null;
  if (App.online && App.sb) {
    try {
      const [l, a, s] = await Promise.all([
        App.sb.from('leituras').select('*').eq('equipamento_id', idEquipamento)
          .order('data_leitura', { ascending: false }).limit(60),
        App.sb.from('ajustes_contador').select('*').eq('equipamento_id', idEquipamento)
          .order('criado_em', { ascending: false }).limit(30),
        App.sb.from('usos_implemento').select('*').eq('implemento_id', idEquipamento)
          .order('data_uso', { ascending: false }).limit(40)
      ]);
      leituras = l.data || []; ajustes = a.data || []; usos = s.data || [];
    } catch (ex) { erro = ex.message; }
  } else {
    leituras = (App.dados.leituras || []).filter(x => x.equipamento_id === idEquipamento);
    erro = 'sem internet';
  }

  const linhasLeitura = leituras.map(l => `
    <tr${l.substituida_por ? ' style="opacity:.55"' : ''}>
      <td>${formatarData(l.data_leitura)}</td>
      <td class="num"><strong>${numBR(l.valor)}</strong> ${sufixo(u)}</td>
      <td>${esc(({ MANUAL: 'na mão', IMPORTACAO: 'importação', ORDEM_SERVICO: 'conclusão de OS',
                   CHECKLIST: 'check list', CARGA_INICIAL: 'carga inicial' })[l.origem] || l.origem)}
        ${l.troca_aparelho ? ' <span class="etq atencao">troca de aparelho</span>' : ''}
        ${l.substituida_por ? ' <span class="etq inativo">substituída</span>' : ''}</td>
      <td>${esc(l.motivo_correcao || l.observacao || '')}</td>
      <td>${l.substituida_por ? '' :
        `<button type="button" class="btn-fantasma" data-corrigir="${esc(l.id)}">Corrigir</button>`}</td>
    </tr>`).join('');

  abrirModal('Histórico — ' + e.codigo, `
    <p class="sub">${esc(e.descricao)} · acumulado hoje
       <strong>${numBR(leituraDe(e))} ${sufixo(u)}</strong>.
       ${erro === 'sem internet' ? 'Sem internet: mostrando só o que está no aparelho.' : ''}</p>

    <h2>Leituras</h2>
    ${leituras.length === 0 ? '<div class="vazio"><p>Nenhuma leitura registrada.</p></div>' :
      `<table class="tabela"><thead><tr><th>Data</th><th class="num">Leitura</th>
        <th>Origem</th><th>Observação</th><th></th></tr></thead>
        <tbody>${linhasLeitura}</tbody></table>`}

    ${ajustes.length ? `<h2>Ajustes de contador</h2>
      <table class="tabela"><thead><tr><th>Quando</th><th class="num">De</th><th class="num">Para</th>
        <th>Motivo</th></tr></thead><tbody>${ajustes.map(a => `<tr>
        <td>${new Date(a.criado_em).toLocaleDateString('pt-BR')}</td>
        <td class="num">${numBR(a.valor_anterior)}</td>
        <td class="num">${numBR(a.valor_novo)}</td>
        <td>${esc(a.motivo)}</td></tr>`).join('')}</tbody></table>` : ''}

    ${usos.length ? `<h2>Últimos usos como implemento</h2>
      <table class="tabela"><thead><tr><th>Data</th><th>Documento</th><th>Puxado por</th>
        <th class="num">Quantidade</th></tr></thead><tbody>${usos.map(s => {
        const pai = q.por_id('equipamentos', s.equipamento_pai_id);
        return `<tr><td>${formatarData(s.data_uso)}</td><td>${esc(s.documento)}</td>
          <td>${esc(pai ? pai.codigo : '—')}</td>
          <td class="num">${numBR(s.quantidade)} ${sufixo(s.unidade)}</td></tr>`;
      }).join('')}</tbody></table>` : ''}

    <div class="acoes">
      <button type="button" class="btn secundario" id="hl-lancar">
        ${e.unidade_controle === 'ACUMULADO' ? 'Ajustar o contador' : 'Lançar leitura'}</button>
      <button type="button" class="btn neutro" id="hl-fechar">Fechar</button>
    </div>`, corpo => {
    corpo.querySelector('#hl-fechar').onclick = fecharModal;
    corpo.querySelector('#hl-lancar').onclick = () =>
      e.unidade_controle === 'ACUMULADO' ? formAjusteContador(e) : formLeitura(e);
    corpo.querySelectorAll('[data-corrigir]').forEach(b => b.onclick = () =>
      formCorrigirLeitura(e, leituras.find(l => l.id === b.dataset.corrigir)));
  });
}

/* Corrigir não apaga: grava a leitura certa e marca a antiga como
   substituída, com autor, data e motivo. */
function formCorrigirLeitura(e, leitura) {
  const u = unidadeDoBem(e);
  abrirModal('Corrigir leitura de ' + formatarData(leitura.data_leitura), `
    <p class="sub">${esc(e.codigo)} — valor gravado:
       <strong>${numBR(leitura.valor)} ${sufixo(u)}</strong>.
       A leitura antiga não é apagada: fica no histórico como substituída.</p>
    <div class="colunas">
      ${campoTexto('Data correta', 'data_leitura', leitura.data_leitura, 'date')}
      ${campoTexto('Leitura correta (' + sufixo(u) + ')', 'valor', leitura.valor, 'number')}
    </div>
    ${campoArea('Motivo da correção', 'motivo_correcao', '')}
    <div class="acoes">
      <button type="button" class="btn" id="cl-salvar">Gravar a correção</button>
      <button type="button" class="btn neutro" id="cl-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#cl-cancelar').onclick = () => historicoLeituras(e.id);
    corpo.querySelector('#cl-salvar').onclick = async () => {
      const d = lerForm(corpo);
      const valor = num(d.valor);
      if (valor === null) return aviso('Informe a leitura correta.', true);
      if (!d.motivo_correcao) return aviso('Escreva o motivo da correção.', true);

      const nova = {
        id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
        equipamento_id: e.id, data_leitura: d.data_leitura, valor,
        origem: 'MANUAL', motivo_correcao: d.motivo_correcao,
        observacao: 'Corrige a leitura de ' + formatarData(leitura.data_leitura) +
                    ' (' + numBR(leitura.valor) + ')',
        troca_aparelho: false, registrado_em: new Date().toISOString()
      };
      await gravar('leituras', nova);
      await gravar('leituras', Object.assign({}, leitura, { substituida_por: nova.id }));

      const eq = q.por_id('equipamentos', e.id);
      if (eq && eq.unidade_controle !== 'ACUMULADO' &&
          (!eq.leitura_data || d.data_leitura >= eq.leitura_data)) {
        eq.leitura_atual = valor; eq.leitura_data = d.data_leitura;
        await gravar('equipamentos', eq);
      }
      aviso('Correção gravada. A leitura antiga ficou no histórico.');
      historicoLeituras(e.id);
    };
  });
}

/* ---------------------------------------------------------------- IMPORTAÇÃO REALTEC */

/* Campos que o app precisa achar no arquivo. */
const CAMPOS_REALTEC = [
  ['bem', 'Bem / máquina', ['BEM', 'CODIGO DO BEM', 'CODIGO', 'MAQUINA', 'EQUIPAMENTO', 'PATRIMONIO'], true],
  ['data', 'Data do lançamento', ['DATA', 'LANCAMENTO', 'DATA LANCAMENTO', 'EFETIVACAO', 'DATA EFETIVACAO'], true],
  ['documento', 'Documento', ['DOCUMENTO', 'DOC', 'NUMERO DOCUMENTO', 'N DOCUMENTO'], true],
  ['inicio', 'Início', ['INICIO', 'HORIMETRO INICIAL', 'INICIAL'], false],
  ['fim', 'Fim', ['FIM', 'HORIMETRO FINAL', 'FINAL'], true],
  ['quantidade', 'Quantidade', ['QUANTIDADE', 'QTDE', 'QTD', 'HORAS', 'TOTAL'], true],
  ['implemento1', 'Implemento 1', ['IMPLEMENTO', 'IMPLEMENTO 1', 'IMPLEMENTO1'], false],
  ['implemento2', 'Implemento 2', ['IMPLEMENTO 2', 'IMPLEMENTO2'], false],
  ['implemento3', 'Implemento 3', ['IMPLEMENTO 3', 'IMPLEMENTO3'], false]
];

function mapaSalvo() {
  const p = q.todos('parametros').find(x => x.chave === 'mapa_realtec');
  try { return p && p.valor ? JSON.parse(p.valor) : {}; } catch (e) { return {}; }
}

async function guardarMapa(mapa) {
  const p = q.todos('parametros').find(x => x.chave === 'mapa_realtec') ||
            { chave: 'mapa_realtec', descricao: 'Colunas do relatório Realtec, como o app aprendeu' };
  await gravar('parametros', Object.assign({}, p, { valor: JSON.stringify(mapa) }));
}

function telaImportarRealtec() {
  abrirModal('Importar relatório Realtec', `
    <p class="sub">Exporte o relatório <strong>OPERAÇÕES MECANIZADAS ANALÍTICO</strong> em
       CSV ou Excel e escolha o arquivo aqui. A leitura da máquina vem do campo
       <strong>Fim</strong>; as horas do implemento vêm da <strong>Quantidade</strong>.
       Nenhum lançamento é descartado, inclusive os de documento "hrm".</p>
    <div class="campo">
      <input type="file" id="ir-arq" accept=".csv,.txt,.xlsx,.xls">
      <p class="ajuda">Precisa de internet. Reimportar o mesmo arquivo não soma de novo.</p>
    </div>
    <div id="ir-passo"></div>`, corpo => {
    corpo.querySelector('#ir-arq').onchange = ev => {
      const arq = ev.target.files[0];
      if (arq) lerArquivoRealtec(arq, corpo.querySelector('#ir-passo'));
    };
  });
}

async function lerArquivoRealtec(arquivo, alvo) {
  alvo.innerHTML = '<p class="sub">Lendo o arquivo…</p>';
  let linhas;
  try {
    linhas = /\.xlsx?$/i.test(arquivo.name) ? await lerExcel(arquivo) : lerCSV(await arquivo.text());
  } catch (e) {
    alvo.innerHTML = `<div class="vazio"><p>Não consegui ler o arquivo: ${esc(e.message)}</p>
      <p class="sub">Se for Excel, salve como CSV separado por ponto e vírgula e tente de novo.</p></div>`;
    return;
  }
  if (!linhas || linhas.length < 2) {
    alvo.innerHTML = '<div class="vazio"><p>O arquivo não tem linhas de dados.</p></div>';
    return;
  }

  const hash = await hashArquivo(arquivo);
  const cabecalho = linhas[0].map(c => String(c || '').trim());
  const dados = linhas.slice(1).filter(l => l.some(c => String(c || '').trim() !== ''));
  passoMapear(alvo, { arquivo, hash, cabecalho, dados });
}

/* Excel só quando for preciso: a biblioteca desce na hora, e a
   importação já exige internet de qualquer forma. */
async function lerExcel(arquivo) {
  if (!window.XLSX) {
    await new Promise((ok, erro) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = ok; s.onerror = () => erro(new Error('não consegui baixar o leitor de Excel'));
      document.head.appendChild(s);
    });
  }
  const wb = XLSX.read(await arquivo.arrayBuffer(), { type: 'array', cellDates: false });
  const aba = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(aba, { header: 1, raw: true, defval: '' });
}

/* CSV com aspas, separador detectado sozinho. */
function lerCSV(texto) {
  texto = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const primeira = texto.slice(0, texto.indexOf('\n') + 1 || undefined);
  const sep = [';', '\t', ','].map(s => [s, (primeira.split(s).length)])
    .sort((a, b) => b[1] - a[1])[0][0];

  const linhas = []; let campo = '', linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

async function hashArquivo(arquivo) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', await arquivo.arrayBuffer()));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ---- passo 1: dizer qual coluna é o quê (o app chuta e você confirma) ---- */

function passoMapear(alvo, ctx) {
  const salvo = mapaSalvo();
  const normalizado = ctx.cabecalho.map(chave);

  const palpite = {};
  CAMPOS_REALTEC.forEach(([id, , apelidos]) => {
    if (salvo[id] !== undefined && ctx.cabecalho[salvo[id]] !== undefined) { palpite[id] = salvo[id]; return; }
    let i = normalizado.findIndex(h => apelidos.includes(h));
    if (i < 0) i = normalizado.findIndex(h => apelidos.some(a => h.includes(a)));
    if (i >= 0) palpite[id] = i;
  });

  const opcoes = ctx.cabecalho.map((c, i) =>
    `<option value="${i}">${esc(c || 'coluna ' + (i + 1))}</option>`).join('');

  alvo.innerHTML = `
    <h2>De qual coluna vem cada informação</h2>
    <p class="sub">${ctx.dados.length} linhas, ${ctx.cabecalho.length} colunas.
       Confira o que o app entendeu — ele guarda a resposta para as próximas importações.</p>
    <div class="colunas">
      ${CAMPOS_REALTEC.map(([id, rot, , obrig]) => `
        <div class="campo"><label for="mp-${id}">${esc(rot)}${obrig ? ' *' : ''}</label>
          <select id="mp-${id}" name="${id}">
            <option value="">— não tem —</option>${opcoes}
          </select></div>`).join('')}
    </div>
    <div class="acoes">
      <button type="button" class="btn" id="mp-ok">Conferir os dados</button>
      <button type="button" class="btn neutro" id="mp-cancelar">Cancelar</button>
    </div>`;

  CAMPOS_REALTEC.forEach(([id]) => {
    const s = document.getElementById('mp-' + id);
    if (palpite[id] !== undefined) s.value = String(palpite[id]);
  });

  document.getElementById('mp-cancelar').onclick = fecharModal;
  document.getElementById('mp-ok').onclick = async () => {
    const mapa = {};
    let faltando = null;
    CAMPOS_REALTEC.forEach(([id, rot, , obrig]) => {
      const v = document.getElementById('mp-' + id).value;
      if (v !== '') mapa[id] = Number(v);
      else if (obrig && !faltando) faltando = rot;
    });
    if (faltando) return aviso('Falta dizer qual coluna é "' + faltando + '".', true);
    await guardarMapa(mapa);
    passoConferir(alvo, ctx, mapa);
  };
}

/* ---- passo 2: conferência antes de gravar ---- */

function passoConferir(alvo, ctx, mapa) {
  const bens = q.todos('equipamentos');
  const porCodigo = {};
  bens.forEach(b => {
    porCodigo[chave(b.codigo)] = b;
    if (b.codigo_importacao) porCodigo[chave(b.codigo_importacao)] = b;
  });

  const achar = txt => {
    const k = chave(txt);
    if (!k) return null;
    if (porCodigo[k]) return porCodigo[k];
    // "T.02 - TRATOR JOHN DEERE 5090E" — o código é o pedaço antes do traço.
    const primeiro = k.split(/[\s\-–—]/)[0];
    return porCodigo[primeiro] || null;
  };

  const lanc = [];
  const naoAchados = {};
  let semData = 0;

  ctx.dados.forEach((l, i) => {
    const cod = l[mapa.bem];
    const data = dataISO(l[mapa.data]);
    const bem = achar(cod);
    if (!bem) { const k = chave(cod); if (k) naoAchados[k] = (naoAchados[k] || 0) + 1; return; }
    if (!data) { semData++; return; }

    const implementos = ['implemento1', 'implemento2', 'implemento3']
      .filter(c => mapa[c] !== undefined)
      .map(c => ({ texto: l[mapa[c]], bem: achar(l[mapa[c]]) }))
      .filter(x => chave(x.texto));

    implementos.forEach(x => { if (!x.bem) { const k = chave(x.texto); naoAchados[k] = (naoAchados[k] || 0) + 1; } });

    lanc.push({
      linha: i + 2, bem, data,
      documento: String(l[mapa.documento] ?? '').trim(),
      inicio: mapa.inicio !== undefined ? numeroBR(l[mapa.inicio]) : null,
      fim: numeroBR(l[mapa.fim]),
      quantidade: numeroBR(l[mapa.quantidade]),
      implementos: implementos.filter(x => x.bem).map(x => x.bem)
    });
  });

  // Leitura da máquina: o FIM do lançamento mais recente de cada bem.
  const leituraPorBem = {};
  lanc.forEach(l => {
    if (l.fim === null) return;
    if (l.bem.leitura_por_importacao === false) return;
    if (l.bem.unidade_controle === 'ACUMULADO' || l.bem.unidade_controle === 'CALENDARIO') return;
    const atual = leituraPorBem[l.bem.id];
    if (!atual || l.data > atual.data || (l.data === atual.data && l.fim > atual.valor))
      leituraPorBem[l.bem.id] = { bem: l.bem, data: l.data, valor: l.fim };
  });

  const usos = [];
  lanc.forEach(l => l.implementos.forEach(imp => {
    if (l.quantidade === null) return;
    usos.push({
      implemento: imp, pai: l.bem, data: l.data, documento: l.documento,
      inicio: l.inicio, fim: l.fim, quantidade: l.quantidade,
      unidade: unidadeDoBem(l.bem)
    });
  }));

  const datas = lanc.map(l => l.data).sort();
  const faltantes = Object.entries(naoAchados).sort((a, b) => b[1] - a[1]);
  const recuos = Object.values(leituraPorBem).filter(x =>
    x.bem.leitura_atual != null && x.valor < Number(x.bem.leitura_atual));

  alvo.innerHTML = `
    <h2>Conferência</h2>
    <div class="painel">
      <div class="cartao"><b>${lanc.length}</b><span>lançamentos lidos</span></div>
      <div class="cartao"><b>${Object.keys(leituraPorBem).length}</b><span>máquinas com leitura nova</span></div>
      <div class="cartao"><b>${usos.length}</b><span>usos de implemento
        ${usos.some(u => u.unidade === 'HODOMETRO')
          ? '(' + usos.filter(u => u.unidade === 'HORIMETRO').length + ' em hora e ' +
            usos.filter(u => u.unidade === 'HODOMETRO').length + ' em quilômetro)' : ''}</span></div>
      <div class="cartao ${faltantes.length ? 'alerta' : ''}"><b>${faltantes.length}</b>
        <span>códigos que não existem no cadastro</span></div>
    </div>
    <p class="sub">Período do arquivo: ${datas.length ? formatarData(datas[0]) + ' a ' +
      formatarData(datas[datas.length - 1]) : '—'}${semData ? ' · ' + semData + ' linhas sem data foram puladas' : ''}.</p>

    ${recuos.length ? `
      <h2>Leituras que andaram para trás</h2>
      <p class="sub">Estas máquinas vieram no relatório com o Fim menor que a leitura já gravada.
         O app não vai baixar a leitura delas: confira se foi troca de aparelho ou erro de digitação
         no sistema de origem.</p>
      <table class="tabela"><thead><tr><th>Máquina</th><th class="num">Gravado</th>
        <th class="num">No arquivo</th></tr></thead><tbody>
        ${recuos.map(x => `<tr><td class="codigo">${esc(x.bem.codigo)}</td>
          <td class="num">${numBR(x.bem.leitura_atual)}</td>
          <td class="num">${numBR(x.valor)}</td></tr>`).join('')}
      </tbody></table>` : ''}

    ${faltantes.length ? `
      <h2>Códigos que o cadastro não conhece</h2>
      <p class="sub">Enquanto não estiverem ligados a um bem, esses lançamentos ficam de fora.
         Escolha o bem correspondente — o app guarda o apelido e nas próximas importações reconhece sozinho.</p>
      <table class="tabela"><thead><tr><th>No arquivo</th><th class="num">Linhas</th>
        <th>É qual bem do cadastro?</th></tr></thead><tbody>
        ${faltantes.slice(0, 30).map(([k, n]) => `<tr>
          <td class="codigo">${esc(k)}</td><td class="num">${n}</td>
          <td><select data-vinc="${esc(k)}"><option value="">— deixar de fora —</option>
            ${bens.slice().sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }))
              .map(b => `<option value="${esc(b.id)}">${esc(b.codigo)} — ${esc(b.descricao)}</option>`).join('')}
          </select></td></tr>`).join('')}
      </tbody></table>
      ${faltantes.length > 30 ? `<p class="sub">e mais ${faltantes.length - 30} códigos.</p>` : ''}
      <div class="acoes">
        <button type="button" class="btn secundario" id="cf-vincular">Salvar os vínculos e ler de novo</button>
      </div>` : ''}

    <div class="acoes">
      <button type="button" class="btn" id="cf-gravar"
        ${lanc.length === 0 ? 'disabled' : ''}>Gravar a importação</button>
      <button type="button" class="btn neutro" id="cf-cancelar">Cancelar</button>
    </div>`;

  const bv = document.getElementById('cf-vincular');
  if (bv) bv.onclick = async () => {
    let n = 0;
    for (const s of alvo.querySelectorAll('[data-vinc]')) {
      if (!s.value) continue;
      const b = q.por_id('equipamentos', s.value);
      if (!b) continue;
      await gravarBem(b, { codigo_importacao: s.dataset.vinc }); n++;
    }
    if (!n) return aviso('Escolha pelo menos um bem para vincular.', true);
    aviso(n + ' código(s) vinculado(s).');
    passoConferir(alvo, ctx, mapa);
  };

  document.getElementById('cf-cancelar').onclick = fecharModal;
  document.getElementById('cf-gravar').onclick = () =>
    gravarImportacao(alvo, ctx, { lanc, usos, leituraPorBem, datas });
}

/* ---- passo 3: gravar, sem somar duas vezes ---- */

async function gravarImportacao(alvo, ctx, r) {
  if (!App.online || !App.sb) {
    return aviso('A importação precisa de internet — ela grava direto no servidor.', true);
  }
  alvo.innerHTML = '<p class="sub">Gravando… não feche o app.</p>';

  try {
    // Arquivo já importado antes? Idempotente de qualquer jeito, mas o
    // aviso evita susto.
    const { data: iguais } = await App.sb.from('importacoes')
      .select('id, arquivo_nome, importado_em').eq('arquivo_hash', ctx.hash).limit(1);
    if (iguais && iguais.length &&
        !confirm('Este mesmo arquivo já foi importado em ' +
          new Date(iguais[0].importado_em).toLocaleString('pt-BR') +
          '. Pode importar de novo — nada será somado duas vezes. Continuar?')) {
      return fecharModal();
    }

    const imp = {
      id: crypto.randomUUID(),
      arquivo_nome: ctx.arquivo.name, arquivo_hash: ctx.hash,
      formato: /\.xlsx?$/i.test(ctx.arquivo.name) ? 'EXCEL' : 'CSV',
      periodo_inicio: r.datas[0] || null, periodo_fim: r.datas[r.datas.length - 1] || null,
      qtd_bens: Object.keys(r.leituraPorBem).length, qtd_lancamentos: r.lanc.length,
      importado_em: new Date().toISOString()
    };
    const ins = await App.sb.from('importacoes').insert(imp).select('id');
    if (ins.error) throw new Error('não consegui abrir a importação: ' + ins.error.message +
      ' (só quem tem perfil Administrador importa)');

    // Usos: o id é calculado a partir da própria chave do lançamento —
    // documento + máquina + implemento + data + início + fim + quantidade.
    // O mesmo lançamento sempre gera o mesmo id, então reimportar não
    // insere de novo e o gatilho do banco só soma o que entrou de verdade.
    // (O id resolve também o caso de Início e Fim virem vazios, em que o
    //  índice único do banco não conseguiria comparar.)
    let novos = 0;
    const linhas = []; const vistos = new Set();
    for (const u of r.usos) {
      const k = [u.documento, u.pai.id, u.implemento.id, u.data, u.inicio, u.fim, u.quantidade].join('|');
      if (vistos.has(k)) continue;   // linha repetida dentro do próprio arquivo
      vistos.add(k);
      linhas.push({
        id: await uuidEstavel(k), implemento_id: u.implemento.id, equipamento_pai_id: u.pai.id,
        importacao_id: imp.id, data_uso: u.data, documento: u.documento,
        inicio: u.inicio, fim: u.fim, quantidade: u.quantidade, unidade: u.unidade
      });
    }
    for (let i = 0; i < linhas.length; i += 400) {
      const lote = linhas.slice(i, i + 400);
      const { data, error } = await App.sb.from('usos_implemento')
        .upsert(lote, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) throw new Error('usos: ' + error.message);
      novos += (data || []).length;
      alvo.innerHTML = `<p class="sub">Gravando os usos dos implementos… ${Math.min(i + 400, linhas.length)}
        de ${linhas.length}.</p>`;
    }

    // Leituras das máquinas: uma por bem, com id estável, para reimportar
    // não encher o histórico de linha repetida.
    const leituras = [];
    for (const x of Object.values(r.leituraPorBem)) {
      if (x.bem.leitura_atual != null && x.valor < Number(x.bem.leitura_atual)) continue; // não anda para trás
      leituras.push({
        id: await uuidEstavel(x.bem.id + '|' + x.data + '|' + x.valor),
        uuid_dispositivo: crypto.randomUUID(),
        equipamento_id: x.bem.id, data_leitura: x.data, valor: x.valor,
        origem: 'IMPORTACAO', importacao_id: imp.id, troca_aparelho: false,
        registrado_em: new Date().toISOString()
      });
    }
    let leiturasNovas = 0;
    for (let i = 0; i < leituras.length; i += 200) {
      const { data, error } = await App.sb.from('leituras')
        .upsert(leituras.slice(i, i + 200), { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) throw new Error('leituras: ' + error.message);
      leiturasNovas += (data || []).length;
    }

    await App.sb.from('importacoes').update({
      qtd_usos_novos: novos, qtd_usos_ignorados: linhas.length - novos
    }).eq('id', imp.id);

    // Recarrega os cadastros para o painel já mostrar os números novos.
    await baixarBase(true);
    await carregarDaBaseLocal();

    alvo.innerHTML = `
      <h2>Importação concluída</h2>
      <div class="painel">
        <div class="cartao"><b>${leiturasNovas}</b><span>leituras de máquina novas</span></div>
        <div class="cartao"><b>${novos}</b><span>usos de implemento somados</span></div>
        <div class="cartao"><b>${linhas.length - novos}</b><span>usos que já estavam gravados</span></div>
      </div>
      <p class="sub">Os ${linhas.length - novos} repetidos são a prova de que reimportar não soma
         duas vezes. Os contadores dos implementos já subiram só com o que era novo.</p>
      <div class="acoes">
        <button type="button" class="btn" id="fi-vencimentos">Ver o painel de vencimentos</button>
        <button type="button" class="btn neutro" id="fi-fechar">Fechar</button>
      </div>`;
    alvo.querySelector('#fi-fechar').onclick = () => { fecharModal(); irPara('horimetro'); };
    alvo.querySelector('#fi-vencimentos').onclick = () => { fecharModal(); irPara('vencimentos'); };

  } catch (e) {
    alvo.innerHTML = `<div class="vazio" style="border-color:var(--urgente)">
      <p><strong>A importação parou.</strong></p><p class="sub">${esc(e.message)}</p>
      <p class="sub">Nada foi somado pela metade: pode corrigir e importar o mesmo arquivo de novo.</p>
      <div class="acoes"><button type="button" class="btn neutro" id="er-fechar">Fechar</button></div></div>`;
    const b = alvo.querySelector('#er-fechar'); if (b) b.onclick = fecharModal;
  }
}

/* ---------------------------------------------------------------- histórico de importações */

async function historicoImportacoes() {
  abrirModal('Últimas importações', '<p class="sub">Buscando…</p>');
  if (!App.online || !App.sb) {
    return abrirModal('Últimas importações',
      '<div class="vazio"><p>Precisa de internet para consultar as importações.</p></div>');
  }
  const { data, error } = await App.sb.from('importacoes')
    .select('*').order('importado_em', { ascending: false }).limit(20);

  abrirModal('Últimas importações', error
    ? `<div class="vazio"><p>${esc(error.message)}</p></div>`
    : (!data || !data.length)
      ? '<div class="vazio"><p>Nenhum relatório importado ainda.</p></div>'
      : `<table class="tabela"><thead><tr><th>Quando</th><th>Arquivo</th><th>Período</th>
          <th class="num">Lançamentos</th><th class="num">Usos novos</th>
          <th class="num">Repetidos</th></tr></thead><tbody>` + data.map(i => `<tr>
          <td>${new Date(i.importado_em).toLocaleString('pt-BR')}</td>
          <td>${esc(i.arquivo_nome)}</td>
          <td>${i.periodo_inicio ? formatarData(i.periodo_inicio) + ' a ' + formatarData(i.periodo_fim) : '—'}</td>
          <td class="num">${i.qtd_lancamentos ?? '—'}</td>
          <td class="num">${i.qtd_usos_novos ?? '—'}</td>
          <td class="num">${i.qtd_usos_ignorados ?? '—'}</td></tr>`).join('') + '</tbody></table>');
}

/* Publica o que as outras telas usam. */
Object.assign(window, {
  formLeitura, formAjusteContador, historicoLeituras,
  telaImportarRealtec, numeroBR, dataISO, unidadeDoBem
});
