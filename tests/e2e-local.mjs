/* Teste de ponta a ponta no Chromium (viewport de celular), modo local (IndexedDB).
   Roda: npm test   -> imprime ok/FAIL e salva capturas de tela em tests/out/ */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { serve, check, section, finish, buildPlanilha, buildExtrato, buildBradesco, buildPlanilhaSet, dumpLocal, txOf, norm, OUT, XLSX } from './helpers.mjs';

const { srv, url } = await serve();
const browser = await chromium.launch();
const NOW = new Date('2026-10-12T15:00:00Z');
const errors = [];

async function newPage(scheme = 'light', ctxOpts = {}, now = NOW) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block', acceptDownloads: true, ...ctxOpts });
  await ctx.clock.setFixedTime(now);
  await ctx.addInitScript(() => { window.APP_CONFIG = { firebase: null }; }); // força o modo local, mesmo com config.js apontando para a nuvem
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|ERR_FAILED/.test(m.text() + (m.location().url || ''))) errors.push('console: ' + m.text()); });
  return { ctx, page };
}
const tab = (page, t) => page.locator(`.tab[data-t="${t}"]`).click();
const stats = async (page) => (await page.locator('#impBody .stat b').allTextContents()).map(Number);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name + '.png') }); }

const { file: planilha, rows: expected } = buildPlanilha();

/* ------------------------------------------------------------------ */
section('1. Abertura e planilha de histórico');
const { ctx, page } = await newPage('light');
await page.goto(url + '/index.html');
await page.waitForFunction(() => /Nenhum lançamento ainda/.test(document.querySelector('#v-resumo').innerText));
check((await page.title()) === 'Controle de Finanças', 'título da página');
check((await page.locator('meta[name=viewport]').count()) === 1, 'meta viewport presente (sem ela o celular mostra a versão desktop encolhida)');
check(await noOverflow(page), 'sem rolagem horizontal na tela vazia');
const fits = () => page.evaluate(() => ({ scroll: document.documentElement.scrollHeight - innerHeight, tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom), innerH: innerHeight }));
for (const tb of ['resumo', 'confirmar', 'gastos', 'importar', 'ajustes']) {
  await tab(page, tb);
  const f = await fits();
  check(f.scroll <= 0 && f.tabsBottom <= f.innerH, `aba ${tb}: a página cabe na tela (sem rolagem da página, barra de abas dentro da tela)`, f);
}
await tab(page, 'resumo');
check(/Nenhum lançamento ainda/.test(await page.locator('#v-resumo').innerText()), 'estado vazio no primeiro acesso');
await shot(page, '01-vazio-claro');

await tab(page, 'importar');
await page.setInputFiles('#file', planilha);
await page.waitForSelector('#hYear');
const monthsOn = await page.locator('[data-hn]:checked').count();
check(monthsOn === 9, 'Janeiro a Setembro marcados por padrão (outubro ainda em andamento)', monthsOn);
check(await page.locator('#hYear').inputValue() === '2026', 'ano da planilha = 2026');
check(JSON.stringify(await page.locator('#hYear option').allTextContents()) === '["2026","2027"]' && await page.locator('#hYear').evaluate((e) => e.tagName) === 'SELECT', 'ano da planilha é uma seleção de 2026 em diante');
await page.locator('#hYear').selectOption('2027');
check(/Importar 59 lançamentos/.test(await page.locator('#iGo').innerText()), 'trocar para 2027 mantém a leitura da planilha (os lançamentos iriam para 2027)');
await page.locator('#hYear').selectOption('2026');
const expCount = expected.length;
check(new RegExp(`Importar ${expCount} lançamentos`).test(await page.locator('#iGo').innerText()), `prévia: ${expCount} lançamentos (linha zerada ignorada)`, await page.locator('#iGo').innerText());
await shot(page, '02-importar-planilha');
await page.locator('#iGo').click();
await page.waitForSelector('#impBody .empty b');
check(/Importação concluída/.test(await page.locator('#impBody').innerText()), 'importação da planilha concluída');

let dump = await dumpLocal(page);
let txs = txOf(dump);
check(txs.length === expCount, `${expCount} lançamentos gravados`, txs.length);
const byYm = {};
for (const t of txs) { const m = (byYm[t.ym] ||= { d: 0, r: 0 }); if (t.tipo === 'R') m.r += t.amt; else m.d += t.amt; }
const wantYm = {};
for (const t of expected) { const m = (wantYm[t.ym] ||= { d: 0, r: 0 }); if (t.tipo === 'R') m.r += t.amt; else m.d += t.amt; }
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
check(sorted(byYm) === sorted(wantYm), 'totais mensais (despesas e receitas) conferem com a planilha', { byYm, wantYm });
check(txs.filter((t) => t.status !== 'ok').length === 1, 'só a linha sem categoria espera confirmação');
check(new Set(txs.map((t) => t.id)).size === txs.length, 'ids únicos');

section('2. Reimportar a mesma planilha não duplica');
await tab(page, 'importar');
await page.setInputFiles('#file', planilha);
await page.waitForSelector('#hYear');
check(/Importar 0 lançamentos/.test(await page.locator('#iGo').innerText()) && await page.locator('#iGo').isDisabled(), 'reimportação gera 0 lançamentos novos');
check(/já importados/.test(await page.locator('#impBody').innerText()), 'mostra quantos já existiam');

