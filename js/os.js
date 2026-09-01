/* =====================================================================
   SAKUMA Manutenção — etapa 3
   Painel de vencimentos e Ordem de Serviço.

   A OS impressa responde as quatro perguntas do Guilherme:
     1. QUAL PEÇA usar  — código de estoque, part number, quantidade, litragem
     2. QUANDO USOU     — data e horímetro da última troca, e o campo da troca de agora
     3. PRÓXIMO HORÍMETRO — em que marca a máquina volta para a oficina
     4. RESPONSÁVEL     — quem executa, com assinatura
   ===================================================================== */

/* ---------------------------------------------------------------- cálculo */

function leituraDe(e) {
  if (!e) return null;
  if (e.unidade_controle === 'ACUMULADO')
    return Number(e.rege_preventiva === 'KM' ? e.km_acumulados : e.horas_acumuladas);
  return e.leitura_atual === null || e.leitura_atual === undefined ? null : Number(e.leitura_atual);
}

function margemPadrao() {
  const p = q.todos('parametros').find(x => x.chave === 'margem_seguranca_horas');
  return p ? Number(p.valor) : 50;
}

/* Mesma conta do banco: o que vencer primeiro manda. */
function calcular(plano) {
  const e = q.por_id('equipamentos', plano.equipamento_id);
  const leitura = leituraDe(e);
  const margem = plano.margem_horas != null ? Number(plano.margem_horas) : margemPadrao();

  const r = { equipamento: e, leitura, status: 'SEM_DADO', motivo: '',
              horas_rodadas: null, horas_restantes: null, dias: null, proximo_hr: null };

  if (plano.periodicidade_horas != null && plano.ultima_troca_leitura != null) {
    r.proximo_hr = Number(plano.ultima_troca_leitura) + Number(plano.periodicidade_horas);
    if (leitura != null) {
      r.horas_rodadas = leitura - Number(plano.ultima_troca_leitura);
      r.horas_restantes = Number(plano.periodicidade_horas) - r.horas_rodadas;
    }
  }
  if (plano.periodicidade_dias != null && plano.ultima_troca_data) {
    r.dias = Math.floor((Date.now() - new Date(plano.ultima_troca_data + 'T00:00:00')) / 86400000);
  }

  if (r.horas_restantes != null && r.horas_restantes < 0) {
    r.status = 'TROCAR_URGENTE';
    r.motivo = 'venceu por hora — passou ' + nHoras(Math.abs(r.horas_restantes)) + ' h';
  } else if (r.horas_restantes != null && r.horas_restantes <= margem) {
    // A margem de segurança tem precedência sobre o período, como na planilha:
    // item dentro da margem aparece como ATENÇÃO mesmo com o prazo em dias vencido.
    r.status = 'ATENCAO';
    r.motivo = 'margem de segurança — faltam ' + nHoras(r.horas_restantes) + ' h';
  } else if (r.dias != null && r.dias > plano.periodicidade_dias) {
    r.status = 'PERIODO_VENCIDO';
    const atraso = r.dias - plano.periodicidade_dias;
    r.motivo = 'venceu por período — ' + atraso + (atraso === 1 ? ' dia' : ' dias') + ' além do prazo';
  } else if (r.horas_restantes != null || r.dias != null) {
    r.status = 'OK';
    r.motivo = r.horas_restantes != null ? 'faltam ' + nHoras(r.horas_restantes) + ' h' : 'dentro do prazo';
  } else {
    r.motivo = 'sem última troca lançada';
  }
  return r;
}

const ETIQUETA = {
  TROCAR_URGENTE: ['urgente', 'TROCAR URGENTE'],
  PERIODO_VENCIDO: ['vencido', 'PERÍODO VENCIDO'],
  ATENCAO: ['atencao', 'ATENÇÃO'],
  OK: ['ok', 'OK'],
  SEM_DADO: ['neutro', 'SEM DADO']
};

function etq(status) {
  const [cls, txt] = ETIQUETA[status] || ETIQUETA.SEM_DADO;
  return '<span class="etq ' + cls + '">' + txt + '</span>';
}

