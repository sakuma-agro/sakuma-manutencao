/* =====================================================================
   SAKUMA Manutenção — telas da etapa 1: cadastros e peças
   ===================================================================== */

/* ---------------------------------------------------------------- helpers de form */

function campoTexto(rot, nome, valor = '', tipo = 'text', ajuda = '') {
  return `<div class="campo"><label for="f-${nome}">${esc(rot)}</label>
    <input type="${tipo}" id="f-${nome}" name="${nome}" value="${esc(valor ?? '')}">
    ${ajuda ? `<p class="ajuda">${esc(ajuda)}</p>` : ''}</div>`;
}

function campoArea(rot, nome, valor = '') {
  return `<div class="campo"><label for="f-${nome}">${esc(rot)}</label>
    <textarea id="f-${nome}" name="${nome}">${esc(valor ?? '')}</textarea></div>`;
}

function campoLista(rot, nome, opcoes, valor, vazio = '— selecione —') {
  const ops = opcoes.map(o => {
    const id = o.id ?? o.valor ?? o;
    const txt = o.nome ?? o.descricao ?? o.valor ?? o;
    return `<option value="${esc(id)}"${String(id) === String(valor) ? ' selected' : ''}>${esc(txt)}</option>`;
  }).join('');
  return `<div class="campo"><label for="f-${nome}">${esc(rot)}</label>
    <select id="f-${nome}" name="${nome}"><option value="">${esc(vazio)}</option>${ops}</select></div>`;
}

function lerForm(corpo) {
  const dados = {};
  corpo.querySelectorAll('input,select,textarea').forEach(el => {
    if (!el.name) return;
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    dados[el.name] = (v === '' ? null : v);
  });
  return dados;
}

function num(v) { return v === null || v === '' ? null : Number(String(v).replace(',', '.')); }

/* ---------------------------------------------------------------- INÍCIO */

const TELAS = {};
window.TELAS = TELAS;

TELAS.inicio = el => {
  const eq = q.ativos('equipamentos');
  const pecas = q.ativos('pecas');
  const vinc = q.ativos('pecas_equipamento');
  const planos = q.ativos('planos_manutencao');

  // Máquinas com plano mas sem nenhuma peça vinculada: são as que vão gerar
  // ordem de serviço sem lista de retirada. É a pendência que importa agora.
  const comVinculo = new Set(vinc.map(v => v.equipamento_id));
  const comPlano = new Set(planos.map(p => p.equipamento_id));
  const semPecas = [...comPlano].filter(id => !comVinculo.has(id));

  const porTipo = {};
  eq.forEach(e => { const t = q.nome('tipos_equipamento', e.tipo_equipamento_id) || 'Sem tipo';
                    porTipo[t] = (porTipo[t] || 0) + 1; });

  el.innerHTML = `
    <h1>Olá, ${esc((App.usuario.nome || '').split(' ')[0])}</h1>
    <p class="sub">Etapa 1 do app: cadastros e peças. É aqui que você monta a lista de
       retirada do estoque que vai sair impressa na ordem de serviço.</p>

    <div class="painel">
      <div class="cartao"><b>${eq.length}</b><span>bens cadastrados</span></div>
      <div class="cartao"><b>${pecas.length}</b><span>peças no catálogo</span></div>
      <div class="cartao"><b>${vinc.length}</b><span>peças vinculadas a máquinas</span></div>
      <div class="cartao ${semPecas.length ? 'alerta' : ''}"><b>${semPecas.length}</b>
        <span>máquinas com plano e nenhuma peça</span></div>
    </div>

    ${semPecas.length ? `
      <h2>Máquinas que ainda geram OS sem peça</h2>
      <p class="sub">Enquanto estas máquinas não tiverem peça vinculada, a ordem de serviço
         sai dizendo "trocar filtro de ar" sem dizer qual filtro é.</p>
      <ul class="lista">
        ${semPecas.slice(0, 12).map(id => {
          const e = q.por_id('equipamentos', id);
          return e ? `<li><div class="info"><span class="codigo">${esc(e.codigo)}</span>
            ${esc(e.descricao)}</div>
            <button type="button" class="btn" data-vincular="${esc(e.id)}">Cadastrar peças</button></li>` : '';
        }).join('')}
      </ul>
      ${semPecas.length > 12 ? `<p class="sub">e mais ${semPecas.length - 12}.</p>` : ''}
    ` : ''}

    <h2>Frota por família</h2>
    <ul class="lista">
      ${Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        `<li><div class="info">${esc(t)}</div><strong>${n}</strong></li>`).join('')}
    </ul>`;

  el.querySelectorAll('[data-vincular]').forEach(b => b.onclick = () => {
    irPara('vinculos');
    setTimeout(() => {
      const s = document.querySelector('#vi-maquina');
      if (s) { s.value = b.dataset.vincular; s.dispatchEvent(new Event('change')); }
    }, 30);
  });
};

/* ---------------------------------------------------------------- BENS */