section('3. Resumo (mês de setembro) em modo claro e escuro');
await tab(page, 'resumo');
check(/set 2026/i.test(await page.locator('#rMnav .m').innerText()), 'depois de importar, o app mostra o último mês da planilha (set 2026)');
const sepTxt = norm(await page.locator('#v-resumo .big').innerText());
const sepWant = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(wantYm['2026-09'].d);
check(sepTxt === norm(sepWant), `despesas de setembro = ${sepWant}`, sepTxt);
check(await noOverflow(page), 'sem rolagem horizontal no Resumo');
check(/para confirmar/.test(await page.locator('#v-resumo .alert').innerText()), 'alerta de lançamentos para confirmar');
const mfit = await page.locator('#v-resumo .tbl').evaluateAll((els) => els.map((e) => [e.scrollWidth, e.clientWidth]));
check(mfit.length === 1 && mfit.every(([sw, cw]) => sw <= cw), 'a tabela dos últimos 6 meses cabe na tela sem rolar para o lado', mfit);
await shot(page, '03-resumo-claro');
await tab(page, 'gastos');
await shot(page, '04-gastos-claro');
await tab(page, 'ajustes');
check(await noOverflow(page), 'sem rolagem horizontal em Ajustes');
await shot(page, '05-ajustes-claro');