function nHoras(v) {
  return v === null || v === undefined ? '—' :
    Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/* ---------------------------------------------------------------- PAINEL */

/* ---------------------------------------------------------------- PAINEL

   Formato do quadro da planilha "Próximas Manutenções": uma linha por
   máquina, uma coluna por item de manutenção, e em cada cruzamento as
   horas restantes com o status. Clicar na célula marca para a OS. */

const MODOS = { quadro: 'Quadro', lista: 'Lista' };
let modoPainel = 'quadro';
const marcados = new Set();

TELAS.vencimentos = el => {
  el.innerHTML = `
    <h1>Painel de vencimentos</h1>
    <p class="sub">Máquinas e implementos juntos. Clique na célula do item para marcar,
       e gere a ordem de serviço — ela sai com a peça, o part number e o próximo horímetro.</p>
    <div class="filtros">
      <input type="search" id="pv-busca" placeholder="Buscar máquina">
      <select id="pv-status">
        <option value="pendentes">Só quem tem pendência</option>
        <option value="TROCAR_URGENTE">Só urgentes</option>
        <option value="PERIODO_VENCIDO">Só período vencido</option>
        <option value="ATENCAO">Só atenção</option>
        <option value="todos">Todas as máquinas</option>
      </select>
      <select id="pv-local"><option value="">Todos os locais</option>
        ${q.ordenado('locais').map(l => `<option value="${esc(l.id)}">${esc(l.nome)}</option>`).join('')}
      </select>
      <select id="pv-modo">
        <option value="quadro">Quadro</option>
        <option value="lista">Lista detalhada</option>
      </select>
    </div>
    <div id="pv-resumo" class="painel"></div>
    <div class="acoes">
      <button type="button" class="btn" id="pv-gerar" disabled>Gerar OS do que está marcado</button>
      <button type="button" class="btn neutro" id="pv-limpar">Limpar marcação</button>
    </div>
    <div id="pv-lista"></div>`;

  $('#pv-modo').value = modoPainel;
  ['pv-busca','pv-status','pv-local'].forEach(id => {
    const e = document.getElementById(id); e.oninput = desenharPainel; e.onchange = desenharPainel;
  });
  $('#pv-modo').onchange = () => { modoPainel = $('#pv-modo').value; desenharPainel(); };
  $('#pv-limpar').onclick = () => { marcados.clear(); desenharPainel(); };
  $('#pv-gerar').onclick = () => gerarOS([...marcados]);
  desenharPainel();
};

function botaoGerar() {
  const b = $('#pv-gerar');
  if (!b) return;
  b.disabled = marcados.size === 0;
  b.textContent = marcados.size === 0 ? 'Gerar OS do que está marcado'
    : 'Gerar OS de ' + marcados.size + (marcados.size === 1 ? ' item marcado' : ' itens marcados');
}

function desenharPainel() {
  const busca = ($('#pv-busca').value || '').toLowerCase();
  const fSt = $('#pv-status').value, fLo = $('#pv-local').value;

  // calcula tudo uma vez
  const todos = q.ativos('planos_manutencao').map(p => ({ plano: p, c: calcular(p) }))
    .filter(x => x.c.equipamento && x.c.equipamento.ativo !== false);

  const conta = st => todos.filter(x => x.c.status === st).length;
  $('#pv-resumo').innerHTML = `
    <div class="cartao alerta"><b>${conta('TROCAR_URGENTE')}</b><span>trocar urgente</span></div>
    <div class="cartao alerta"><b>${conta('PERIODO_VENCIDO')}</b><span>período vencido</span></div>
    <div class="cartao"><b>${conta('ATENCAO')}</b><span>atenção</span></div>
    <div class="cartao"><b>${conta('OK')}</b><span>em dia</span></div>`;

  // agrupa por máquina
  const porMaquina = new Map();
  for (const x of todos) {
    const e = x.c.equipamento;
    if (fLo && e.local_id !== fLo) continue;
    if (busca && !(e.codigo + ' ' + e.descricao).toLowerCase().includes(busca)) continue;
    if (!porMaquina.has(e.id)) porMaquina.set(e.id, { equipamento: e, itens: {} });
    porMaquina.get(e.id).itens[x.plano.tipo_manutencao_id] = x;
  }

  // colunas: só os itens que alguma máquina realmente usa
  const usados = new Set(todos.map(x => x.plano.tipo_manutencao_id));
  const colunas = q.ordenado('tipos_manutencao', 'ordem')
    .filter(t => usados.has(t.id))
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));

  let linhas = [...porMaquina.values()].map(m => {
    const lista = Object.values(m.itens);
    m.urgentes = lista.filter(x => x.c.status === 'TROCAR_URGENTE').length;
    m.pendentes = lista.filter(x => ['TROCAR_URGENTE','PERIODO_VENCIDO','ATENCAO'].includes(x.c.status)).length;
    m.pior = Math.min(...lista.map(x => x.c.horas_restantes ?? 9e9));
    return m;
  });

  if (fSt === 'pendentes') linhas = linhas.filter(m => m.pendentes > 0);
  else if (fSt !== 'todos') linhas = linhas.filter(m => Object.values(m.itens).some(x => x.c.status === fSt));

  linhas.sort((a, b) => (b.urgentes - a.urgentes) || (a.pior - b.pior)
    || a.equipamento.codigo.localeCompare(b.equipamento.codigo, 'pt-BR', { numeric: true }));

  $('#pv-lista').innerHTML = linhas.length === 0
    ? '<div class="vazio"><p>Nada com esses filtros.</p></div>'
    : (modoPainel === 'quadro' ? quadro(linhas, colunas) : listaDetalhada(linhas));

  $('#pv-lista').querySelectorAll('[data-plano]').forEach(c => c.onclick = () => {
    const id = c.dataset.plano;
    marcados.has(id) ? marcados.delete(id) : marcados.add(id);
    c.classList.toggle('marcada');
    botaoGerar();
  });
  botaoGerar();
}