TELAS.equipamentos = el => {
  el.innerHTML = `
    <h1>Bens</h1>
    <p class="sub">Máquinas, implementos, veículos, irrigação, vasos de pressão e estruturas.
       Cadastro em uso nunca é apagado — é inativado, e o histórico continua íntegro.</p>
    <div class="filtros">
      <input type="search" id="eq-busca" placeholder="Buscar por código, descrição, modelo ou série">
      ${campoListaInline('eq-tipo', 'Todas as famílias', q.ordenado('tipos_equipamento'))}
      ${campoListaInline('eq-local', 'Todos os locais', q.ordenado('locais'))}
      <select id="eq-status">
        <option value="ativos">Ativos</option>
        <option value="todos">Ativos e inativos</option>
        <option value="inativos">Só inativos</option>
      </select>
    </div>
    <div class="acoes">
      <button type="button" class="btn" id="eq-novo">Cadastrar bem</button>
    </div>
    <div id="eq-lista"></div>`;

  const desenhar = () => {
    const busca = ($('#eq-busca').value || '').toLowerCase();
    const tipo = $('#eq-tipo').value, local = $('#eq-local').value, st = $('#eq-status').value;
    let lista = q.todos('equipamentos').filter(e => {
      if (st === 'ativos' && e.ativo === false) return false;
      if (st === 'inativos' && e.ativo !== false) return false;
      if (tipo && e.tipo_equipamento_id !== tipo) return false;
      if (local && e.local_id !== local) return false;
      if (busca) {
        const alvo = [e.codigo, e.descricao, e.modelo, e.numero_serie, e.patrimonio]
          .join(' ').toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    }).sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

    $('#eq-lista').innerHTML = lista.length === 0
      ? '<div class="vazio"><p>Nenhum bem com esses filtros.</p></div>'
      : `<p class="sub">${lista.length} ${lista.length === 1 ? 'bem' : 'bens'}</p>
        <table class="tabela"><thead><tr>
          <th>Código</th><th>Descrição</th><th>Família</th><th>Local</th><th>Controle</th><th></th>
        </tr></thead><tbody>` +
        lista.map(e => `<tr>
          <td class="codigo">${esc(e.codigo)}</td>
          <td>${esc(e.descricao)}${e.ativo === false ? ' <span class="etq inativo">inativo</span>' : ''}</td>
          <td>${esc(q.nome('tipos_equipamento', e.tipo_equipamento_id))}</td>
          <td>${esc(q.nome('locais', e.local_id))}</td>
          <td>${esc(rotuloUnidade(e.unidade_controle))}</td>
          <td><button type="button" class="btn-fantasma" data-ficha="${esc(e.id)}">Abrir</button></td>
        </tr>`).join('') + '</tbody></table>';

    $('#eq-lista').querySelectorAll('[data-ficha]').forEach(b =>
      b.onclick = () => fichaEquipamento(b.dataset.ficha));
  };

  ['eq-busca', 'eq-tipo', 'eq-local', 'eq-status'].forEach(id => {
    const e = document.getElementById(id);
    e.oninput = desenhar; e.onchange = desenhar;
  });
  $('#eq-novo').onclick = () => formEquipamento(null);
  desenhar();
};

function campoListaInline(id, vazio, opcoes) {
  return `<select id="${id}"><option value="">${esc(vazio)}</option>` +
    opcoes.map(o => `<option value="${esc(o.id)}">${esc(o.nome)}</option>`).join('') + '</select>';
}

function rotuloUnidade(u) {
  return ({ HORIMETRO: 'Horímetro (h)', HODOMETRO: 'Hodômetro (km)',
            ACUMULADO: 'Acumulado', CALENDARIO: 'Calendário' })[u] || u || '';
}

function fichaEquipamento(id) {
  const e = q.por_id('equipamentos', id);
  if (!e) return aviso('Bem não encontrado na base local.', true);

  const planos = q.ativos('planos_manutencao').filter(p => p.equipamento_id === id);
  const vinc = q.ativos('pecas_equipamento').filter(v => v.equipamento_id === id);

  const leitura = e.unidade_controle === 'ACUMULADO'
    ? (e.rege_preventiva === 'KM' ? e.km_acumulados : e.horas_acumuladas)
    : e.leitura_atual;

  abrirModal(e.codigo + ' — ' + e.descricao, `
    <div class="painel">
      <div class="cartao"><b>${leitura ?? '—'}</b><span>${esc(rotuloUnidade(e.unidade_controle))}</span></div>
      <div class="cartao"><b>${planos.length}</b><span>itens no plano</span></div>
      <div class="cartao ${vinc.length ? '' : 'alerta'}"><b>${vinc.length}</b><span>peças vinculadas</span></div>
    </div>

    <h2>Identificação</h2>
    <table class="tabela"><tbody>
      ${linha('Família', q.nome('tipos_equipamento', e.tipo_equipamento_id))}
      ${linha('Local', q.nome('locais', e.local_id))}
      ${linha('Setor', q.nome('setores', e.setor_id))}
      ${linha('Marca', q.nome('marcas', e.marca_id))}
      ${linha('Modelo', e.modelo)}
      ${linha('Ano de fabricação', e.ano_fabricacao)}
      ${linha('Nº de série / chassi', e.numero_serie)}
      ${linha('Patrimônio', e.patrimonio)}
      ${linha('Status', e.status)}
      ${linha('Vem no relatório Realtec', e.participa_importacao ? 'Sim' : 'Não')}
      ${e.participa_importacao ? linha('Leitura vem da importação', e.leitura_por_importacao ? 'Sim' : 'Não — lançada na mão') : ''}
    </tbody></table>

    <h2>Plano de manutenção</h2>
    ${planos.length === 0
      ? '<div class="vazio"><p>Sem plano cadastrado.</p></div>'
      : `<table class="tabela"><thead><tr><th>Item</th><th class="num">A cada</th>
         <th class="num">Última troca</th><th class="num">Peças</th></tr></thead><tbody>` +
        planos.map(p => {
          const n = vinc.filter(v => v.tipo_manutencao_id === p.tipo_manutencao_id).length;
          return `<tr><td>${esc(q.nome('tipos_manutencao', p.tipo_manutencao_id))}</td>
            <td class="num">${p.periodicidade_horas ? p.periodicidade_horas + ' h' : ''}
                ${p.periodicidade_dias ? (p.periodicidade_horas ? ' / ' : '') + p.periodicidade_dias + ' d' : ''}</td>
            <td class="num">${p.ultima_troca_data ? formatarData(p.ultima_troca_data) : '—'}
                ${p.ultima_troca_leitura != null ? '<br><small>' + p.ultima_troca_leitura + '</small>' : ''}</td>
            <td class="num">${n === 0 ? '<span class="etq atencao">nenhuma</span>' : n}</td></tr>`;
        }).join('') + '</tbody></table>'}

    <div class="acoes">
      <button type="button" class="btn" id="fi-pecas">Peças desta máquina</button>
      <button type="button" class="btn secundario" id="fi-editar">Editar</button>
      <button type="button" class="btn neutro" id="fi-duplicar">Duplicar</button>
      <button type="button" class="btn neutro" id="fi-imprimir">Imprimir ficha</button>
      ${e.ativo === false
        ? '<button type="button" class="btn neutro" id="fi-reativar">Reativar</button>'
        : '<button type="button" class="btn neutro" id="fi-inativar">Inativar</button>'}
    </div>`, corpo => {
    corpo.querySelector('#fi-editar').onclick = () => formEquipamento(e);
    corpo.querySelector('#fi-duplicar').onclick = () => duplicarEquipamento(e);
    corpo.querySelector('#fi-imprimir').onclick = () => window.print();
    corpo.querySelector('#fi-pecas').onclick = () => {
      fecharModal(); irPara('vinculos');
      setTimeout(() => {
        const s = document.querySelector('#vi-maquina');
        if (s) { s.value = e.id; s.dispatchEvent(new Event('change')); }
      }, 30);
    };
    const bi = corpo.querySelector('#fi-inativar');
    if (bi) bi.onclick = async () => {
      if (!confirm('Inativar ' + e.codigo + '? Ele some das listas novas, mas o histórico continua.')) return;
      await inativar('equipamentos', e.id); fecharModal(); irPara('equipamentos'); aviso('Bem inativado.');
    };
    const br = corpo.querySelector('#fi-reativar');
    if (br) br.onclick = async () => {
      e.ativo = true; await gravar('equipamentos', e); fecharModal(); irPara('equipamentos'); aviso('Bem reativado.');
    };
  });
}

function linha(rot, val) {
  return `<tr><td style="width:42%;color:var(--cinza-claro)">${esc(rot)}</td>
          <td>${esc(val ?? '—')}</td></tr>`;
}

function formatarData(d) {
  if (!d) return '';
  const [a, m, dia] = String(d).slice(0, 10).split('-');
  return `${dia}/${m}/${a}`;
}

function formEquipamento(e) {
  const novo = !e;
  e = e || { unidade_controle: 'HORIMETRO', status: 'ATIVO', ativo: true,
             participa_importacao: true, leitura_por_importacao: true, rege_preventiva: 'HORAS' };
  const statusOps = q.ativos('listas_auxiliares')
    .filter(l => l.lista === 'STATUS_EQUIPAMENTO').map(l => ({ id: l.valor, nome: l.valor }));

  abrirModal(novo ? 'Cadastrar bem' : 'Editar ' + e.codigo, `
    <fieldset><legend>Identificação</legend>
      <div class="colunas">
        ${campoTexto('Código', 'codigo', e.codigo, 'text', 'Padrão da empresa: T.01, C.06, V.04, I.03')}
        ${campoTexto('Descrição', 'descricao', e.descricao)}
        ${campoLista('Família', 'tipo_equipamento_id', q.ordenado('tipos_equipamento'), e.tipo_equipamento_id)}
        ${campoLista('Marca', 'marca_id', q.ordenado('marcas'), e.marca_id)}
        ${campoTexto('Modelo', 'modelo', e.modelo)}
        ${campoTexto('Ano de fabricação', 'ano_fabricacao', e.ano_fabricacao, 'number')}
        ${campoTexto('Nº de série / chassi', 'numero_serie', e.numero_serie)}
        ${campoTexto('Patrimônio', 'patrimonio', e.patrimonio)}
      </div>
    </fieldset>

    <fieldset><legend>Onde fica</legend>
      <div class="colunas">
        ${campoLista('Local', 'local_id', q.ordenado('locais'), e.local_id)}
        ${campoLista('Setor', 'setor_id', q.ordenado('setores'), e.setor_id)}
        ${campoLista('Status', 'status', statusOps, e.status, 'ATIVO')}
        ${campoTexto('Operador ou responsável', 'operador_habitual', e.operador_habitual)}
      </div>
    </fieldset>

    <fieldset><legend>Como é medido</legend>
      <div class="colunas">
        ${campoLista('Unidade de controle', 'unidade_controle', [
          { id: 'HORIMETRO', nome: 'Horímetro — horas de mostrador' },
          { id: 'HODOMETRO', nome: 'Hodômetro — quilômetros' },
          { id: 'ACUMULADO', nome: 'Acumulado — implemento, sem mostrador' },
          { id: 'CALENDARIO', nome: 'Só calendário' }], e.unidade_controle, '')}
        ${campoTexto('Leitura atual', 'leitura_atual', e.leitura_atual, 'number')}
        ${campoTexto('Horas iniciais (implemento)', 'horas_iniciais', e.horas_iniciais,
          'number', 'O que já rodou antes do app existir')}
        ${campoTexto('Km iniciais (implemento)', 'km_iniciais', e.km_iniciais, 'number')}
        ${campoLista('Preventiva do implemento vai por', 'rege_preventiva',
          [{ id: 'HORAS', nome: 'Horas' }, { id: 'KM', nome: 'Quilômetros' }], e.rege_preventiva, '')}
      </div>
      <div class="campo">
        <label><input type="checkbox" name="participa_importacao" style="width:auto;min-height:auto"
          ${e.participa_importacao !== false ? 'checked' : ''}> Vem no relatório Realtec</label>
      </div>
      <div class="campo">
        <label><input type="checkbox" name="leitura_por_importacao" style="width:auto;min-height:auto"
          ${e.leitura_por_importacao !== false ? 'checked' : ''}> A importação pode atualizar a leitura</label>
        <p class="ajuda">Desmarque nos bens de lançamento mensal, em que o campo Fim do relatório
           é a distância do mês e não a leitura do painel.</p>
      </div>
    </fieldset>

    ${campoArea('Observações', 'observacoes', e.observacoes)}
    <div class="acoes">
      <button type="button" class="btn" id="fe-salvar">Salvar</button>
      <button type="button" class="btn neutro" id="fe-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#fe-cancelar').onclick = fecharModal;
    corpo.querySelector('#fe-salvar').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.codigo || !d.descricao) return aviso('Código e descrição são obrigatórios.', true);
      if (!d.tipo_equipamento_id) return aviso('Escolha a família do bem.', true);
      if (!d.local_id) return aviso('Escolha o local.', true);
      const dup = q.todos('equipamentos').find(x => x.codigo === d.codigo && x.id !== e.id);
      if (dup) return aviso('Já existe um bem com o código ' + d.codigo + '.', true);

      const reg = Object.assign({}, e, d, {
        ano_fabricacao: num(d.ano_fabricacao),
        leitura_atual: num(d.leitura_atual),
        horas_iniciais: num(d.horas_iniciais) ?? 0,
        km_iniciais: num(d.km_iniciais) ?? 0,
        ativo: e.ativo !== false
      });
      delete reg.horas_acumuladas; delete reg.km_acumulados;  // colunas geradas pelo banco
      await gravar('equipamentos', reg);
      fecharModal(); irPara('equipamentos');
      aviso(App.online ? 'Bem salvo.' : 'Salvo no aparelho. Sobe quando a internet voltar.');
    };
  });
}

/* Duplicar já herda o plano de manutenção e a lista de peças:
   a frota tem cinco 5090e e três 5085e, cadastrar tudo de novo é perda de tempo. */
function duplicarEquipamento(orig) {
  abrirModal('Duplicar ' + orig.codigo, `
    <p class="sub">O bem novo nasce com os mesmos dados técnicos, o mesmo plano de manutenção
       e a mesma lista de peças de ${esc(orig.codigo)}. Leitura e histórico começam zerados.</p>
    ${campoTexto('Código do bem novo', 'codigo', '')}
    ${campoTexto('Descrição', 'descricao', orig.descricao)}
    <div class="acoes">
      <button type="button" class="btn" id="dp-ok">Duplicar</button>
      <button type="button" class="btn neutro" id="dp-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#dp-cancelar').onclick = fecharModal;
    corpo.querySelector('#dp-ok').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.codigo) return aviso('Informe o código do bem novo.', true);
      if (q.todos('equipamentos').some(x => x.codigo === d.codigo))
        return aviso('Já existe um bem com esse código.', true);

      const novo = Object.assign({}, orig, {
        id: crypto.randomUUID(), codigo: d.codigo, descricao: d.descricao,
        leitura_atual: null, leitura_data: null, numero_serie: null, patrimonio: null,
        horas_importadas: 0, km_importados: 0, ajuste_horas: 0, ajuste_km: 0,
        horas_iniciais: 0, km_iniciais: 0, ultimo_uso_data: null, ativo: true
      });
      delete novo.horas_acumuladas; delete novo.km_acumulados;
      await gravar('equipamentos', novo);

      for (const p of q.ativos('planos_manutencao').filter(x => x.equipamento_id === orig.id)) {
        await gravar('planos_manutencao', Object.assign({}, p, {
          id: crypto.randomUUID(), equipamento_id: novo.id,
          ultima_troca_data: null, ultima_troca_leitura: null, ultima_os_id: null
        }));
      }
      for (const v of q.ativos('pecas_equipamento').filter(x => x.equipamento_id === orig.id)) {
        await gravar('pecas_equipamento', Object.assign({}, v, {
          id: crypto.randomUUID(), equipamento_id: novo.id
        }));
      }
      fecharModal(); irPara('equipamentos');
      aviso(d.codigo + ' criado com o plano e as peças de ' + orig.codigo + '.');
    };
  });
}