section('3b. Histórico do ano (janeiro a dezembro) e seletor de ano');
const brl = (n) => norm(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n));
const n0 = (n) => Math.round(n).toLocaleString('pt-BR');
const yearD = Object.values(wantYm).reduce((a, m) => a + m.d, 0), yearR = Object.values(wantYm).reduce((a, m) => a + m.r, 0);
await tab(page, 'resumo');
await page.locator('[data-rv="ano"]').click();
const years = await page.locator('#yrSel option').allTextContents();
check(JSON.stringify(years) === '["2026","2027"]', 'seletor de ano: 2026 em diante (mais o ano seguinte)', years);
check((await page.locator('#yrSel').inputValue()) === '2026', 'abre no ano do mês que estava aberto (2026)');
check(norm(await page.locator('#v-resumo .big').innerText()) === brl(yearD), `despesas do ano = ${brl(yearD)}`, norm(await page.locator('#v-resumo .big').innerText()));
const yrows = await page.locator('#v-resumo tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
check(yrows.length === 13 && yrows[0][0] === 'Jan' && yrows[11][0] === 'Dez' && yrows[12][0] === 'Total', 'tabela com os 12 meses, de Jan a Dez, mais o total', yrows.map((r) => r[0]));
check(yrows[0][3] === n0(wantYm['2026-01'].d) && yrows[8][3] === n0(wantYm['2026-09'].d), 'despesas de janeiro e setembro conferem com a planilha', [yrows[0], yrows[8]]);
check(yrows[9].slice(1).every((c) => c === '—') && yrows[10].slice(1).every((c) => c === '—') && yrows[11].slice(1).every((c) => c === '—'), 'outubro, novembro e dezembro (sem lançamentos) aparecem como —');
check(yrows[12][3] === n0(yearD) && yrows[12][4] === n0(yearR), 'linha Total: despesas e receitas do ano', yrows[12]);
check(await page.locator('#v-resumo g[data-gom]').count() === 12, 'gráfico com 12 barras');
check(/Média de .* por mês \(9 meses com lançamentos\)/.test(await page.locator('#v-resumo .delta').first().innerText()), 'média mensal considera só os meses com lançamentos');
check(await noOverflow(page), 'sem rolagem horizontal na visão do ano');
const tblFit = (pg) => pg.locator('#v-resumo .tbl').evaluateAll((els) => els.map((e) => [e.scrollWidth, e.clientWidth]));
const yfit = await tblFit(page);
check(yfit.length === 1 && yfit.every(([sw, cw]) => sw <= cw), 'a tabela do ano mostra as 5 colunas sem rolar para o lado', yfit);
check((await fits()).scroll <= 0, 'a página cabe na tela na visão do ano');
await shot(page, '17-ano-claro');
await page.locator('#v-resumo table').scrollIntoViewIfNeeded();
await shot(page, '17b-ano-tabela');
await page.locator('#yrSel').selectOption('2027');
check(/Sem lançamentos em 2027/.test(await page.locator('#v-resumo').innerText()) && norm(await page.locator('#v-resumo .big').innerText()) === brl(0), 'ano sem lançamentos (2027) mostra aviso e zero');
await page.locator('#yrSel').selectOption('2026');
await page.locator('#v-resumo tr[data-gom="2026-03"]').click();
check(/mar 2026/i.test(await page.locator('#rMnav .m').innerText()) && await page.locator('[data-rv="mes"].on').count() === 1, 'tocar em Março abre o mês de março na visão Mês');
await page.locator('[data-rv="ano"]').click();
await page.locator('#v-resumo tr[data-gom="2026-01"]').click();
check(await page.locator('#rMnav [data-mv="-1"]').isDisabled(), 'em janeiro de 2026 não dá para voltar para antes de 2026');
await page.locator('[data-rv="ano"]').click();
await page.locator('#v-resumo tr[data-gom="2026-09"]').click();
check(/set 2026/i.test(await page.locator('#rMnav .m').innerText()), 'volta para setembro');

const dark = await newPage('dark');
await dark.page.goto(url + '/index.html');
await dark.page.waitForFunction(() => /Nenhum lançamento ainda/.test(document.querySelector('#v-resumo').innerText));
// copia os dados para o contexto escuro via backup/restauração (testa o fluxo real de backup)
await tab(page, 'ajustes');
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#expJ').click()]);
const backupFile = path.join(OUT, 'backup-teste.json');
await dl.saveAs(backupFile);
const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
check(backup.app === 'controle-financas' && backup.tx.length === expCount, 'backup JSON traz todos os lançamentos', backup.tx.length);
check(/controle-financas-backup-2026-10-12\.json/.test(dl.suggestedFilename()), 'nome do arquivo de backup', dl.suggestedFilename());

section('4. Restaurar backup em um navegador vazio');
await tab(dark.page, 'ajustes');
await dark.page.setInputFiles('#rFile', backupFile);
await dark.page.waitForSelector('#rGo');
check(new RegExp(`${expCount} lançamentos no arquivo \\(${expCount} novos`).test(await dark.page.locator('#sheet').innerText()), 'prévia da restauração');
await dark.page.locator('#rGo').click();
await dark.page.waitForFunction(() => /restaurados/.test(document.querySelector('#toast').textContent));
txs = txOf(await dumpLocal(dark.page));
check(txs.length === expCount, 'backup restaurado com todos os lançamentos', txs.length);
await tab(dark.page, 'resumo');
await dark.page.locator('#rMnav [data-mv="-1"]').click();
check(norm(await dark.page.locator('#v-resumo .big').innerText()) === norm(sepWant), 'Resumo idêntico depois de restaurar');
await shot(dark.page, '06-resumo-escuro');
await dark.page.locator('[data-rv="ano"]').click();
await dark.page.waitForSelector('#yrSel');
check(norm(await dark.page.locator('#v-resumo .big').innerText()) === brl(yearD), 'visão do ano idêntica depois de restaurar o backup');
check(await noOverflow(dark.page), 'sem rolagem horizontal na visão do ano (modo escuro)');
await shot(dark.page, '18-ano-escuro');
await dark.page.locator('#v-resumo table').scrollIntoViewIfNeeded();
await shot(dark.page, '18b-ano-tabela-escuro');
await dark.page.locator('[data-rv="mes"]').click();
await tab(dark.page, 'confirmar');
await shot(dark.page, '07-confirmar-escuro');
check(await noOverflow(dark.page), 'sem rolagem horizontal no modo escuro');
// restaurar de novo não duplica
await tab(dark.page, 'ajustes');
await dark.page.setInputFiles('#rFile', backupFile);
await dark.page.waitForSelector('#rGo');
check(/0 novos/.test(await dark.page.locator('#sheet').innerText()), 'restaurar de novo mostra 0 novos');
await dark.page.locator('#rNo').click();
await dark.page.setInputFiles('#rFile', path.join(OUT, 'planilha-teste.xlsx'));
await dark.page.waitForFunction(() => /não é um backup/.test(document.querySelector('#toast').textContent));
check(/não é um backup válido/.test(await dark.page.locator('#toast').innerText()), 'arquivo que não é backup é recusado com aviso');
await dark.ctx.close();

section('5. Extrato do cartão: classificação automática');
const ext1 = buildExtrato('extrato-out.xlsx', [
  ['02/10/2026', 'MERCADO EXTRA SALVADOR', 512.4, 'NICOLAS SANTOS'],          // aprendido, compartilhado
  ['03/10/2026', 'PAG*UBER TRIP 456', 41.9, 'ANA PAULA'],                       // aprendido, titular = Ana Paula
  ['04/10/2026', 'RACAO FAZENDA MIRANTE', 905.0, 'EDUARDO SILVEIRA'],           // aprendido, fazenda
  ['05/10/2026', 'NOVO FORNECEDOR XYZ', 330.0, 'EDUARDO SILVEIRA'],             // nunca visto
  ['06/10/2026', 'PADARIA DO ZE', 25.0, 'NICOLAS SANTOS'],                      // histórico dividido
  ['07/10/2026', 'PAGAMENTO FATURA', 3000.0, 'NICOLAS SANTOS'],                 // ignorado
  ['08/10/2026', 'LOUCOS POR SALGADOS PARC 02/03', 35.0, 'NICOLAS SANTOS'],     // lixo antigo só na fazenda
  ['09/10/2026', 'CAFE CENTRAL', 12.0, 'NICOLAS SANTOS'],                       // duas compras idênticas no mesmo dia
  ['09/10/2026', 'CAFE CENTRAL', 12.0, 'NICOLAS SANTOS'],
]);
await tab(page, 'importar');
await page.setInputFiles('#file', ext1);
await page.waitForSelector('[data-c="date"]');
const cols = await page.evaluate(() => ['date', 'desc', 'amt', 'holder'].map((k) => document.querySelector(`[data-c="${k}"] option:checked`).textContent));
check(JSON.stringify(cols) === JSON.stringify(['Data', 'Descrição', 'Valor', 'Titular']), 'colunas reconhecidas, mesmo com linhas de título acima do cabeçalho', cols);
check((await page.locator('#iFat').inputValue()) === '2026-10', 'mês da fatura = outubro');
const st1 = await stats(page);
check(JSON.stringify(st1) === JSON.stringify([4, 1, 3]), 'prévia: 4 classificados, 1 a confirmar, 3 novos', st1);
check(/1 pagamentos de fatura ignorados/.test(await page.locator('#impBody').innerText()), 'pagamento de fatura ignorado');
await shot(page, '08-importar-extrato');
await page.locator('#iGo').click();
await page.waitForSelector('#impBody .empty b');

dump = await dumpLocal(page);
const oct = txOf(dump).filter((t) => t.src === 'extrato');
const by = (d) => oct.filter((t) => t.desc.startsWith(d));
const one = (d) => by(d)[0];
check(oct.length === 8, '8 lançamentos do extrato gravados', oct.length);
check(one('MERCADO').status === 'ok' && one('MERCADO').seg === 'Nicolas & Ana Paula' && one('MERCADO').cat === 'Mercado', 'mercado: classificado como compartilhado (consenso do histórico)', one('MERCADO'));
check(one('PAG*UBER').status === 'ok' && one('PAG*UBER').seg === 'Ana Paula' && one('PAG*UBER').cat === 'Transporte por app', 'uber no cartão da Ana Paula entra como Ana Paula', one('PAG*UBER'));
check(one('RACAO').status === 'ok' && one('RACAO').seg === 'Granja' && one('RACAO').cat === 'Ração Granja', 'ração no cartão da fazenda: Granja', one('RACAO'));
check(one('NOVO').status === 'new' && !one('NOVO').seg, 'fornecedor nunca visto: amarelo, sem sugestão', one('NOVO'));
check(one('PADARIA').status === 'maybe', 'padaria com histórico dividido: laranja (confirmar)', one('PADARIA'));
check(one('LOUCOS').status === 'ok' && one('LOUCOS').cat === 'Lanches / Junk food' && one('LOUCOS').seg === 'Nicolas', 'LOUCOS POR SALGADOS: o lixo de janeiro (Combustível) não contamina o cartão da casa', one('LOUCOS'));
check(by('CAFE').length === 2 && by('CAFE').every((t) => t.status === 'new'), 'duas compras idênticas no mesmo dia entram as duas');
check(oct.every((t) => t.ym === '2026-10' && t.met === 'Cartão Credito'), 'competência = mês da fatura');
check(Math.abs(oct.reduce((a, t) => a + t.amt, 0) - (512.4 + 41.9 + 905 + 330 + 25 + 35 + 12 + 12)) < 0.001, 'soma do extrato confere');
check(one('MERCADO').card === 'Nicolas' && one('PAG*UBER').card === 'Ana Paula' && one('RACAO').card === 'Eduardo' && one('NOVO').card === 'Eduardo', 'cada lançamento do extrato guarda o cartão (titular do arquivo; EDUARDO SILVEIRA = Eduardo)', oct.map((t) => [t.desc, t.card]));
check(oct.every((t) => ['Nicolas', 'Ana Paula', 'Eduardo'].includes(t.card)), 'nenhum lançamento do extrato ficou sem cartão');
check(txOf(dump).filter((t) => t.src === 'planilha').every((t) => t.card === ''), 'lançamentos da planilha ficam sem cartão (a planilha não informa)');

section('6. Reimportar o mesmo extrato');
await tab(page, 'importar');
await page.setInputFiles('#file', ext1);
await page.waitForSelector('[data-c="date"]');
check(/Importar 0 lançamentos/.test(await page.locator('#iGo').innerText()), 'reimportar o extrato gera 0 lançamentos novos');

section('7. Confirmar e aprender');
await tab(page, 'confirmar');
const sts = (await page.locator('#v-confirmar .stat b').allTextContents()).map(Number);
check(JSON.stringify(sts) === JSON.stringify([4, 1, 4]), 'fila: 4 novos, 1 a confirmar, 4 lugares', sts);
check(await noOverflow(page), 'sem rolagem horizontal em Confirmar');
await shot(page, '09-confirmar-claro');
const card = (n) => page.locator('.qcard', { hasText: n });
check(/Cartão Eduardo/.test(await card('NOVO FORNECEDOR XYZ').locator('.sub').innerText()), 'Confirmar mostra o cartão do lançamento (Eduardo)');
check(/Cartão Nicolas/.test(await card('CAFE CENTRAL').locator('.sub').innerText()), 'Confirmar mostra o cartão do lançamento (Nicolas)');
check(/cartão da casa/.test(await card('LOJA SEM CATEGORIA').locator('.sub').innerText()), 'sem cartão informado (planilha), mantém o texto "cartão da casa"');
await card('NOVO FORNECEDOR XYZ').locator('[data-seg="Leite"]').click();
await card('NOVO FORNECEDOR XYZ').locator('select[data-cat]').selectOption('Utensilios Fazenda Geral');
await card('NOVO FORNECEDOR XYZ').locator('[data-ok]').click();
await page.waitForFunction(() => !document.querySelector('.qcard[data-k$="NOVO FORNECEDOR XYZ"]'));
await card('PADARIA DO ZE').locator('select[data-cat]').selectOption('Padaria');
await card('PADARIA DO ZE').locator('[data-ok]').click();
await page.waitForFunction(() => !document.querySelector('.qcard[data-k$="PADARIA DO ZE"]'));
await card('CAFE CENTRAL').locator('[data-seg="Nicolas"]').click();
await card('CAFE CENTRAL').locator('select[data-cat]').selectOption('Lanches / Junk food');
await card('CAFE CENTRAL').locator('[data-ok]').click();
await page.waitForFunction(() => !document.querySelector('.qcard[data-k$="CAFE CENTRAL"]'));
check(await page.locator('.qcard').count() === 1, 'sobrou só a LOJA SEM CATEGORIA da planilha');

// segundo extrato (valores negativos como texto, formato brasileiro): o fornecedor já tem 1 confirmação -> laranja com sugestão
const ext2 = buildExtrato('extrato-nov.xlsx', [
  ['03/11/2026', 'NOVO FORNECEDOR XYZ', 410.5, 'EDUARDO SILVEIRA'],
  ['04/11/2026', 'CAFE CENTRAL', 14.0, 'NICOLAS SANTOS'],
], { negative: true });
await tab(page, 'importar');
await page.setInputFiles('#file', ext2);
await page.waitForSelector('[data-c="date"]');
check(await page.locator('#iFlip').isChecked(), 'sinal negativo detectado e invertido automaticamente');
const st2 = await stats(page);
check(JSON.stringify(st2) === JSON.stringify([1, 1, 0]), 'CAFE CENTRAL (2 confirmações) entra sozinho; NOVO FORNECEDOR (1 confirmação) ainda pede confirmação', st2);
await page.locator('#iGo').click();
await page.waitForSelector('#impBody .empty b');
await tab(page, 'confirmar');
const sug = await card('NOVO FORNECEDOR XYZ').locator('select[data-cat]').inputValue();
check(sug === 'Utensilios Fazenda Geral', 'sugestão pré-preenchida com o que você ensinou', sug);
check(await card('NOVO FORNECEDOR XYZ').locator('[data-seg="Leite"].on').count() === 1, 'responsável sugerido pré-selecionado (Leite)');
await card('NOVO FORNECEDOR XYZ').locator('[data-ok]').click();
await page.waitForFunction(() => !document.querySelector('.qcard[data-k$="NOVO FORNECEDOR XYZ"]'));

// terceiro extrato: 2 confirmações iguais -> classifica sozinho
const ext3 = buildExtrato('extrato-dez.xlsx', [['05/12/2026', 'NOVO FORNECEDOR XYZ', 99.9, 'EDUARDO SILVEIRA']]);
await tab(page, 'importar');
await page.setInputFiles('#file', ext3);
await page.waitForSelector('[data-c="date"]');
const st3 = await stats(page);
check(JSON.stringify(st3) === JSON.stringify([1, 0, 0]), 'depois de 2 confirmações iguais, classifica sozinho', st3);
await page.locator('#iGo').click();
await page.waitForSelector('#impBody .empty b');
const dec = txOf(await dumpLocal(page)).find((t) => t.ym === '2026-12');
check(dec.status === 'ok' && dec.auto === true && dec.seg === 'Leite' && dec.cat === 'Utensilios Fazenda Geral', 'lançamento de dezembro entrou como automático (Leite / Utensilios Fazenda Geral)', dec);

section('8. Gastos: filtro, edição em lote e lançamento manual');
await tab(page, 'gastos');
// o mês mostrado é o do último import (dezembro); navega até outubro
for (let i = 0; i < 2; i++) await page.locator('#gMnav [data-mv="-1"]').click();
check(/out 2026/i.test(await page.locator('#gMnav .m').innerText()), 'Gastos em outubro');
const ctags = await page.locator('#gList .ctag').allTextContents();
check(ctags.length === 8 && ctags.filter((x) => x === 'Cartão Eduardo').length === 2 && ctags.filter((x) => x === 'Cartão Nicolas').length === 5 && ctags.filter((x) => x === 'Cartão Ana Paula').length === 1, 'cada gasto de outubro mostra o cartão (5 Nicolas, 1 Ana Paula, 2 Eduardo)', ctags);
await shot(page, '15-gastos-cartao');
await page.fill('#q', 'eduardo');
check(await page.locator('#gList .tx').count() === 2, 'buscar "eduardo" mostra só os gastos do cartão do Eduardo');
await page.fill('#q', '');
await page.fill('#q', 'mercado');
const filtered = await page.locator('#gList .tx').count();
check(filtered === 1, 'busca por "mercado" mostra 1 lançamento em outubro', filtered);
await page.fill('#q', '');
const cafeRow = page.locator('#gList .tx', { hasText: 'CAFE CENTRAL' }).first();
const cafeId = await cafeRow.getAttribute('data-id');
await cafeRow.click();
check(await page.locator('#sheet #eAll').count() === 1, 'folha de edição oferece "aplicar aos outros deste lugar"');
check(await page.locator('#cChips [data-card="Nicolas"].on').count() === 1, 'folha de edição mostra o cartão atual (Nicolas)');
await shot(page, '10-editar-claro');
await page.locator('#cChips [data-card="Ana Paula"]').click();
await page.locator('#eAll').click();
check(await page.locator('#eAll').isChecked(), 'marcou "aplicar aos outros deste lugar"');
await page.locator('#eSave').click();
await page.waitForFunction(() => !document.querySelector('#sheetbg').classList.contains('on'));
const cafes = txOf(await dumpLocal(page)).filter((x) => x.key === 'CAFE CENTRAL');
check(cafes.length === 3 && cafes.find((x) => x.id === cafeId).card === 'Ana Paula' && cafes.filter((x) => x.id !== cafeId).every((x) => x.card === 'Nicolas'), 'trocar o cartão vale só para o lançamento aberto, mesmo aplicando a categoria aos outros do lugar', cafes.map((x) => [x.id, x.card]));

await page.locator('#addBtn').click();
await page.fill('#mV', '150.50');
await page.fill('#mN', 'Pix diarista');
await page.locator('#sheet [data-seg="Nicolas & Ana Paula"]').click();
await page.locator('#mC').selectOption('Diarista / Empregada');
await page.locator('#mSave').click();
await page.waitForFunction(() => /Lançamento salvo/.test(document.querySelector('#toast').textContent));
const manual = txOf(await dumpLocal(page)).find((t) => t.src === 'manual');
check(manual && manual.amt === 150.5 && manual.ym === '2026-10' && manual.status === 'ok' && manual.cat === 'Diarista / Empregada', 'lançamento manual gravado', manual);
check(manual.card === '' && manual.met === 'Debito/Pix', 'Pix/débito não pede cartão');

await page.locator('#addBtn').click();
await page.fill('#mV', '60'); await page.fill('#mN', 'Lanche no cartão');
check(await page.locator('#sheet [data-k="cN"]').count() === 0, 'sem escolher "Cartão", não aparecem os cartões');
await page.locator('#sheet [data-k="mC"]').click();
check(await page.locator('#sheet [data-k="cN"], #sheet [data-k="cA"], #sheet [data-k="cE"]').count() === 3, 'escolher "Cartão" mostra Nicolas, Ana Paula e Eduardo');
await shot(page, '16-manual-cartao');
await page.locator('#sheet [data-seg="Ana Paula"]').click();
await page.locator('#mC').selectOption('Lanches / Junk food');
await page.locator('#mSave').click();
check(/Escolha o cartão/.test(await page.locator('#toast').innerText()), 'com método Cartão, escolher o cartão é obrigatório');
await page.locator('#sheet [data-k="cA"]').click();
await page.locator('#mSave').click();
await page.waitForFunction(() => !document.querySelector('#sheetbg').classList.contains('on'));
const manualCard = txOf(await dumpLocal(page)).find((x) => x.desc === 'Lanche no cartão');
check(manualCard && manualCard.card === 'Ana Paula' && manualCard.met === 'Cartão Credito' && manualCard.amt === 60, 'lançamento manual no cartão grava o cartão escolhido', manualCard);

section('9. Ajustes: titulares e categorias');
await tab(page, 'ajustes');
await page.fill('#ncN', 'Categoria de teste');
await page.locator('#ncA').click();
check(await page.locator('.chip', { hasText: 'Categoria de teste' }).count() === 1, 'nova categoria aparece');
check(/Dados só neste navegador/.test(await page.locator('#v-ajustes').innerText()), 'aviso claro de que no modo local os dados ficam só no navegador');

section('9b. Selo flutuante do hospedeiro (Netlify) não cobre as abas');
{
  const tabsHit = (pg) => pg.evaluate(() => [...document.querySelectorAll('.tab')].map((el) => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && !!hit.closest('.tab') && hit.closest('.tab') === el; }));
  check((await tabsHit(page)).every(Boolean), 'sem selo: as 5 abas recebem o toque');
  await page.evaluate(() => { const f = document.createElement('iframe'); f.id = 'nl-badge-frame'; f.style.cssText = 'position:fixed;right:0;bottom:0;width:201px;height:64px;border:0;z-index:2147483647;background:#123'; document.body.appendChild(f); });
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--badge-h') === '64px');
  const hits = await tabsHit(page);
  check(hits.length === 5 && hits.every(Boolean), 'com o selo de 201x64 no canto, as 5 abas continuam recebendo o toque', hits);
  const geo = await page.evaluate(() => ({ tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom), badgeTop: Math.round(document.getElementById('nl-badge-frame').getBoundingClientRect().top) }));
  check(geo.tabsBottom <= geo.badgeTop, 'a barra de abas inteira termina acima do selo', geo);
  await shot(page, '14-com-selo-hospedeiro');
  await page.evaluate(() => document.getElementById('nl-badge-frame').remove());
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--badge-h') === '0px');
  check((await tabsHit(page)).every(Boolean), 'sem o selo, o espaço extra some');
}