const CURTO = { TROCAR_URGENTE:'URGENTE', PERIODO_VENCIDO:'PERÍODO', ATENCAO:'ATENÇÃO', OK:'OK', SEM_DADO:'—' };

function quadro(linhas, colunas) {
  const cab = colunas.map(t => `<th class="num">${esc(t.nome)}</th>`).join('');
  return `<p class="sub">${linhas.length} ${linhas.length === 1 ? 'máquina' : 'máquinas'} ·
      clique na célula para marcar o item</p>
    <div class="rolagem"><table class="tabela quadro"><thead><tr>
      <th>Código</th><th>Máquina / equipamento</th><th class="num">Leitura</th>
      ${cab}<th class="num">Urgentes</th>
    </tr></thead><tbody>` + linhas.map(m => {
      const e = m.equipamento;
      return `<tr>
        <td class="codigo">${esc(e.codigo)}</td>
        <td>${esc(e.descricao)}</td>
        <td class="num">${nHoras(leituraDe(e))}</td>
        ${colunas.map(t => {
          const x = m.itens[t.id];
          if (!x) return '<td class="cel vazia">—</td>';
          const [cls] = ETIQUETA[x.c.status] || ETIQUETA.SEM_DADO;
          const pecas = q.ativos('pecas_equipamento').filter(v =>
            v.equipamento_id === e.id && v.tipo_manutencao_id === t.id).length;
          return `<td class="cel st-${cls}${marcados.has(x.plano.id) ? ' marcada' : ''}"
                      data-plano="${esc(x.plano.id)}"
                      title="${esc(x.c.motivo)}${pecas ? ' · ' + pecas + ' peça(s)' : ' · sem peça cadastrada'}">
            <strong>${x.c.horas_restantes != null ? nHoras(x.c.horas_restantes) : '—'}</strong>
            <span>${CURTO[x.c.status]}</span>
            ${pecas === 0 ? '<em>sem peça</em>' : ''}
          </td>`;
        }).join('')}
        <td class="num">${m.urgentes || ''}</td>
      </tr>`;
    }).join('') + '</tbody></table></div>';
}