/* ---------------------------------------------------------------- PEÇAS */

TELAS.pecas = el => {
  el.innerHTML = `
    <h1>Catálogo de peças</h1>
    <p class="sub">Uma peça é cadastrada uma vez só e serve quantas máquinas precisar.
       Quem diz onde ela é usada é a tela "Peças por máquina".</p>
    <div class="filtros">
      <input type="search" id="pc-busca" placeholder="Buscar por código de estoque, descrição ou part number">
    </div>
    <div class="acoes"><button type="button" class="btn" id="pc-nova">Cadastrar peça</button></div>
    <div id="pc-lista"></div>`;

  const desenhar = () => {
    const b = ($('#pc-busca').value || '').toLowerCase();
    const lista = q.ativos('pecas').filter(p => !b ||
      [p.codigo_estoque, p.descricao, p.part_number, p.especificacao].join(' ').toLowerCase().includes(b))
      .sort((x, y) => String(x.codigo_estoque).localeCompare(String(y.codigo_estoque), 'pt-BR', { numeric: true }));

    $('#pc-lista').innerHTML = lista.length === 0
      ? `<div class="vazio"><p>Nenhuma peça no catálogo ainda.</p>
         <button type="button" class="btn" id="pc-vazio">Cadastrar a primeira</button></div>`
      : `<p class="sub">${lista.length} ${lista.length === 1 ? 'peça' : 'peças'}</p>
        <table class="tabela"><thead><tr>
          <th>Código estoque</th><th>Descrição</th><th>Part number</th>
          <th>Especificação</th><th class="num">Usada em</th><th></th>
        </tr></thead><tbody>` + lista.map(p => {
          const usos = q.ativos('pecas_equipamento').filter(v => v.peca_id === p.id).length;
          return `<tr>
            <td class="codigo">${esc(p.codigo_estoque)}</td>
            <td>${esc(p.descricao)}</td>
            <td>${esc(p.part_number)}</td>
            <td>${esc(p.especificacao)}</td>
            <td class="num">${usos ? usos + (usos === 1 ? ' máquina' : ' máquinas') : '—'}</td>
            <td><button type="button" class="btn-fantasma" data-peca="${esc(p.id)}">Abrir</button></td>
          </tr>`;
        }).join('') + '</tbody></table>';

    const bv = $('#pc-vazio'); if (bv) bv.onclick = () => formPeca(null);
    $('#pc-lista').querySelectorAll('[data-peca]').forEach(b =>
      b.onclick = () => fichaPeca(b.dataset.peca));
  };

  $('#pc-busca').oninput = desenhar;
  $('#pc-nova').onclick = () => formPeca(null);
  desenhar();
};