section('9c. Extrato de um mês que a planilha já trouxe: preenche o cartão sem duplicar');
const nBefore = txOf(await dumpLocal(page)).length;
const extSet = buildExtrato('extrato-set.xlsx', [
  ['05/09/2026', 'MERCADO EXTRA SALVADOR', 490, 'NICOLAS SANTOS'],
  ['08/09/2026', 'PAG*UBER TRIP 123', 39, 'ANA PAULA'],
  ['10/09/2026', 'POSTO IPIRANGA SALVADOR', 250, 'EDUARDO SILVEIRA'],
]);
await tab(page, 'importar');
await page.setInputFiles('#file', extSet);
await page.waitForSelector('[data-c="date"]');
const goTxt = await page.locator('#iGo').innerText();
check(/Atualizar 3 lançamentos já importados/.test(goTxt) && await page.locator('#iGo').isEnabled(), 'nada novo a importar, mas 3 lançamentos antigos ganham o cartão', goTxt);
check(/3 ganham dados novos/.test(await page.locator('#impBody').innerText()), 'a prévia explica o que vai acontecer');
await page.locator('#iGo').click();
await page.waitForSelector('#impBody .empty b');
check(/0 lançamentos importados e 3 atualizados/.test(await page.locator('#impBody').innerText()), 'resultado: 0 importados, 3 atualizados', await page.locator('#impBody').innerText());
const afterAll = txOf(await dumpLocal(page));
check(afterAll.length === nBefore, 'nenhum lançamento duplicado', [nBefore, afterAll.length]);
const sep = afterAll.filter((x) => x.ym === '2026-09' && x.src === 'planilha');
const sp = (d) => sep.find((x) => x.desc.startsWith(d));
check(sp('MERCADO').card === 'Nicolas' && sp('PAG*UBER').card === 'Ana Paula' && sp('POSTO').card === 'Eduardo', 'os 3 ganharam o cartão do extrato (Nicolas, Ana Paula, Eduardo)', sep.map((x) => [x.desc, x.card]));
check(sp('MERCADO').seg === 'Nicolas & Ana Paula' && sp('PAG*UBER').seg === 'Nicolas' && sp('POSTO').seg === 'Combustivel' && sp('MERCADO').cat === 'Mercado' && sp('MERCADO').status === 'ok', 'a classificação da planilha foi preservada (só o cartão mudou)');
check(sep.filter((x) => !x.card).length === sep.length - 3, 'os demais de setembro continuam sem cartão (não se adivinha)');
await tab(page, 'importar');
await page.setInputFiles('#file', extSet);
await page.waitForSelector('[data-c="date"]');
check(/Importar 0 lançamentos/.test(await page.locator('#iGo').innerText()) && await page.locator('#iGo').isDisabled(), 'reimportar de novo não faz mais nada');