function listaDetalhada(linhas) {
  const itens = [];
  linhas.forEach(m => Object.values(m.itens).forEach(x => itens.push(x)));
  itens.sort((a, b) => (a.c.horas_restantes ?? 9e9) - (b.c.horas_restantes ?? 9e9));
  return `<p class="sub">${itens.length} itens</p>
    <table class="tabela"><thead><tr>
      <th>Máquina</th><th>Item</th><th class="num">Leitura</th><th class="num">Última troca</th>
      <th class="num">Próximo hr</th><th>Situação</th><th class="num">Peças</th>
    </tr></thead><tbody>` + itens.map(({plano, c}) => {
      const pecas = q.ativos('pecas_equipamento').filter(v =>
        v.equipamento_id === plano.equipamento_id && v.tipo_manutencao_id === plano.tipo_manutencao_id).length;
      return `<tr class="cel${marcados.has(plano.id) ? ' marcada' : ''}" data-plano="${esc(plano.id)}">
        <td><span class="codigo">${esc(c.equipamento.codigo)}</span><br><small>${esc(c.equipamento.descricao)}</small></td>
        <td>${esc(q.nome('tipos_manutencao', plano.tipo_manutencao_id))}</td>
        <td class="num">${nHoras(c.leitura)}</td>
        <td class="num">${plano.ultima_troca_data ? formatarData(plano.ultima_troca_data) : '—'}
            <br><small>${nHoras(plano.ultima_troca_leitura)}</small></td>
        <td class="num"><strong>${nHoras(c.proximo_hr)}</strong></td>
        <td>${etq(c.status)}<br><small>${esc(c.motivo)}</small></td>
        <td class="num">${pecas === 0 ? '<span class="etq atencao">nenhuma</span>' : pecas}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

/* ---------------------------------------------------------------- gerar OS */

/* Uma OS por máquina. Se as máquinas forem várias, sai uma OS para cada. */
async function gerarOS(idsPlanos) {
  const planos = idsPlanos.map(id => q.por_id('planos_manutencao', id)).filter(Boolean);
  const porMaquina = {};
  planos.forEach(p => (porMaquina[p.equipamento_id] = porMaquina[p.equipamento_id] || []).push(p));

  const criadas = [];
  for (const [idEq, lista] of Object.entries(porMaquina)) {
    const e = q.por_id('equipamentos', idEq);
    const os = {
      id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
      equipamento_id: idEq, local_id: e.local_id,
      data_emissao: new Date().toISOString().slice(0, 10),
      status: 'ABERTA', leitura_emissao: leituraDe(e)
    };
    await gravar('ordens_servico', os);

    for (const p of lista) {
      const c = calcular(p);
      const item = {
        id: crypto.randomUUID(), os_id: os.id, equipamento_id: idEq,
        tipo_manutencao_id: p.tipo_manutencao_id, plano_id: p.id,
        motivo: c.motivo, periodicidade_horas: p.periodicidade_horas,
        periodicidade_dias: p.periodicidade_dias, horas_restantes: c.horas_restantes,
        feito: false
      };
      await gravar('os_itens', item);

      // A lista de peças é CONGELADA aqui: o impresso de hoje não muda se o
      // cadastro da peça for alterado amanhã.
      const vinculos = q.ativos('pecas_equipamento').filter(v =>
        v.equipamento_id === idEq && v.tipo_manutencao_id === p.tipo_manutencao_id);
      for (const v of vinculos) {
        const pc = q.por_id('pecas', v.peca_id) || {};
        await gravar('os_pecas', {
          id: crypto.randomUUID(), os_item_id: item.id, peca_id: v.peca_id,
          codigo_estoque: pc.codigo_estoque || '(sem código)', descricao: pc.descricao || '',
          part_number: pc.part_number || null, quantidade: v.quantidade,
          especificacao: v.especificacao || pc.especificacao || null, retirada: false
        });
      }
    }
    criadas.push(os.id);
  }
  aviso(criadas.length === 1 ? 'Ordem de serviço criada.' : criadas.length + ' ordens criadas.');
  criadas.length === 1 ? abrirOS(criadas[0]) : irPara('ordens');
}

/* ---------------------------------------------------------------- anomalias

   O segundo caminho para a OS. A anomalia vem do check list de campo (item
   marcado RUIM) ou é aberta na mão. Serve para o que não é preventiva —
   o filtro de ar-condicionado, por exemplo, que só troca quando está ruim. */

TELAS.anomalias = el => {
  el.innerHTML = `
    <h1>Anomalias</h1>
    <p class="sub">O que o campo apontou. Toda anomalia com máquina pode virar ordem de
       serviço — e a OS já sai com as peças daquele item, mesmo sem plano de manutenção.</p>
    <div class="filtros">
      <input type="search" id="an-busca" placeholder="Buscar por máquina ou descrição">
      <select id="an-status">
        <option value="Aberto">Abertas</option>
        <option value="Fechado">Fechadas</option>
        <option value="todas">Todas</option>
      </select>
      <select id="an-prio"><option value="">Todas as prioridades</option>
        <option value="Alta">Alta</option><option value="Média">Média</option><option value="Baixa">Baixa</option>
      </select>
    </div>
    <div id="an-lista"></div>`;

  const desenhar = () => {
    const busca = ($('#an-busca').value || '').toLowerCase();
    const st = $('#an-status').value, pr = $('#an-prio').value;
    const lista = q.todos('anomalias').filter(a => {
      if (st !== 'todas' && a.status !== st) return false;
      if (pr && a.prioridade !== pr) return false;
      const e = a.equipamento_id ? q.por_id('equipamentos', a.equipamento_id) : null;
      if (busca) {
        const alvo = ((e ? e.codigo + ' ' + e.descricao : '') + ' ' + (a.descricao || '')).toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    }).sort((a, b) => (b.data_abertura || '').localeCompare(a.data_abertura || ''));

    $('#an-lista').innerHTML = lista.length === 0
      ? '<div class="vazio"><p>Nada com esses filtros.</p></div>'
      : `<p class="sub">${lista.length} ${lista.length === 1 ? 'anomalia' : 'anomalias'}</p>
         <ul class="lista">` + lista.map(a => {
        const e = a.equipamento_id ? q.por_id('equipamentos', a.equipamento_id) : null;
        const prio = a.prioridade === 'Alta' ? 'urgente' : (a.prioridade === 'Média' ? 'atencao' : 'neutro');
        const vencida = a.status === 'Aberto' && a.prazo && a.prazo < new Date().toISOString().slice(0,10);
        return `<li>
          <div class="info">
            <strong>${a.numero ? 'Nº ' + a.numero + ' · ' : ''}${esc(e ? e.codigo : 'sem máquina')}</strong>
            <small>${esc(a.descricao)}</small>
            <small>${esc(a.tipo)}${a.tipo_manutencao_id ? ' · ' + esc(q.nome('tipos_manutencao', a.tipo_manutencao_id)) : ''}
              · aberta em ${formatarData(a.data_abertura)}
              ${vencida ? ' · <span style="color:var(--urgente)">prazo vencido</span>' : ''}</small>
          </div>
          <span class="etq ${prio}">${esc(a.prioridade)}</span>
          ${a.status === 'Aberto' && e
            ? `<button type="button" class="btn" data-gerar="${esc(a.id)}">Gerar OS</button>`
            : `<span class="etq ${a.status === 'Fechado' ? 'ok' : 'neutro'}">${esc(a.status)}</span>`}
          ${a.ordem_servico_id ? `<button type="button" class="btn-fantasma" data-veros="${esc(a.ordem_servico_id)}">Ver OS</button>` : ''}
        </li>`;
      }).join('') + '</ul>';

    $('#an-lista').querySelectorAll('[data-gerar]').forEach(b =>
      b.onclick = () => gerarOSdeAnomalia(q.por_id('anomalias', b.dataset.gerar)));
    $('#an-lista').querySelectorAll('[data-veros]').forEach(b =>
      b.onclick = () => abrirOS(b.dataset.veros));
  };
  ['an-busca','an-status','an-prio'].forEach(id => {
    const e = document.getElementById(id); e.oninput = desenhar; e.onchange = desenhar;
  });
  desenhar();
};

/* A anomalia pode não ter item de manutenção — o check list aponta "ar-condicionado
   ruim", não "filtro de cabine". Então perguntamos qual item resolve, e é dele que
   sai a lista de peças. */
function gerarOSdeAnomalia(anomalia) {
  const e = q.por_id('equipamentos', anomalia.equipamento_id);
  const tipos = q.ordenado('tipos_manutencao');

  abrirModal('Gerar OS da anomalia' + (anomalia.numero ? ' nº ' + anomalia.numero : ''), `
    <p class="sub"><strong>${esc(e.codigo)}</strong> — ${esc(e.descricao)}</p>
    <p class="os-alerta" style="background:#F3F6EC;border-left-color:var(--verde)">${esc(anomalia.descricao)}</p>
    ${campoLista('Item de manutenção que resolve', 'tipo_manutencao_id', tipos, anomalia.tipo_manutencao_id)}
    <p class="ajuda">É por este item que a OS busca as peças. Sem plano de manutenção
       funciona igual: a OS sai corretiva, sem cálculo de próximo vencimento.</p>
    ${campoTexto('Prazo', 'prazo', anomalia.prazo, 'date')}
    <div id="ga-previa"></div>
    <div class="acoes">
      <button type="button" class="btn" id="ga-ok">Gerar OS</button>
      <button type="button" class="btn neutro" id="ga-cancelar">Cancelar</button>
    </div>`, corpo => {
    const previa = () => {
      const id = corpo.querySelector('#f-tipo_manutencao_id').value;
      const pecas = q.ativos('pecas_equipamento').filter(v =>
        v.equipamento_id === anomalia.equipamento_id && v.tipo_manutencao_id === id);
      corpo.querySelector('#ga-previa').innerHTML = !id ? '' : (pecas.length === 0
        ? '<p class="os-alerta">Este item não tem peça vinculada nesta máquina. A OS sai sem lista de retirada.</p>'
        : '<p class="sub">' + pecas.length + (pecas.length === 1 ? ' peça vai' : ' peças vão') + ' para a OS: ' +
          pecas.map(v => esc((q.por_id('pecas', v.peca_id) || {}).codigo_estoque)).join(', ') + '</p>');
    };
    corpo.querySelector('#f-tipo_manutencao_id').onchange = previa;
    previa();
    corpo.querySelector('#ga-cancelar').onclick = () => irPara('anomalias');
    corpo.querySelector('#ga-ok').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.tipo_manutencao_id) return aviso('Escolha o item de manutenção.', true);

      const os = {
        id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
        equipamento_id: anomalia.equipamento_id, local_id: e.local_id,
        data_emissao: new Date().toISOString().slice(0, 10), prazo: d.prazo,
        status: 'ABERTA', leitura_emissao: leituraDe(e),
        observacao: 'Aberta pela anomalia' + (anomalia.numero ? ' nº ' + anomalia.numero : '') +
                    ': ' + (anomalia.descricao || '')
      };
      await gravar('ordens_servico', os);

      const plano = q.ativos('planos_manutencao').find(p =>
        p.equipamento_id === anomalia.equipamento_id && p.tipo_manutencao_id === d.tipo_manutencao_id);
      const item = {
        id: crypto.randomUUID(), os_id: os.id, equipamento_id: anomalia.equipamento_id,
        tipo_manutencao_id: d.tipo_manutencao_id, plano_id: plano ? plano.id : null,
        motivo: 'anomalia apontada em campo', feito: false,
        periodicidade_horas: plano ? plano.periodicidade_horas : null,
        periodicidade_dias: plano ? plano.periodicidade_dias : null
      };
      await gravar('os_itens', item);

      for (const v of q.ativos('pecas_equipamento').filter(x =>
            x.equipamento_id === anomalia.equipamento_id && x.tipo_manutencao_id === d.tipo_manutencao_id)) {
        const pc = q.por_id('pecas', v.peca_id) || {};
        await gravar('os_pecas', {
          id: crypto.randomUUID(), os_item_id: item.id, peca_id: v.peca_id,
          codigo_estoque: pc.codigo_estoque || '(sem código)', descricao: pc.descricao || '',
          part_number: pc.part_number || null, quantidade: v.quantidade,
          especificacao: v.especificacao || pc.especificacao || null, retirada: false
        });
      }

      anomalia.ordem_servico_id = os.id;
      if (d.prazo) anomalia.prazo = d.prazo;
      await gravar('anomalias', anomalia);

      aviso('OS aberta a partir da anomalia.');
      abrirOS(os.id);
    };
  });
}

/* ---------------------------------------------------------------- lista de OS */

TELAS.ordens = el => {
  el.innerHTML = `
    <h1>Ordens de serviço</h1>
    <p class="sub">Aberta → Em execução → Concluída. Ao concluir, o app baixa a data e o
       horímetro da troca no histórico e recalcula o próximo vencimento sozinho.</p>
    <div class="filtros">
      <select id="os-status">
        <option value="abertas">Abertas e em execução</option>
        <option value="CONCLUIDA">Concluídas</option>
        <option value="todas">Todas</option>
      </select>
      <input type="search" id="os-busca" placeholder="Buscar por número ou máquina">
    </div>
    <div id="os-lista"></div>`;

  const desenhar = () => {
    const st = $('#os-status').value, busca = ($('#os-busca').value || '').toLowerCase();
    const lista = q.todos('ordens_servico').filter(o => {
      if (st === 'abertas' && !['ABERTA','EM_EXECUCAO'].includes(o.status)) return false;
      if (st === 'CONCLUIDA' && o.status !== 'CONCLUIDA') return false;
      const e = q.por_id('equipamentos', o.equipamento_id);
      if (busca) {
        const alvo = ((o.numero || '') + ' ' + (e ? e.codigo + ' ' + e.descricao : '')).toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    }).sort((a, b) => (b.data_emissao || '').localeCompare(a.data_emissao || ''));

    $('#os-lista').innerHTML = lista.length === 0
      ? '<div class="vazio"><p>Nenhuma ordem de serviço. Gere pelo painel de vencimentos.</p></div>'
      : '<ul class="lista">' + lista.map(o => {
          const e = q.por_id('equipamentos', o.equipamento_id);
          const itens = q.todos('os_itens').filter(i => i.os_id === o.id);
          const cls = o.status === 'CONCLUIDA' ? 'ok' : (o.status === 'CANCELADA' ? 'neutro' : 'atencao');
          return `<li>
            <div class="info">
              <strong>OS ${o.numero || '(nova)'} · ${esc(e ? e.codigo : '?')}</strong>
              <small>${esc(e ? e.descricao : '')}</small>
              <small>${formatarData(o.data_emissao)} · ${itens.length} ${itens.length === 1 ? 'serviço' : 'serviços'}</small>
            </div>
            <span class="etq ${cls}">${esc(o.status)}</span>
            <button type="button" class="btn-fantasma" data-os="${esc(o.id)}">Abrir</button>
          </li>`;
        }).join('') + '</ul>';

    $('#os-lista').querySelectorAll('[data-os]').forEach(b => b.onclick = () => abrirOS(b.dataset.os));
  };
  $('#os-status').onchange = desenhar;
  $('#os-busca').oninput = desenhar;
  desenhar();
};

/* ---------------------------------------------------------------- a OS em si */

function abrirOS(idOS) {
  const os = q.por_id('ordens_servico', idOS);
  const e = q.por_id('equipamentos', os.equipamento_id);
  const itens = q.todos('os_itens').filter(i => i.os_id === idOS);
  const concluida = os.status === 'CONCLUIDA';

  const blocos = itens.map(it => {
    const pecas = q.todos('os_pecas').filter(p => p.os_item_id === it.id);
    const plano = it.plano_id ? q.por_id('planos_manutencao', it.plano_id) : null;
    const proximo = plano && plano.ultima_troca_leitura != null && plano.periodicidade_horas != null
      ? Number(plano.ultima_troca_leitura) + Number(plano.periodicidade_horas) : null;
    // Depois da troca, o próximo vencimento passa a contar do horímetro de agora.
    const proximoDepois = it.leitura_troca != null && it.periodicidade_horas != null
      ? Number(it.leitura_troca) + Number(it.periodicidade_horas) : null;

    // Item sem plano é corretiva: não tem periodicidade nem próximo vencimento.
    const preventiva = !!(it.periodicidade_horas || it.periodicidade_dias);

    return `
    <section class="os-servico">
      <h3>${esc(q.nome('tipos_manutencao', it.tipo_manutencao_id))}
        ${preventiva ? '' : '<span class="etq neutro">corretiva</span>'}</h3>
      <table class="tabela"><tbody>
        ${preventiva ? `<tr><td>Periodicidade</td><td>
          ${it.periodicidade_horas ? nHoras(it.periodicidade_horas) + ' h' : ''}
          ${it.periodicidade_dias ? (it.periodicidade_horas ? ' ou ' : '') + it.periodicidade_dias + ' dias' : ''}
          <small> (o que vencer primeiro)</small></td></tr>` : ''}
        <tr><td>Motivo</td><td>${esc(it.motivo || '')}</td></tr>
        ${preventiva ? `<tr><td><strong>Quando usou</strong> — última troca</td>
            <td>${plano && plano.ultima_troca_data ? formatarData(plano.ultima_troca_data) : '—'}
                &nbsp;·&nbsp; ${nHoras(plano ? plano.ultima_troca_leitura : null)} h</td></tr>
        <tr><td><strong>Próximo horímetro</strong></td>
            <td class="os-destaque">${nHoras(proximoDepois ?? proximo)} h
            ${proximoDepois ? '<small> (recalculado pela troca de agora)</small>' : ''}</td></tr>`
          : `<tr><td><strong>Próximo horímetro</strong></td>
            <td>troca por condição — sem vencimento programado</td></tr>`}
      </tbody></table>

      <h4>Peças a retirar no estoque</h4>
      ${pecas.length === 0
        ? '<p class="os-alerta">Nenhuma peça cadastrada para este item. Cadastre em “Peças por máquina” antes de mandar para a oficina.</p>'
        : `<table class="tabela"><thead><tr>
             <th>Código estoque</th><th>Descrição</th><th>Part number</th>
             <th class="num">Qtde</th><th>Especificação</th><th>Retirada</th>
           </tr></thead><tbody>` + pecas.map(p => `<tr>
             <td class="codigo">${esc(p.codigo_estoque)}</td>
             <td>${esc(p.descricao)}</td>
             <td>${esc(p.part_number)}</td>
             <td class="num">${esc(p.quantidade)}</td>
             <td>${esc(p.especificacao)}</td>
             <td class="os-caixa">☐</td></tr>`).join('') + '</tbody></table>'}

      <table class="tabela os-manual"><tbody>
        <tr><td>Data da troca</td><td>${it.data_troca ? formatarData(it.data_troca) : '____ / ____ / ______'}</td>
            <td>Horímetro na troca</td><td>${it.leitura_troca != null ? nHoras(it.leitura_troca) : '________________'}</td>
            <td>FEITO</td><td class="os-caixa">${it.feito ? '☑' : '☐'}</td></tr>
      </tbody></table>
    </section>`;
  }).join('');

  const html = `
    <div id="os-impresso">
      <header class="os-topo">
        <div>
          <strong class="os-marca">SAKUMA</strong>
          <span>Agronegócios</span>
        </div>
        <div class="os-titulo">
          <h2>ORDEM DE SERVIÇO Nº ${os.numero || '(nova)'}</h2>
          <p>Emitida em ${formatarData(os.data_emissao)}${os.prazo ? ' · prazo ' + formatarData(os.prazo) : ''}</p>
        </div>
      </header>

      <table class="tabela"><tbody>
        <tr><td>Máquina</td><td><strong>${esc(e.codigo)}</strong> — ${esc(e.descricao)}</td></tr>
        <tr><td>Marca / modelo</td><td>${esc(q.nome('marcas', e.marca_id))} ${esc(e.modelo || '')}</td></tr>
        <tr><td>Local</td><td>${esc(q.nome('locais', e.local_id))}${e.setor_id ? ' · ' + esc(q.nome('setores', e.setor_id)) : ''}</td></tr>
        <tr><td>Leitura na emissão</td><td>${nHoras(os.leitura_emissao)} ${e.unidade_controle === 'HODOMETRO' ? 'km' : 'h'}</td></tr>
        <tr><td><strong>Responsável pela execução</strong></td>
            <td class="os-destaque">${os.executor_id ? esc(q.nome('mecanicos', os.executor_id)) : '______________________________'}</td></tr>
      </tbody></table>

      ${blocos}

      <table class="tabela os-assinaturas"><tbody><tr>
        <td>Assinatura do mecânico<br><br>_____________________________</td>
        <td>Conferente do estoque<br><br>_____________________________</td>
      </tr></tbody></table>

      <p class="os-rodape">Lembrete do procedimento: a <strong>foto do adesivo de troca é obrigatória</strong>
         e precisa estar legível. Sem ficha preenchida e foto, a troca não é considerada concluída.</p>
      <p class="os-lop">Desenvolvido por LOP · Inteligência para o agronegócio</p>
    </div>

    <div class="acoes">
      <button type="button" class="btn" id="os-imprimir">Imprimir</button>
      ${concluida ? '' : '<button type="button" class="btn secundario" id="os-concluir">Concluir a troca</button>'}
      ${concluida ? '' : '<button type="button" class="btn neutro" id="os-cancelar">Cancelar OS</button>'}
    </div>`;

  abrirModal('OS ' + (os.numero || '') + ' — ' + e.codigo, html, corpo => {
    corpo.querySelector('#os-imprimir').onclick = () => {
      document.body.classList.add('imprimindo-os');
      window.print();
      setTimeout(() => document.body.classList.remove('imprimindo-os'), 500);
    };
    const bc = corpo.querySelector('#os-concluir');
    if (bc) bc.onclick = () => formConclusao(os, itens);
    const bx = corpo.querySelector('#os-cancelar');
    if (bx) bx.onclick = async () => {
      if (!confirm('Cancelar esta OS?')) return;
      os.status = 'CANCELADA'; await gravar('ordens_servico', os);
      fecharModal(); irPara('ordens'); aviso('OS cancelada.');
    };
  });
}

/* ---------------------------------------------------------------- conclusão */

function formConclusao(os, itens) {
  const e = q.por_id('equipamentos', os.equipamento_id);
  const hoje = new Date().toISOString().slice(0, 10);

  abrirModal('Concluir a OS ' + (os.numero || ''), `
    <p class="sub">${esc(e.codigo)} — ${esc(e.descricao)}. Sem data, horímetro e foto do
       adesivo a OS não fecha: é a regra do procedimento da empresa.</p>
    <div class="colunas">
      ${campoLista('Responsável pela execução', 'executor_id', q.ordenado('mecanicos'), os.executor_id)}
      ${campoTexto('Data da troca', 'data_execucao', hoje, 'date')}
      ${campoTexto('Horímetro no momento da troca', 'leitura_execucao', leituraDe(e), 'number',
        'O valor exato no momento da troca, nunca estimado')}
      ${campoTexto('Conferente do estoque', 'conferente_estoque', os.conferente_estoque)}
    </div>
    <div class="campo">
      <label for="os-foto">Foto do adesivo de troca</label>
      <input type="file" id="os-foto" accept="image/*" capture="environment">
      <p class="ajuda">Obrigatória e legível. Fica guardada no aparelho e sobe sozinha quando houver sinal.</p>
    </div>
    ${campoArea('O que foi feito', 'observacao', '')}
    <div class="acoes">
      <button type="button" class="btn" id="cc-salvar">Concluir</button>
      <button type="button" class="btn neutro" id="cc-cancelar">Voltar</button>
    </div>`, corpo => {
    corpo.querySelector('#cc-cancelar').onclick = () => abrirOS(os.id);
    corpo.querySelector('#cc-salvar').onclick = async () => {
      const d = lerForm(corpo);
      const foto = corpo.querySelector('#os-foto').files[0];
      if (!d.executor_id) return aviso('Informe o responsável pela execução.', true);
      if (!d.data_execucao) return aviso('Informe a data da troca.', true);
      if (d.leitura_execucao === null) return aviso('Informe o horímetro no momento da troca.', true);
      if (!foto) return aviso('A foto do adesivo é obrigatória.', true);

      const btn = corpo.querySelector('#cc-salvar');
      btn.disabled = true; btn.textContent = 'Gravando…';

      const leitura = num(d.leitura_execucao);
      const caminho = await guardarFoto(foto, 'manutencao-ordens-servico', os.id);

      // 1. a leitura entra no histórico e atualiza a máquina
      await gravar('leituras', {
        id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
        equipamento_id: os.equipamento_id, data_leitura: d.data_execucao,
        valor: leitura, origem: 'ORDEM_SERVICO',
        observacao: 'Lançada na conclusão da OS ' + (os.numero || ''),
        registrado_em: new Date().toISOString()
      });
      const eq = q.por_id('equipamentos', os.equipamento_id);
      if (eq && eq.unidade_controle !== 'ACUMULADO') {
        eq.leitura_atual = leitura; eq.leitura_data = d.data_execucao;
      }

      // 2. cada serviço vira histórico e recalcula o vencimento do plano
      for (const it of itens) {
        it.feito = true; it.data_troca = d.data_execucao; it.leitura_troca = leitura;
        await gravar('os_itens', it);

        const plano = it.plano_id ? q.por_id('planos_manutencao', it.plano_id) : null;
        if (plano) {
          plano.ultima_troca_data = d.data_execucao;
          plano.ultima_troca_leitura = leitura;
          plano.ultima_os_id = os.id;
          await gravar('planos_manutencao', plano);
        }

        const man = {
          id: crypto.randomUUID(), uuid_dispositivo: crypto.randomUUID(),
          equipamento_id: os.equipamento_id, tipo_manutencao_id: it.tipo_manutencao_id,
          local_id: os.local_id, data_manutencao: d.data_execucao, leitura,
          mecanico_id: d.executor_id, os_id: os.id,
          observacao: d.observacao, foto_adesivo_path: caminho,
          registrado_em: new Date().toISOString()
        };
        await gravar('manutencoes', man);

        for (const p of q.todos('os_pecas').filter(x => x.os_item_id === it.id)) {
          await gravar('manutencao_pecas', {
            id: crypto.randomUUID(), manutencao_id: man.id, peca_id: p.peca_id,
            codigo_estoque: p.codigo_estoque, descricao: p.descricao, quantidade: p.quantidade
          });
        }
      }

      // 3. fecha a OS
      Object.assign(os, {
        status: 'CONCLUIDA', executor_id: d.executor_id, data_execucao: d.data_execucao,
        leitura_execucao: leitura, conferente_estoque: d.conferente_estoque,
        observacao: d.observacao, concluida_em: new Date().toISOString()
      });
      await gravar('ordens_servico', os);
      await gravar('os_fotos', {
        id: crypto.randomUUID(), os_id: os.id, tipo: 'ADESIVO', storage_path: caminho
      });

      // Anomalia que gerou esta OS fecha junto, com o que foi feito e por quem.
      for (const a of q.todos('anomalias').filter(x => x.ordem_servico_id === os.id && x.status === 'Aberto')) {
        a.status = 'Fechado';
        a.data_fechamento = d.data_execucao;
        a.mecanico_id = d.executor_id;
        a.solucao = (d.observacao ? d.observacao + ' — ' : '') +
          'resolvida pela OS' + (os.numero ? ' nº ' + os.numero : '') + ' em ' + formatarData(d.data_execucao);
        await gravar('anomalias', a);
      }

      aviso(App.online ? 'Troca lançada e próximo vencimento recalculado.'
                       : 'Salvo no aparelho. Sobe quando a internet voltar.');
      abrirOS(os.id);
    };
  });
}