/* Consulta reversa: "esta peça é usada em quais máquinas?" */
function fichaPeca(id) {
  const p = q.por_id('pecas', id);
  const usos = q.ativos('pecas_equipamento').filter(v => v.peca_id === id);

  abrirModal(p.codigo_estoque + ' — ' + p.descricao, `
    <table class="tabela"><tbody>
      ${linha('Part number', p.part_number)}
      ${linha('Especificação', p.especificacao)}
      ${linha('Unidade', p.unidade)}
      ${linha('Marca', q.nome('marcas', p.marca_id))}
      ${linha('Fornecedor', q.nome('fornecedores', p.fornecedor_id))}
      ${linha('Preço de referência', p.preco_referencia != null
        ? 'R$ ' + Number(p.preco_referencia).toFixed(2).replace('.', ',') : null)}
    </tbody></table>

    <h2>Usada em</h2>
    ${usos.length === 0
      ? '<div class="vazio"><p>Ainda não vinculada a nenhuma máquina.</p></div>'
      : `<table class="tabela"><thead><tr><th>Máquina</th><th>Item de manutenção</th>
         <th class="num">Qtde</th></tr></thead><tbody>` + usos.map(v => {
          const e = q.por_id('equipamentos', v.equipamento_id);
          return `<tr><td><span class="codigo">${esc(e ? e.codigo : '?')}</span> ${esc(e ? e.descricao : '')}</td>
            <td>${esc(q.nome('tipos_manutencao', v.tipo_manutencao_id))}</td>
            <td class="num">${esc(v.quantidade)}</td></tr>`;
        }).join('') + '</tbody></table>'}

    <div class="acoes">
      <button type="button" class="btn secundario" id="fp-editar">Editar</button>
      <button type="button" class="btn neutro" id="fp-inativar">Inativar</button>
    </div>`, corpo => {
    corpo.querySelector('#fp-editar').onclick = () => formPeca(p);
    corpo.querySelector('#fp-inativar').onclick = async () => {
      if (usos.length && !confirm('Esta peça está vinculada a ' + usos.length +
        ' máquina(s). Inativar assim mesmo?')) return;
      await inativar('pecas', p.id); fecharModal(); irPara('pecas'); aviso('Peça inativada.');
    };
  });
}