await tab(page, 'ajustes');
const [xdl] = await Promise.all([page.waitForEvent('download'), page.locator('#exp').click()]);
const xpath = path.join(OUT, 'export-teste.xlsx');
await xdl.saveAs(xpath);
const xrows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(xpath), { type: 'buffer' }).Sheets['Lançamentos'], { header: 1 });
check(xrows[0][xrows[0].length - 1] === 'Cartão', 'Excel exportado tem a coluna Cartão');
check(xrows.some((r) => r[1] === 'MERCADO EXTRA SALVADOR' && r[r.length - 1] === 'Nicolas') && xrows.some((r) => r[1] === 'RACAO FAZENDA MIRANTE' && r[r.length - 1] === 'Eduardo'), 'e traz o cartão de cada lançamento');

section('9d. Fatura do Bradesco (.xls): seções por cartão, datas sem ano, R$, parcelas e pagamento');
const BR_SEC = [
  { name: 'NICOLAS DE TESTE SANTO', digits: '10001', rows: [
    ['20/09', 'MERCADO TESTE', 100], ['19/09', 'PADARIA TESTE', 20.5], ['15/09', 'UBER *TRIP 1', 30],
    ['01/09', 'SALDO ANTERIOR', 5000], ['01/09', 'PAGTO. POR DEB EM C/C', -5000],
    ['23/09', 'MAQUINA TESTE 12/12', 200], ['24/11', 'LIVRARIA TESTE 10/12', 50], ['09/02', 'CELULAR TESTE 8/12', 150],
    ['10/09', 'HOTEL EXTERIOR', 110, 20]] },
  { name: 'ANA PAULA TESTE S', digits: '10002', rows: [['18/09', 'FARMACIA TESTE', 45.9], ['12/09', 'MERCADO TESTE', 80.1]] },
  { name: 'EDUARDO X SILVEIRA', digits: '10003', rows: [['17/09', 'RACAO TESTE', 900], ['16/09', 'LOJA AGRO TESTE 1/10', 188.93], ['02/09', 'MERCADOLIVRE*TESTE', -60]] },
];
const bra = buildBradesco('bradesco-teste.xls', BR_SEC);
const brm = (n) => norm(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n));
const bctx = await newPage('light');
const bp = bctx.page;
await bp.goto(url + '/index.html');
await bp.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
await tab(bp, 'importar');
await bp.setInputFiles('#file', bra.file);
await bp.waitForSelector('[data-c="date"]');
const bcols = await bp.evaluate(() => ['date', 'desc', 'amt', 'holder'].map((k) => { const s = document.querySelector(`[data-c="${k}"]`); return s.options[s.selectedIndex].textContent; }));
check(JSON.stringify(bcols) === JSON.stringify(['Data', 'Histórico', 'Valor(R$)', 'Titular (seção do arquivo)']), 'colunas: usa Valor(R$) (não a de US$) e o titular vem da seção de cada cartão', bcols);
check((await bp.locator('#iFat').inputValue()) === '2026-09', 'mês da fatura = setembro (as parcelas antigas de novembro/setembro de 2025 não puxam para outro mês)');
const bh = await bp.locator('[data-h]').evaluateAll((els) => els.map((e) => e.value));
check(JSON.stringify(bh) === JSON.stringify(['Nicolas', 'Ana Paula', 'Fazenda']), 'os 3 cartões já vêm associados (Nicolas, Ana Paula, Fazenda)', bh);
const btxt = norm(await bp.locator('#impBody').innerText());
check(/ano mais recente até 20\/09\/2026/.test(btxt), 'explica como tratou as datas sem ano');
check(/2 pagamentos de fatura ignorados/.test(btxt), 'ignora o saldo anterior e o pagamento da fatura anterior');
check(new RegExp(`soma lida \\(${brm(bra.expect.total).replace(/[$]/g, '\\$')}\\) confere com o total da fatura`).test(btxt), `soma lida confere com o total da fatura (${brm(bra.expect.total)})`, btxt.match(/soma lida[^.]*\./g));
check(new RegExp(`Importar ${bra.expect.n} lançamentos`).test(await bp.locator('#iGo').innerText()), `${bra.expect.n} lançamentos na prévia`);
const bfit = await bp.locator('#impBody .tbl').evaluateAll((els) => els.map((e) => [e.scrollWidth, e.clientWidth]));
check(bfit.length === 1 && bfit.every(([sw, cw]) => sw <= cw), 'a tabela da prévia mostra a coluna Responsável sem rolar para o lado', bfit);
await shot(bp, '19-importar-bradesco');
await bp.locator('#iGo').click();
await bp.waitForSelector('#impBody .empty b');
const btx = txOf(await dumpLocal(bp));
const byCard = {};
btx.forEach((x) => { (byCard[x.card] ||= { n: 0, s: 0 }); byCard[x.card].n++; byCard[x.card].s += x.amt; });
const cardOfSec = { 'NICOLAS DE TESTE SANTO': 'Nicolas', 'ANA PAULA TESTE S': 'Ana Paula', 'EDUARDO X SILVEIRA': 'Eduardo' };
const okByCard = Object.entries(bra.expect.sections).every(([nm, e]) => byCard[cardOfSec[nm]] && byCard[cardOfSec[nm]].n === e.n && Math.abs(byCard[cardOfSec[nm]].s - e.sum) < 0.005);
check(okByCard, 'cada cartão tem a quantidade e a soma do "Total para…" do arquivo', { byCard, expect: bra.expect.sections });
const bd = (d) => btx.find((x) => x.desc.startsWith(d));
check(bd('MAQUINA').d === '2025-09-23' && bd('LIVRARIA').d === '2025-11-24' && bd('CELULAR').d === '2026-02-09', 'parcelas antigas ficam no ano anterior (23/09 e 24/11 → 2025; 09/02 → 2026)', [bd('MAQUINA').d, bd('LIVRARIA').d, bd('CELULAR').d]);
check(bd('MERCADO TESTE').d === '2026-09-20' || btx.some((x) => x.desc === 'MERCADO TESTE' && x.d === '2026-09-20'), 'compras do ciclo ficam em 2026');
check(btx.every((x) => x.ym === '2026-09' && x.met === 'Cartão Credito'), 'todos entram no mês da fatura (setembro)');
check(bd('HOTEL').amt === 110, 'compra no exterior usa o valor em reais, não o em US$');
const credit = btx.find((x) => x.desc.startsWith('MERCADOLIVRE'));
check(credit && credit.amt === -60 && credit.card === 'Eduardo', 'estorno de loja fica como crédito (-R$ 60,00) no cartão certo', credit);
check(!btx.some((x) => /SALDO ANTERIOR|PAGTO/.test(x.desc)), 'saldo anterior e pagamento não viram gasto');
check(btx.every((x) => x.card), 'todo lançamento tem cartão');
await tab(bp, 'importar');
await bp.setInputFiles('#file', bra.file);
await bp.waitForSelector('[data-c="date"]');
check(/Importar 0 lançamentos/.test(await bp.locator('#iGo').innerText()) && await bp.locator('#iGo').isDisabled(), 'reimportar a mesma fatura não duplica');
// total do arquivo diferente da soma lida: avisa
const brBad = buildBradesco('bradesco-total-errado.xls', BR_SEC, { totalOverride: bra.expect.total + 10 });
await bp.setInputFiles('#file', brBad.file);
await bp.waitForSelector('[data-c="date"]');
check(/difere do total da fatura/.test(await bp.locator('#impBody .warn').innerText()), 'se a soma lida não bate com o total do arquivo, avisa');
await bctx.ctx.close();

section('9e. Ordem de importação: planilha e extrato se completam (nas duas ordens)');
const setRows = [
  ['20/09', 'MERCADO TESTE', 100, 'Nicolas & Ana Paula', 'Mercado', 'Cartão Credito', 'Despesa'],
  ['19/09', 'PADARIA TESTE', 20.5, 'Nicolas', 'Padaria', 'Cartão Credito', 'Despesa'],
];
const plSet = buildPlanilhaSet('planilha-set.xlsx', setRows);
const importFile = async (pg, file, wait) => { await tab(pg, 'importar'); await pg.setInputFiles('#file', file); await pg.waitForSelector(wait); };
const goAndWait = async (pg) => { await pg.locator('#iGo').click(); await pg.waitForSelector('#impBody .empty b'); };
{ // A: planilha primeiro, depois o extrato
  const c = await newPage('light'); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await importFile(pg, plSet, '#hYear');
  await pg.locator('[data-hn="Set"]').check().catch(() => {});
  await goAndWait(pg);
  await importFile(pg, bra.file, '[data-c="date"]');
  const lbl = await pg.locator('#iGo').innerText();
  check(new RegExp(`Importar ${bra.expect.n - 2} lançamentos e atualizar 2 já importados`).test(lbl), 'planilha → extrato: 2 já existem e ganham o cartão; o resto entra', lbl);
  await goAndWait(pg);
  const all = txOf(await dumpLocal(pg));
  const m = all.find((x) => x.desc === 'MERCADO TESTE' && x.amt === 100);
  check(all.length === bra.expect.n && m.src === 'planilha' && m.card === 'Nicolas' && m.seg === 'Nicolas & Ana Paula' && m.cat === 'Mercado' && m.status === 'ok', 'a classificação da planilha foi mantida e o cartão preenchido; nada duplicado', { n: all.length, m });
  await c.ctx.close();
}
{ // B: extrato primeiro, depois a planilha
  const c = await newPage('light'); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await importFile(pg, bra.file, '[data-c="date"]'); await goAndWait(pg);
  await importFile(pg, plSet, '#hYear');
  await pg.locator('[data-hn="Set"]').check().catch(() => {});
  const lbl = await pg.locator('#iGo').innerText();
  check(/Atualizar 2 lançamentos já importados/.test(lbl), 'extrato → planilha: as 2 linhas da planilha completam o que já entrou, em vez de serem descartadas', lbl);
  await goAndWait(pg);
  const all = txOf(await dumpLocal(pg));
  const m = all.find((x) => x.desc === 'MERCADO TESTE' && x.amt === 100), pd = all.find((x) => x.desc === 'PADARIA TESTE');
  check(all.length === bra.expect.n && m.src === 'extrato' && m.status === 'ok' && m.seg === 'Nicolas & Ana Paula' && m.cat === 'Mercado' && m.card === 'Nicolas' && pd.cat === 'Padaria' && pd.seg === 'Nicolas', 'a classificação que você fez na planilha chega nos lançamentos do extrato; cartão preservado', { n: all.length, m, pd });
  await c.ctx.close();
}