/* aoSalvar: usado quando a peça é cadastrada de dentro da tela de vínculo,
   para o mecânico não precisar sair do fluxo. */
function formPeca(p, aoSalvar) {
  const novo = !p;
  p = p || { unidade: 'UN', ativo: true };
  abrirModal(novo ? 'Cadastrar peça' : 'Editar peça', `
    <div class="colunas">
      ${campoTexto('Código de estoque', 'codigo_estoque', p.codigo_estoque, 'text', 'O código do almoxarifado')}
      ${campoTexto('Descrição', 'descricao', p.descricao)}
      ${campoTexto('Part number', 'part_number', p.part_number, 'text', 'Do fabricante: John Deere, New Holland, Jacto…')}
      ${campoTexto('Especificação', 'especificacao', p.especificacao, 'text', 'Óleo: 15W40, 80W90, TDH, ATF…')}
      ${campoLista('Unidade', 'unidade', [
        { id: 'UN', nome: 'Unidade' }, { id: 'L', nome: 'Litro' },
        { id: 'KG', nome: 'Quilo' }, { id: 'M', nome: 'Metro' }], p.unidade, '')}
      ${campoLista('Marca', 'marca_id', q.ordenado('marcas'), p.marca_id)}
      ${campoLista('Fornecedor', 'fornecedor_id', q.ordenado('fornecedores'), p.fornecedor_id)}
      ${campoTexto('Preço de referência', 'preco_referencia', p.preco_referencia, 'number')}
    </div>
    <div class="acoes">
      <button type="button" class="btn" id="fp-salvar">Salvar</button>
      <button type="button" class="btn neutro" id="fp-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#fp-cancelar').onclick = fecharModal;
    corpo.querySelector('#fp-salvar').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.codigo_estoque || !d.descricao)
        return aviso('Código de estoque e descrição são obrigatórios.', true);
      const dup = q.todos('pecas').find(x => x.codigo_estoque === d.codigo_estoque && x.id !== p.id);
      if (dup) return aviso('Já existe uma peça com o código ' + d.codigo_estoque + '.', true);

      const reg = Object.assign({}, p, d, { preco_referencia: num(d.preco_referencia), ativo: true });
      await gravar('pecas', reg);
      fecharModal();
      aviso(App.online ? 'Peça salva.' : 'Salva no aparelho. Sobe quando a internet voltar.');
      if (aoSalvar) aoSalvar(reg); else irPara('pecas');
    };
  });
}

/* ---------------------------------------------------------------- VÍNCULO peça × máquina × tipo */

TELAS.vinculos = el => {
  const maquinas = q.ativos('equipamentos')
    .sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

  el.innerHTML = `
    <h1>Peças por máquina</h1>
    <p class="sub">A peça é sempre ligada a um <strong>item de manutenção</strong> de uma máquina.
       É esse vínculo que faz a ordem de serviço sair com o código de estoque e o part number.</p>
    <div class="filtros">
      <select id="vi-maquina" style="flex:1 1 320px">
        <option value="">— escolha a máquina —</option>
        ${maquinas.map(m => `<option value="${esc(m.id)}">${esc(m.codigo)} — ${esc(m.descricao)}</option>`).join('')}
      </select>
    </div>
    <div id="vi-corpo"></div>`;

  $('#vi-maquina').onchange = () => desenharVinculos($('#vi-maquina').value);
  desenharVinculos('');
};

function desenharVinculos(idMaquina) {
  const alvo = $('#vi-corpo');
  if (!idMaquina) {
    alvo.innerHTML = '<div class="vazio"><p>Escolha a máquina acima para ver e cadastrar as peças dela.</p></div>';
    return;
  }
  const e = q.por_id('equipamentos', idMaquina);
  const planos = q.ativos('planos_manutencao').filter(p => p.equipamento_id === idMaquina);
  const vinc = q.ativos('pecas_equipamento').filter(v => v.equipamento_id === idMaquina);

  // Tipos a mostrar: os do plano da máquina, mais qualquer outro que já tenha peça.
  const tipos = q.ordenado('tipos_manutencao', 'nome').filter(t =>
    planos.some(p => p.tipo_manutencao_id === t.id) || vinc.some(v => v.tipo_manutencao_id === t.id));

  alvo.innerHTML = `
    <h2>${esc(e.codigo)} — ${esc(e.descricao)}</h2>
    ${tipos.length === 0
      ? `<div class="vazio"><p>Esta máquina ainda não tem plano de manutenção,
         então não há item ao qual ligar a peça.</p>
         <button type="button" class="btn" data-novo-item="1">Criar item de manutenção</button></div>`
      : tipos.map(t => {
        const ps = vinc.filter(v => v.tipo_manutencao_id === t.id);
        const plano = planos.find(p => p.tipo_manutencao_id === t.id);
        return `
        <h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          ${esc(t.nome)}
          <span class="etq neutro">${plano
            ? (plano.periodicidade_horas ? plano.periodicidade_horas + ' h' : '') +
              (plano.periodicidade_dias ? (plano.periodicidade_horas ? ' / ' : '') + plano.periodicidade_dias + ' dias' : '')
            : 'sem periodicidade'}</span>
        </h2>
        ${ps.length === 0
          ? '<div class="vazio"><p>Nenhuma peça neste item. A OS sairia sem lista de retirada.</p></div>'
          : `<table class="tabela"><thead><tr>
              <th>Código estoque</th><th>Descrição</th><th>Part number</th>
              <th class="num">Qtde</th><th>Especificação</th><th></th>
             </tr></thead><tbody>` + ps.map(v => {
              const p = q.por_id('pecas', v.peca_id) || {};
              return `<tr>
                <td class="codigo">${esc(p.codigo_estoque)}</td>
                <td>${esc(p.descricao)}</td>
                <td>${esc(p.part_number)}</td>
                <td class="num">${esc(v.quantidade)}</td>
                <td>${esc(v.especificacao || p.especificacao)}</td>
                <td><button type="button" class="btn-fantasma" data-tirar="${esc(v.id)}">Tirar</button></td>
              </tr>`;
             }).join('') + '</tbody></table>'}
        <div class="acoes">
          <button type="button" class="btn" data-add="${esc(t.id)}">Adicionar peça em ${esc(t.nome)}</button>
        </div>`;
      }).join('')}`;

  alvo.querySelectorAll('[data-add]').forEach(b =>
    b.onclick = () => formVinculo(idMaquina, b.dataset.add));
  alvo.querySelectorAll('[data-tirar]').forEach(b =>
    b.onclick = async () => {
      if (!confirm('Tirar esta peça do item? O vínculo é inativado, não apagado.')) return;
      await inativar('pecas_equipamento', b.dataset.tirar);
      desenharVinculos(idMaquina); aviso('Peça retirada do item.');
    });
  const bn = alvo.querySelector('[data-novo-item]');
  if (bn) bn.onclick = () => formPlano(idMaquina);
}

function formVinculo(idMaquina, idTipo) {
  const pecas = q.ativos('pecas')
    .sort((a, b) => String(a.codigo_estoque).localeCompare(String(b.codigo_estoque), 'pt-BR', { numeric: true }))
    .map(p => ({ id: p.id, nome: p.codigo_estoque + ' — ' + p.descricao +
                 (p.part_number ? ' (' + p.part_number + ')' : '') }));

  abrirModal('Adicionar peça', `
    <p class="sub">${esc(q.por_id('equipamentos', idMaquina).codigo)} ·
       ${esc(q.nome('tipos_manutencao', idTipo))}</p>
    ${pecas.length === 0
      ? '<div class="vazio"><p>O catálogo está vazio. Cadastre a peça primeiro.</p></div>'
      : campoLista('Peça do catálogo', 'peca_id', pecas, '')}
    <div class="acoes" style="margin-top:-6px">
      <button type="button" class="btn-fantasma" id="fv-nova">Cadastrar uma peça nova agora</button>
    </div>
    <div class="colunas">
      ${campoTexto('Quantidade por troca', 'quantidade', 1, 'number', 'Ex.: 2 filtros de ar')}
      ${campoTexto('Especificação para esta máquina', 'especificacao', '', 'text',
         'Litragem exata ou viscosidade, quando diferir do catálogo')}
    </div>
    ${campoArea('Observação', 'observacao', '')}
    <div class="acoes">
      <button type="button" class="btn" id="fv-salvar">Vincular</button>
      <button type="button" class="btn neutro" id="fv-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#fv-cancelar').onclick = fecharModal;
    // Cadastrar peça sem sair do fluxo: o mecânico descobre que a máquina usa
    // outro filtro, cadastra na hora e vincula.
    corpo.querySelector('#fv-nova').onclick = () =>
      formPeca(null, nova => { formVinculo(idMaquina, idTipo);
        setTimeout(() => { const s = $('#f-peca_id'); if (s) s.value = nova.id; }, 30); });

    corpo.querySelector('#fv-salvar').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.peca_id) return aviso('Escolha a peça.', true);
      const jaTem = q.ativos('pecas_equipamento').find(v =>
        v.equipamento_id === idMaquina && v.tipo_manutencao_id === idTipo && v.peca_id === d.peca_id);
      if (jaTem) return aviso('Esta peça já está neste item.', true);

      await gravar('pecas_equipamento', {
        id: crypto.randomUUID(), equipamento_id: idMaquina, tipo_manutencao_id: idTipo,
        peca_id: d.peca_id, quantidade: num(d.quantidade) ?? 1,
        especificacao: d.especificacao, observacao: d.observacao, ativo: true
      });
      fecharModal(); desenharVinculos(idMaquina);
      aviso(App.online ? 'Peça vinculada.' : 'Vínculo salvo no aparelho. Sobe depois.');
    };
  });
}

function formPlano(idMaquina) {
  abrirModal('Novo item de manutenção', `
    <p class="sub">${esc(q.por_id('equipamentos', idMaquina).codigo)}</p>
    ${campoLista('Item de manutenção', 'tipo_manutencao_id', q.ordenado('tipos_manutencao'), '')}
    <div class="colunas">
      ${campoTexto('A cada quantas horas', 'periodicidade_horas', '', 'number')}
      ${campoTexto('A cada quantos dias', 'periodicidade_dias', '', 'number')}
    </div>
    <p class="ajuda">Vale o que vencer primeiro. Pode preencher só um dos dois.</p>
    <div class="acoes">
      <button type="button" class="btn" id="fpl-salvar">Salvar</button>
      <button type="button" class="btn neutro" id="fpl-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#fpl-cancelar').onclick = fecharModal;
    corpo.querySelector('#fpl-salvar').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.tipo_manutencao_id) return aviso('Escolha o item de manutenção.', true);
      if (!d.periodicidade_horas && !d.periodicidade_dias)
        return aviso('Informe a periodicidade em horas ou em dias.', true);
      await gravar('planos_manutencao', {
        id: crypto.randomUUID(), equipamento_id: idMaquina,
        tipo_manutencao_id: d.tipo_manutencao_id,
        periodicidade_horas: num(d.periodicidade_horas),
        periodicidade_dias: num(d.periodicidade_dias), ativo: true
      });
      fecharModal(); desenharVinculos(idMaquina); aviso('Item criado.');
    };
  });
}

/* ---------------------------------------------------------------- CADASTROS */

const CADASTROS = [
  { tabela: 'tipos_equipamento', titulo: 'Famílias de equipamento',
    campos: [['nome', 'Nome'], ['unidade_padrao', 'Unidade padrão']] },
  { tabela: 'tipos_manutencao', titulo: 'Itens de manutenção',
    campos: [['nome', 'Nome']] },
  { tabela: 'locais', titulo: 'Locais',
    campos: [['codigo', 'Código'], ['nome', 'Nome']] },
  { tabela: 'setores', titulo: 'Setores',
    campos: [['nome', 'Nome'], ['local_id', 'Local', 'locais']] },
  { tabela: 'marcas', titulo: 'Marcas', campos: [['nome', 'Nome']] },
  { tabela: 'fornecedores', titulo: 'Fornecedores',
    campos: [['nome', 'Nome'], ['telefone', 'Telefone'], ['contato', 'Contato']] },
  { tabela: 'mecanicos', titulo: 'Mecânicos',
    campos: [['nome', 'Nome'], ['telefone', 'Telefone'], ['local_id', 'Local', 'locais']] }
];

TELAS.cadastros = el => {
  el.innerHTML = `
    <h1>Cadastros</h1>
    <p class="sub">Tudo aqui é seu, sem programador. O que já foi usado em algum registro
       é inativado, nunca apagado — some das listas novas e o histórico continua certo.</p>
    <ul class="lista">
      ${CADASTROS.map(c => `<li>
        <div class="info"><strong>${esc(c.titulo)}</strong>
          <small>${q.ativos(c.tabela).length} ativos</small></div>
        <button type="button" class="btn-fantasma" data-cad="${esc(c.tabela)}">Abrir</button>
      </li>`).join('')}
      <li><div class="info"><strong>Parâmetros</strong>
        <small>Margem de segurança, prazo do check list, alerta de horímetro</small></div>
        <button type="button" class="btn-fantasma" id="cd-param">Abrir</button></li>
      <li><div class="info"><strong>Importar peças por planilha</strong>
        <small>Carga em lote do catálogo e dos vínculos, por CSV</small></div>
        <button type="button" class="btn-fantasma" id="cd-import">Abrir</button></li>
    </ul>`;

  el.querySelectorAll('[data-cad]').forEach(b =>
    b.onclick = () => telaCadastro(CADASTROS.find(c => c.tabela === b.dataset.cad)));
  $('#cd-param').onclick = telaParametros;
  $('#cd-import').onclick = telaImportarPecas;
};

function telaCadastro(c) {
  const desenhar = () => {
    const itens = q.todos(c.tabela).slice()
      .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
    abrirModal(c.titulo, `
      <div class="acoes"><button type="button" class="btn" id="cd-novo">Incluir</button></div>
      <ul class="lista">${itens.map(i => `<li>
        <div class="info">${esc(i.nome)}
          ${i.ativo === false ? '<span class="etq inativo">inativo</span>' : ''}
          <small>${c.campos.slice(1).map(cp => {
            const v = cp[2] ? q.nome(cp[2], i[cp[0]]) : i[cp[0]];
            return v ? esc(cp[1] + ': ' + v) : '';
          }).filter(Boolean).join(' · ')}</small>
        </div>
        <button type="button" class="btn-fantasma" data-ed="${esc(i.id)}">Editar</button>
      </li>`).join('') || '<div class="vazio"><p>Nada cadastrado ainda.</p></div>'}</ul>`,
      corpo => {
        corpo.querySelector('#cd-novo').onclick = () => formCadastro(c, null, desenhar);
        corpo.querySelectorAll('[data-ed]').forEach(b =>
          b.onclick = () => formCadastro(c, q.por_id(c.tabela, b.dataset.ed), desenhar));
      });
  };
  desenhar();
}

function formCadastro(c, item, aoVoltar) {
  const novo = !item;
  item = item || { ativo: true };
  abrirModal((novo ? 'Incluir em ' : 'Editar ') + c.titulo.toLowerCase(), `
    ${c.campos.map(cp => cp[2]
      ? campoLista(cp[1], cp[0], q.ordenado(cp[2]), item[cp[0]])
      : campoTexto(cp[1], cp[0], item[cp[0]])).join('')}
    <div class="campo"><label>
      <input type="checkbox" name="ativo" style="width:auto;min-height:auto"
        ${item.ativo !== false ? 'checked' : ''}> Ativo</label>
      <p class="ajuda">Desmarcar tira das listas novas sem mexer no histórico.</p></div>
    <div class="acoes">
      <button type="button" class="btn" id="fc-salvar">Salvar</button>
      <button type="button" class="btn neutro" id="fc-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#fc-cancelar').onclick = aoVoltar;
    corpo.querySelector('#fc-salvar').onclick = async () => {
      const d = lerForm(corpo);
      if (!d.nome) return aviso('O nome é obrigatório.', true);
      d.ativo = corpo.querySelector('[name=ativo]').checked;
      await gravar(c.tabela, Object.assign({}, item, d));
      aviso('Salvo.'); aoVoltar();
    };
  });
}