section('9f. Fatura de janeiro com compras de dezembro (virada de ano)');
{
  const jan = buildBradesco('bradesco-janeiro.xls', [{ name: 'NICOLAS DE TESTE SANTO', digits: '10001', rows: [
    ['28/12', 'LOJA TESTE', 80], ['05/01', 'MERCADO TESTE', 40], ['03/05', 'CURSO TESTE 2/6', 90], ['10/01', 'FARMACIA TESTE', 25]] }]);
  const c = await newPage('light', {}, new Date('2027-01-12T15:00:00Z')); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await importFile(pg, jan.file, '[data-c="date"]');
  check((await pg.locator('#iFat').inputValue()) === '2027-01', 'fatura de janeiro de 2027 (uma só seção, "NOME - 10001")');
  check(/confere com o total da fatura/.test(await pg.locator('#impBody').innerText()), 'soma confere');
  await goAndWait(pg);
  const j = txOf(await dumpLocal(pg));
  const d = (n) => j.find((x) => x.desc.startsWith(n)).d;
  check(d('LOJA') === '2026-12-28' && d('MERCADO') === '2027-01-05' && d('CURSO') === '2026-05-03' && d('FARMACIA') === '2027-01-10', 'dezembro e a parcela antiga ficam em 2026; janeiro em 2027', j.map((x) => [x.desc, x.d]));
  check(j.every((x) => x.ym === '2027-01' && x.card === 'Nicolas'), 'todos em jan/2027, no cartão do Nicolas');
  await c.ctx.close();
}

section('10. Sem erros no console');
check(errors.length === 0, 'nenhum erro de JavaScript nem de console', errors);
await ctx.close();

section('11. Instalável e abre sem internet (service worker)');
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c.addInitScript(() => { window.APP_CONFIG = { firebase: null }; });
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await c.newPage();
  await p.goto(url + '/index.html');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); // já controlado pelo service worker
  await p.waitForFunction(() => navigator.serviceWorker.controller);
  await c.setOffline(true);
  await p.reload();
  await p.waitForSelector('#v-resumo');
  check(/Controle de Finanças/.test(await p.locator('.brand').first().innerText()), 'app abre com a rede desligada');
  const hasXlsx = await p.evaluate(() => typeof XLSX !== 'undefined');
  check(hasXlsx, 'biblioteca de Excel carrega do cache offline');
  await c.setOffline(false);
  const mj = await (await fetch(url + '/manifest.webmanifest')).json();
  check(mj.display === 'standalone' && mj.icons.length >= 2, 'manifesto de app instalável');
  await c.close();
}

await browser.close();
srv.close();
finish();