function telaParametros() {
  const ps = q.todos('parametros').slice().sort((a, b) => a.chave.localeCompare(b.chave));
  abrirModal('Parâmetros', ps.map(p => `
    <div class="campo">
      <label for="p-${esc(p.chave)}">${esc(p.descricao)}</label>
      <input id="p-${esc(p.chave)}" name="${esc(p.chave)}" value="${esc(p.valor)}">
      <p class="ajuda">${esc(p.chave)}</p>
    </div>`).join('') + `
    <div class="acoes">
      <button type="button" class="btn" id="pa-salvar">Salvar</button>
      <button type="button" class="btn neutro" id="pa-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#pa-cancelar').onclick = fecharModal;
    corpo.querySelector('#pa-salvar').onclick = async () => {
      const d = lerForm(corpo);
      for (const p of ps) {
        if (d[p.chave] !== null && String(d[p.chave]) !== String(p.valor)) {
          await gravar('parametros', Object.assign({}, p, { valor: String(d[p.chave]) }));
        }
      }
      fecharModal(); aviso('Parâmetros salvos.');
    };
  });
}

/* ---------------------------------------------------------------- importação de peças */

function telaImportarPecas() {
  abrirModal('Importar peças por planilha', `
    <p class="sub">Salve a planilha como CSV separado por ponto e vírgula, com estas colunas
       na primeira linha:</p>
    <p><code>MAQUINA;ITEM;CODIGO_ESTOQUE;DESCRICAO;PART_NUMBER;QUANTIDADE;ESPECIFICACAO;FORNECEDOR</code></p>
    <p class="sub">MAQUINA é o código do bem (T.02). ITEM é o nome do item de manutenção,
       igual ao cadastrado (FILTRO DE AR). A peça que ainda não existir no catálogo é criada;
       a que já existir é reaproveitada, nunca duplicada.</p>
    <div class="campo"><input type="file" id="im-arq" accept=".csv,text/csv"></div>
    <div id="im-previa"></div>
    <div class="acoes">
      <button type="button" class="btn" id="im-gravar" disabled>Conferir antes de gravar</button>
      <button type="button" class="btn neutro" id="im-cancelar">Cancelar</button>
    </div>`, corpo => {
    corpo.querySelector('#im-cancelar').onclick = fecharModal;
    let linhas = [];

    corpo.querySelector('#im-arq').onchange = async ev => {
      const arq = ev.target.files[0]; if (!arq) return;
      const texto = await arq.text();
      linhas = interpretarCSV(texto);
      const problemas = linhas.filter(l => l.erro);
      corpo.querySelector('#im-previa').innerHTML = `
        <h2>Conferência</h2>
        <div class="painel">
          <div class="cartao"><b>${linhas.length - problemas.length}</b><span>linhas prontas</span></div>
          <div class="cartao ${problemas.length ? 'alerta' : ''}"><b>${problemas.length}</b>
            <span>linhas com problema</span></div>
        </div>
        ${problemas.length ? `<table class="tabela"><thead><tr><th>Linha</th><th>Máquina</th>
          <th>Item</th><th>Problema</th></tr></thead><tbody>` +
          problemas.slice(0, 20).map(l => `<tr><td>${l.n}</td><td>${esc(l.MAQUINA)}</td>
            <td>${esc(l.ITEM)}</td><td>${esc(l.erro)}</td></tr>`).join('') + '</tbody></table>' : ''}`;
      corpo.querySelector('#im-gravar').disabled = (linhas.length - problemas.length) === 0;
      corpo.querySelector('#im-gravar').textContent =
        'Gravar ' + (linhas.length - problemas.length) + ' linhas';
    };

    corpo.querySelector('#im-gravar').onclick = async () => {
      let criadas = 0, vinculadas = 0, repetidas = 0;
      for (const l of linhas.filter(x => !x.erro)) {
        let peca = q.todos('pecas').find(p => p.codigo_estoque === l.CODIGO_ESTOQUE);
        if (!peca) {
          peca = { id: crypto.randomUUID(), codigo_estoque: l.CODIGO_ESTOQUE,
                   descricao: l.DESCRICAO, part_number: l.PART_NUMBER || null,
                   especificacao: l.ESPECIFICACAO || null, unidade: 'UN', ativo: true };
          await gravar('pecas', peca); criadas++;
        }
        const ja = q.ativos('pecas_equipamento').find(v =>
          v.equipamento_id === l._eq && v.tipo_manutencao_id === l._tipo && v.peca_id === peca.id);
        if (ja) { repetidas++; continue; }
        await gravar('pecas_equipamento', {
          id: crypto.randomUUID(), equipamento_id: l._eq, tipo_manutencao_id: l._tipo,
          peca_id: peca.id, quantidade: num(l.QUANTIDADE) ?? 1,
          especificacao: l.ESPECIFICACAO || null, ativo: true });
        vinculadas++;
      }
      fecharModal();
      aviso(`${criadas} peças criadas, ${vinculadas} vínculos, ${repetidas} já existiam.`);
      irPara('pecas');
    };
  });
}

function interpretarCSV(texto) {
  const linhas = texto.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!linhas.length) return [];
  const sep = linhas[0].includes(';') ? ';' : ',';
  const cab = linhas[0].split(sep).map(c => c.trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_'));

  return linhas.slice(1).map((linha, i) => {
    const v = linha.split(sep);
    const o = { n: i + 2 };
    cab.forEach((c, j) => o[c] = (v[j] || '').trim());

    const eq = q.todos('equipamentos').find(x => x.codigo === o.MAQUINA);
    const tipo = q.todos('tipos_manutencao').find(x =>
      (x.nome || '').toUpperCase() === (o.ITEM || '').toUpperCase());

    if (!o.MAQUINA) o.erro = 'sem código de máquina';
    else if (!eq) o.erro = 'máquina ' + o.MAQUINA + ' não existe no cadastro';
    else if (!o.ITEM) o.erro = 'sem item de manutenção';
    else if (!tipo) o.erro = 'item "' + o.ITEM + '" não existe no cadastro';
    else if (!o.CODIGO_ESTOQUE) o.erro = 'sem código de estoque';
    else if (!o.DESCRICAO) o.erro = 'sem descrição da peça';
    else { o._eq = eq.id; o._tipo = tipo.id; }
    return o;
  });
}
