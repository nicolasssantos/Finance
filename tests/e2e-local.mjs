/* Teste de ponta a ponta no Chromium (viewport de celular), modo local (IndexedDB).
   Roda: npm test   -> imprime ok/FAIL e salva capturas de tela em tests/out/ */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { serve, check, section, finish, buildPlanilha, buildExtrato, buildBradesco, buildPlanilhaSet, dumpLocal, txOf, norm, OUT, XLSX, htmlToPdf, bradescoHtml, expectOf, imageOnlyPdf, encryptPdf, faturaColsHtml, faturaColsPdf, faturaExpect } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

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
const pickMonth = async (pg) => { const c = pg.locator('[data-fm][data-sug]'); if (await c.count()) await c.click(); };  // responde "para qual mês é este extrato?" com o mês sugerido
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
await pickMonth(page);
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
await pickMonth(page);
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
await pickMonth(page);
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
await pickMonth(page);
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
await pickMonth(page);
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
await pickMonth(page);
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
await pickMonth(bp);
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
await pickMonth(bp);
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
const importFile = async (pg, file, wait) => { await tab(pg, 'importar'); await pg.setInputFiles('#file', file); await pg.waitForSelector(wait); await pickMonth(pg); };
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

section('9g. O app pergunta para qual mês é o extrato');
{
  const c = await newPage('light'); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await tab(pg, 'importar'); await pg.setInputFiles('#file', bra.file); await pg.waitForSelector('[data-c="date"]');
  const q = norm(await pg.locator('#mCard').innerText());
  check(/para qual mês é este extrato\?/i.test(q), 'a tela pergunta "Para qual mês é este extrato?" logo no topo');
  check(/Sugestão pela última compra do arquivo: Setembro 2026/.test(q), 'sugere setembro de 2026 e diz por quê');
  const chips = await pg.locator('#mCard [data-fm]').allTextContents();
  check(JSON.stringify(chips) === JSON.stringify(['Agosto 2026', 'Setembro 2026 · sugerido', 'Outubro 2026']), 'oferece o mês sugerido e os vizinhos', chips);
  check(await pg.locator('#iGo').isDisabled() && /Escolha o mês do extrato para importar/.test(await pg.locator('#iGo').innerText()), 'enquanto você não responde, o botão de importar fica travado');
  check(await pg.locator('#mCard [data-fm].on').count() === 0, 'nenhum mês vem escolhido por padrão (a sugestão não vale como resposta)');
  await shot(pg, '20-pergunta-mes');
  // um mês antes de 2026 é recusado
  await pg.locator('#iFat').fill('2025-12');
  check(/começa em janeiro de 2026/.test(await pg.locator('#toast').innerText()) && await pg.locator('#iGo').isDisabled(), 'mês anterior a 2026 é recusado');
  // outro mês pelo campo
  await pg.locator('#iFat').fill('2026-08');
  check(await pg.locator('#iGo').isEnabled() && /Importando para Agosto 2026/.test(norm(await pg.locator('#mCard').innerText())), 'escolher "Outro mês" libera o botão e confirma o mês');
  // escolhe outubro pelo botão (diferente da sugestão)
  await pg.locator('#mCard [data-fm="2026-10"]').click();
  check(/Importando para Outubro 2026/.test(norm(await pg.locator('#mCard').innerText())) && await pg.locator('#mCard [data-fm="2026-10"].on').count() === 1, 'o mês escolhido aparece marcado e confirmado');
  await shot(pg, '21-mes-escolhido');
  await goAndWait(pg);
  const tx = txOf(await dumpLocal(pg));
  check(tx.length === bra.expect.n && tx.every((x) => x.ym === '2026-10'), 'todos os lançamentos entram em outubro, o mês escolhido', [...new Set(tx.map((x) => x.ym))]);
  check(tx.find((x) => x.desc.startsWith('MAQUINA')).d === '2025-09-23' && tx.find((x) => x.desc === 'MERCADO TESTE' && x.amt === 100).d === '2026-09-20', 'escolher outro mês não muda as datas das compras (o ano vem do arquivo)');
  await c.ctx.close();
}
{
  const c = await newPage('light'); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await tab(pg, 'importar'); await pg.setInputFiles('#file', bra.file); await pg.waitForSelector('[data-c="date"]');
  await pg.locator('#mCard [data-comp="compra"]').click();
  check(/mês da própria compra/.test(await pg.locator('#mCard').innerText()) && await pg.locator('#iGo').isEnabled(), '"Usar o mês de cada compra" dispensa a escolha e libera o botão');
  await goAndWait(pg);
  const tx = txOf(await dumpLocal(pg));
  const months = [...new Set(tx.map((x) => x.ym))].sort();
  check(months.includes('2026-09') && months.includes('2026-02') && months.includes('2025-11') && tx.every((x) => x.ym === x.d.slice(0, 7)), 'cada lançamento fica no mês da própria compra', months);
  await c.ctx.close();
}
{ // planilha de histórico não tem a pergunta (cada aba já é um mês)
  const c = await newPage('light'); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await tab(pg, 'importar'); await pg.setInputFiles('#file', plSet); await pg.waitForSelector('#hYear');
  check(await pg.locator('#mCard').count() === 0 && await pg.locator('#iGo').isEnabled(), 'planilha de histórico não pergunta o mês (cada aba já é um mês)');
  await c.ctx.close();
}

section('9h. Extrato em PDF');
{
  const pdfText = (f) => { const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
  const openPdf = async (file, wait = '#mCard') => {
    const c = await newPage('light'); const pg = c.page;
    await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
    await tab(pg, 'importar'); await pg.setInputFiles('#file', file); await pg.waitForSelector(wait, { timeout: 40000 });
    return c;
  };
  check((await page.locator('#file').getAttribute('accept')).includes('.pdf'), 'o seletor de arquivo aceita PDF');

  // 1) layout do Bradesco com colunas estreitas: descrições quebram em duas e três linhas (data e valor ficam no meio)
  const wrapSec = BR_SEC.map((s) => ({ ...s, rows: [...s.rows] }));
  wrapSec[0].rows.push(['20/09', 'LOJA COM NOME MUITO LONGO 1/6', 77.7]);
  const g1 = bradescoHtml(wrapSec, { descWidth: 130 });
  const pdf1 = await htmlToPdf(browser, g1.html, path.join(OUT, 'bradesco-teste.pdf'));
  const txt1 = pdfText(pdf1);
  if (txt1) check(/LOJA COM\s*\n/.test(txt1) && /\n\s*LONGO 1\/6/.test(txt1) && /\n\s*SALDO\s*\n/.test(txt1), 'precondição: no PDF as descrições realmente quebram em várias linhas (inclusive SALDO / ANTERIOR)');
  const c1 = await openPdf(pdf1); const p1 = c1.page;
  const t1 = norm(await p1.locator('#impBody').innerText());
  check(new RegExp(`reconheci ${g1.expect.lines} lançamentos`).test(t1), `PDF do Bradesco: ${g1.expect.lines} linhas reconhecidas (compras, saldo anterior e pagamento)`, t1.match(/reconheci[^.]*/));
  check(JSON.stringify(await p1.locator('[data-h]').evaluateAll((els) => els.map((e) => e.value))) === JSON.stringify(['Nicolas', 'Ana Paula', 'Fazenda']), 'PDF: os 3 cartões vêm da seção de cada um');
  check(/confere com o total da fatura/.test(t1) && /2 pagamentos de fatura ignorados/.test(t1), 'PDF: soma confere com o total da fatura; saldo e pagamento ignorados');
  check(await p1.locator('#iSheet, [data-c="date"]').count() === 0, 'PDF: não mostra a caixa de colunas do Excel');
  await shot(p1, '22-importar-pdf');
  await pickMonth(p1);
  check(new RegExp(`Importar ${g1.expect.n} lançamentos`).test(await p1.locator('#iGo').innerText()), `PDF: ${g1.expect.n} lançamentos na prévia`);
  await goAndWait(p1);
  const x1 = txOf(await dumpLocal(p1));
  const by1 = {}; x1.forEach((x) => { (by1[x.card] ||= { n: 0, s: 0 }); by1[x.card].n++; by1[x.card].s += x.amt; });
  const okCards = Object.entries(g1.expect.sections).every(([nm, e]) => by1[cardOfSec[nm]] && by1[cardOfSec[nm]].n === e.n && Math.abs(by1[cardOfSec[nm]].s - e.sum) < 0.005);
  check(okCards, 'PDF: cada cartão com a quantidade e a soma do "Total para…"', { by1, e: g1.expect.sections });
  const w1 = x1.find((x) => x.desc.startsWith('LOJA COM NOME'));
  check(w1 && w1.desc === 'LOJA COM NOME MUITO LONGO 1/6' && w1.amt === 77.7 && w1.d === '2026-09-20', 'PDF: descrição quebrada em três linhas foi remontada, com o valor e a data certos', w1);
  const d1 = (n) => x1.find((x) => x.desc.startsWith(n));
  check(d1('MAQUINA').d === '2025-09-23' && d1('LIVRARIA').d === '2025-11-24' && d1('CELULAR').d === '2026-02-09' && d1('HOTEL').amt === 110 && x1.some((x) => x.amt === -60 && x.card === 'Eduardo'), 'PDF: parcelas antigas no ano certo, valor em reais (não US$) e estorno como crédito');
  await c1.ctx.close();

  // 1b) marcador de parcela (n/m) que cai na linha de baixo, com a data e o valor no topo da célula
  const topSec = [{ name: 'NICOLAS DE TESTE SANTO', digits: '10001', rows: [['20/09', 'MERCADO TESTE', 100], ['24/11', 'MERCADOLIVRE*MERCADOLI 10/12', 358.68]] }];
  const g1b = bradescoHtml(topSec, { descWidth: 110, valign: 'top' });
  const pdf1b = await htmlToPdf(browser, g1b.html, path.join(OUT, 'bradesco-marcador.pdf'));
  const txt1b = pdfText(pdf1b);
  if (txt1b) check(/\n\s*10\/12\s*\n/.test(txt1b), 'precondição: o marcador 10/12 realmente caiu em outra linha');
  const c1b = await openPdf(pdf1b); await pickMonth(c1b.page); await goAndWait(c1b.page);
  const x1b = txOf(await dumpLocal(c1b.page)).find((x) => x.desc.startsWith('MERCADOLIVRE'));
  check(x1b && x1b.desc === 'MERCADOLIVRE*MERCADOLI 10/12' && x1b.amt === 358.68 && x1b.d === '2025-11-24', 'PDF: marcador de parcela na linha de baixo volta para a descrição', x1b);
  await c1b.ctx.close();

  // 2) várias páginas, com o cabeçalho repetido em cada uma
  const bigSec = [{ name: 'NICOLAS DE TESTE SANTO', digits: '10001', rows: Array.from({ length: 110 }, (_, i) => [`${String(1 + (i % 20)).padStart(2, '0')}/09`, `LOJA TESTE ${String.fromCharCode(65 + (i % 26))}${i}`, 10 + i]) }];
  const g2 = bradescoHtml(bigSec);
  const pdf2 = await htmlToPdf(browser, g2.html, path.join(OUT, 'bradesco-grande.pdf'));
  const c2 = await openPdf(pdf2); const p2 = c2.page;
  const t2 = norm(await p2.locator('#impBody').innerText());
  const pages2 = +(t2.match(/Li (\d+) páginas/) || [])[1];
  check(pages2 >= 2 && new RegExp(`reconheci ${g2.expect.lines} lançamentos`).test(t2), `PDF de ${pages2} páginas: as ${g2.expect.lines} linhas foram lidas, apesar do cabeçalho repetido`, t2.match(/Li [^.]*/));
  check(/confere com o total da fatura/.test(t2), 'PDF de várias páginas: soma confere com o total');
  await c2.ctx.close();

  // 3) estilo "15 SET", valores "R$ 123,45", créditos de várias formas, sem seção de cartão
  const row = (d, n, v) => `<div style="display:flex;gap:20px;margin:3px 0"><span style="width:60px">${d}</span><span style="width:230px">${n}</span><span style="width:110px;text-align:right">${v}</span></div>`;
  const nuHtml = `<html><body style="font-family:Arial;font-size:10pt"><h3>Fatura de setembro</h3><p>Total a pagar R$ 1.234,56</p><div>Transações</div>${row('15 SET', 'Mercado Extra', 'R$ 123,45')}${row('16 SET', 'Uber *Trip', 'R$ 30,00')}${row('17 SET', 'Padaria Central', 'R$ 20,50')}${row('18 SET', 'Estorno Loja', '-R$ 25,00')}${row('19 SET', 'Desconto promocional', '10,00-')}${row('20 SET', 'Cashback', '12,50 CR')}</body></html>`;
  const pdf3 = await htmlToPdf(browser, nuHtml, path.join(OUT, 'fatura-simples.pdf'));
  const c3 = await openPdf(pdf3); const p3 = c3.page;
  check(/reconheci 6 lançamentos/.test(norm(await p3.locator('#impBody').innerText())) && await p3.locator('#iFixed').count() === 1, 'PDF simples ("15 SET", R$): 6 lançamentos e pergunta de quem é o cartão');
  await pickMonth(p3);
  check(await p3.locator('#iGo').isDisabled(), 'sem dizer de quem é o cartão, o botão fica travado');
  await p3.locator('#iFixed').selectOption('Ana Paula');
  check(/Importar 6 lançamentos/.test(await p3.locator('#iGo').innerText()), 'depois de escolher o cartão, libera a importação');
  await goAndWait(p3);
  const x3 = txOf(await dumpLocal(p3));
  const am = (n) => x3.find((x) => x.desc.startsWith(n)).amt;
  check(x3.length === 6 && x3.every((x) => x.card === 'Ana Paula' && x.ym === '2026-09') && am('Mercado') === 123.45 && am('Estorno') === -25 && am('Desconto') === -10 && am('Cashback') === -12.5, 'PDF simples: valores, créditos (-R$, 10,00-, 12,50 CR) e cartão escolhido', x3.map((x) => [x.desc, x.amt]));
  await c3.ctx.close();

  // 4) PDF escaneado (só imagem)
  const c4 = await openPdf(await imageOnlyPdf(browser, path.join(OUT, 'escaneado.pdf')), '#impBody .warn'); const p4 = c4.page;
  check(/não tem texto para ler/.test(await p4.locator('#impBody .warn').innerText()) && await p4.locator('#mCard').count() === 0, 'PDF escaneado: explica que não há texto e sugere Excel/CSV');
  await c4.ctx.close();

  // 5) PDF protegido por senha
  const pdfEnc = path.join(OUT, 'bradesco-senha.pdf');
  if (encryptPdf(pdf1, pdfEnc, 'abc123')) {
    const c5 = await openPdf(pdfEnc, '#pdfPwd'); const p5 = c5.page;
    check(/protegido por senha/.test(await p5.locator('#sheet').innerText()), 'PDF com senha: pede a senha');
    await p5.locator('#pdfPwd').fill('errada'); await p5.locator('#pdfOk').click();
    await p5.waitForFunction(() => /Senha incorreta/.test((document.querySelector('#sheet') || {}).innerText || ''), null, { timeout: 30000 });
    check(true, 'senha errada: avisa e pede de novo');
    await p5.locator('#pdfPwd').fill('abc123'); await p5.locator('#pdfOk').click();
    await p5.waitForSelector('#mCard', { timeout: 40000 });
    check(new RegExp(`reconheci ${g1.expect.lines} lançamentos`).test(norm(await p5.locator('#impBody').innerText())), 'senha certa: lê o PDF normalmente');
    await c5.ctx.close();
  } else console.log('  (pulado) PDF com senha: pypdf não disponível');

  // 6) PDF com texto mas sem lançamentos; 7) arquivo corrompido
  const c6 = await openPdf(await htmlToPdf(browser, '<html><body><h3>Comprovante de pagamento</h3><p>Pagamento realizado com sucesso</p><p>Valor total R$ 100,00</p></body></html>', path.join(OUT, 'sem-lancamentos.pdf')), '#impBody .warn');
  check(/Não encontrei lançamentos/.test(await c6.page.locator('#impBody .warn').innerText()) && await c6.page.locator('#impBody details').count() === 1, 'PDF sem lançamentos: avisa e deixa ver o que o app leu');
  await c6.ctx.close();
  fs.writeFileSync(path.join(OUT, 'corrompido.pdf'), '%PDF-1.4\nisto não é um pdf de verdade');
  const c7 = await openPdf(path.join(OUT, 'corrompido.pdf'), '#impBody .warn');
  check(/Não consegui abrir este PDF/.test(await c7.page.locator('#impBody .warn').innerText()), 'PDF corrompido: mensagem clara, sem travar');
  await c7.ctx.close();
}

section('9i. Fatura oficial do Bradesco em PDF (colunas, barra lateral, cidade, parcela colada, crédito)');
{
  const fat = faturaColsPdf(path.join(OUT, 'fatura-oficial-teste.pdf'));
  const g = { expect: fat.expect }, pdf = fat.file;
  const r = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  if (r.status === 0) check(/MATERIAL DE CONS09\/10.*Compras R\$ 60\.428,11/.test(r.stdout) && /PADARIA TESTE.*Saldo de pontos/.test(r.stdout), 'precondição: no PDF a barra lateral está na mesma linha dos lançamentos');
  const c = await newPage('light', {}, new Date('2026-10-22T15:00:00Z')); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await tab(pg, 'importar'); await pg.setInputFiles('#file', pdf); await pg.waitForSelector('#mCard', { timeout: 40000 });
  const tx = norm(await pg.locator('#impBody').innerText());
  check(new RegExp(`Li 3 páginas e reconheci ${g.expect.lines} lançamentos`).test(tx), `fatura oficial: ${g.expect.lines} linhas reconhecidas (compras mais o pagamento), em 3 páginas com o cabeçalho só na primeira`, tx.match(/Li [^.]*/));
  check(/Sugestão pela última compra do arquivo: Outubro 2026/.test(tx), 'sugere outubro de 2026 (a última compra é de 19/10)');
  check(JSON.stringify(await pg.locator('[data-h]').evaluateAll((els) => els.map((e) => e.value))) === JSON.stringify(['Nicolas', 'Ana Paula', 'Fazenda']), 'títulos "NOME  Cartão 3747 XXXXXX nnnnn": os 3 cartões associados (nome completo ou truncado)');
  check(/confere com o total da fatura/.test(tx) && /1 pagamentos de fatura ignorados/.test(tx) && !/não consegui entender/.test(tx), 'soma confere com "Total da fatura em real"; pagamento ignorado; nenhuma linha perdida');
  await shot(pg, '23-fatura-oficial-pdf');
  await pickMonth(pg);
  await goAndWait(pg);
  const x = txOf(await dumpLocal(pg));
  const by = {}; x.forEach((t) => { (by[t.card] ||= { n: 0, s: 0 }); by[t.card].n++; by[t.card].s += t.amt; });
  const ok = Object.entries(g.expect.cards).every(([card, e]) => by[card] && by[card].n === e.n && Math.abs(by[card].s - e.sum) < 0.005);
  check(ok, 'cada cartão tem a quantidade e a soma do "Total para…" do PDF', { by, e: g.expect.cards });
  check(!x.some((t) => t.amt === 60428.11 || /Compras|Juros|Saldo de pontos|Associado|Taxa ao/.test(t.desc)), 'nada da barra lateral entrou (nem valores, nem texto), inclusive a que começa a poucos pt da tabela (x=361)');
  const d = (n) => x.find((t) => t.desc.startsWith(n));
  check(d('MARKET4U*COMPRA*710786').desc === 'MARKET4U*COMPRA*710786' && d('CHURRASCARIA').desc === 'CHURRASCARIA E LANCHONETE', 'a coluna Cidade não entra na descrição (nem a cidade quebrada em duas linhas)');
  check(d('D E MATERIAL').desc === 'D E MATERIAL DE CONS 09/10' && d('LOJA AGRO').desc === 'LOJA AGRO TESTE 02/10', 'parcela colada na descrição ("CONS09/10") é separada');
  check(d('D E MATERIAL').d === '2026-01-30' && d('CLARO').d === '2026-02-09' && d('POSTO').d === '2026-10-19', 'datas sem ano resolvidas pelo ciclo da fatura');
  const cr = x.find((t) => t.desc.startsWith('AMAZONMKTPLC'));
  check(cr && cr.amt === -60 && cr.card === 'Ana Paula', 'crédito com o "-" solto depois do valor fica negativo, no cartão certo', cr);
  check(x.every((t) => t.ym === '2026-10'), 'todos entram em outubro');
  await c.ctx.close();
}
{ // a mesma fatura pelo Excel e pelo PDF: o nome truncado do PDF ("CONS") e o do Excel ("CONSTR") são o mesmo lugar
  const fe = faturaExpect();
  const xl = buildExtrato('extrato-parcela.xlsx', [['30/01/2026', 'D E MATERIAL DE CONSTR 8/10', 322.5, 'NICOLAS SANTOS'], ['19/10/2026', 'POSTO TESTE', 150, 'NICOLAS SANTOS']]);
  const c = await newPage('light', {}, new Date('2026-10-22T15:00:00Z')); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await importFile(pg, xl, '[data-c="date"]'); await pg.locator('#mCard [data-fm="2026-10"]').click(); await goAndWait(pg);
  await importFile(pg, path.join(OUT, 'fatura-oficial-teste.pdf'), '#mCard'); await pg.locator('#mCard [data-fm="2026-10"]').click();
  const lbl = await pg.locator('#iGo').innerText(), nota = norm(await pg.locator('#impBody').innerText());
  check(new RegExp(`Importar ${fe.lines - 1 - 2} lançamentos`).test(lbl) && /2 já importados/.test(nota), 'Excel → PDF: as 2 linhas já importadas (inclusive a parcela com nome truncado) não duplicam', [lbl, nota.match(/\d+ já importados[^.]*/)]);
  await goAndWait(pg);
  const all = txOf(await dumpLocal(pg));
  check(all.length === fe.lines - 1, 'nenhum gasto contado duas vezes', all.length);
  await c.ctx.close();
}
{ // o mesmo conteúdo salvo pelo navegador: data e descrição fundidas num só texto
  const g = faturaColsHtml();
  const pdf = await htmlToPdf(browser, g.html, path.join(OUT, 'fatura-navegador-teste.pdf'));
  const c = await newPage('light', {}, new Date('2026-10-22T15:00:00Z')); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await tab(pg, 'importar'); await pg.setInputFiles('#file', pdf); await pg.waitForSelector('#mCard', { timeout: 40000 });
  await pickMonth(pg); await goAndWait(pg);
  const x = txOf(await dumpLocal(pg));
  const by = {}; x.forEach((t) => { (by[t.card] ||= { n: 0, s: 0 }); by[t.card].n++; by[t.card].s += t.amt; });
  check(Object.entries(g.expect.cards).every(([card, e]) => by[card] && by[card].n === e.n && Math.abs(by[card].s - e.sum) < 0.005) && !x.some((t) => t.amt === 60428.11), 'PDF salvo pelo navegador (data e descrição fundidas): mesmas contagens e somas, sem a barra lateral', by);
  await c.ctx.close();
}

section('9j. Fazenda por operação e a regra do cartão (Eduardo = fazenda; Nicolas e Ana Paula = casa)');
{
  const rowsF = [
    ['05/09', 'MEDICAMENTO LEITE', 300, 'Leite', 'Medicamento Leite', 'Cartão Credito', 'Despesa'],
    ['06/09', 'ORDENHA NOVA', 1200, 'Investimento Leite', 'Manutenção Ordenha Leite', 'Cartão Credito', 'Despesa'],
    ['07/09', 'RACAO GRANJA', 900, 'Granja', 'Ração Granja', 'Cartão Credito', 'Despesa'],
    ['08/09', 'POSTO FAZENDA', 250, 'Combustivel', 'Combustível', 'Cartão Credito', 'Despesa'],
    ['09/09', 'ALEVINOS TESTE', 400, 'Peixe', 'Outros', 'Cartão Credito', 'Despesa'],
    ['10/09', 'MERCADO CASA', 200, 'Nicolas & Ana Paula', 'Mercado', 'Debito/Pix', 'Despesa'],
  ];
  const plF = buildPlanilhaSet('planilha-fazenda.xlsx', rowsF);
  const exF = buildExtrato('extrato-cartoes.xlsx', [
    ['05/09/2026', 'FORNECEDOR NOVO TESTE', 150, 'EDUARDO SILVEIRA'], ['06/09/2026', 'OUTRO FORNECEDOR TESTE', 50, 'EDUARDO SILVEIRA'], ['07/09/2026', 'MERCADO NICOLAS TESTE', 80, 'NICOLAS SANTOS']]);
  const c = await newPage('light', {}, new Date('2026-10-22T15:00:00Z')); const pg = c.page;
  await pg.goto(url + '/index.html'); await pg.waitForFunction(() => /Nenhum lançamento/.test(document.querySelector('#v-resumo').innerText));
  await importFile(pg, plF, '#hYear'); await goAndWait(pg);
  await importFile(pg, exF, '[data-c="date"]'); await goAndWait(pg);
  await tab(pg, 'resumo');
  const faz = () => pg.locator('#fazCard .brow').evaluateAll((rows) => rows.map((r) => [r.dataset.op, r.querySelector('.v').firstChild.textContent.trim().replace(/ /g, ' '), (r.querySelector('.hint') || { textContent: '' }).textContent.replace(/ /g, ' ')]));
  const want = [['Leite', 'R$ 1.500,00', 'Custeio R$ 300,00 · Investimento R$ 1.200,00'], ['Granja', 'R$ 900,00', ''], ['Peixe', 'R$ 400,00', ''], ['Combustível', 'R$ 250,00', ''], ['A classificar', 'R$ 200,00', '']];
  const got = await faz();
  check(JSON.stringify(got) === JSON.stringify(want), 'Resumo (mês): "Fazenda por operação" mostra Leite (custeio + investimento), Granja, Peixe, Combustível e o que ainda está sem operação', got);
  check(norm(await pg.locator('#fazCard .num').first().innerText()) === 'R$ 3.250,00' && /No cartão: R\$ 200,00/.test(norm(await pg.locator('#fazCard').innerText())), 'total da fazenda (R$ 3.250,00) e quanto dele está no cartão Eduardo (R$ 200,00)');
  check(await pg.locator('#v-resumo .big').count() === 1, 'o total do mês continua único no topo');
  check(await noOverflow(pg) && await pg.evaluate(() => { const c = document.querySelector('#fazCard'); return c.scrollWidth <= c.clientWidth && [...c.querySelectorAll('*')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1); }), 'o cartão novo cabe na largura da tela');
  await pg.evaluate(() => document.querySelector('#fazCard').scrollIntoView({ block: 'start' }));
  await shot(pg, '24-fazenda-por-operacao');
  await pg.locator('[data-rv="ano"]').click();
  check(JSON.stringify(await faz()) === JSON.stringify(want), 'Resumo (ano): a mesma divisão por operação');
  await pg.locator('[data-rv="mes"]').click();

  // regra do cartão nas telas de edição e de lançamento manual
  const FARM8 = ['Leite', 'Investimento Leite', 'Granja', 'Investimento Granja', 'Peixe', 'Investimento Peixe', 'Combustivel', 'Outros'];
  const chips = () => pg.locator('#sChips [data-seg]').allTextContents();
  await tab(pg, 'gastos');
  await pg.locator('#gList .tx', { hasText: 'FORNECEDOR NOVO TESTE' }).click();
  check(JSON.stringify(await chips()) === JSON.stringify(FARM8) && /Cartão Eduardo é da fazenda/.test(await pg.locator('#sheet').innerText()), 'gasto do cartão Eduardo: só as operações da fazenda');
  await shot(pg, '25-editar-cartao-eduardo');
  await pg.locator('#eClose').click();
  await pg.locator('#gList .tx', { hasText: 'MERCADO NICOLAS TESTE' }).click();
  check(JSON.stringify(await chips()) === JSON.stringify(['Nicolas', 'Ana Paula', 'Nicolas & Ana Paula']) && /Cartão Nicolas é da casa/.test(await pg.locator('#sheet').innerText()), 'gasto do cartão do Nicolas: só as pessoas da casa');
  await pg.locator('#eClose').click();
  await pg.locator('#gList .tx', { hasText: 'MERCADO CASA' }).click();
  check((await chips()).length === 11, 'gasto sem cartão (Pix, planilha): todas as opções');
  await pg.locator('#cChips [data-card="Eduardo"]').click();
  check(JSON.stringify(await chips()) === JSON.stringify(FARM8) && await pg.locator('#sChips .chip.on').count() === 0 && await pg.locator('#eSave').isDisabled(), 'passar o gasto para o cartão Eduardo troca as opções para as da fazenda e limpa a pessoa da casa');
  await pg.locator('#sChips [data-seg="Leite"]').click();
  await pg.locator('#eCat').selectOption('Medicamento Leite');
  await pg.locator('#eSave').click();
  await pg.waitForFunction(() => !document.querySelector('#sheetbg').classList.contains('on'));
  const moved = txOf(await dumpLocal(pg)).find((x) => x.desc === 'MERCADO CASA');
  check(moved.card === 'Eduardo' && moved.seg === 'Leite' && moved.grp === 'fazenda', 'o gasto movido para o cartão Eduardo fica como operação da fazenda', moved);
  await pg.locator('#addBtn').click();
  await pg.locator('#sheet [data-k="mC"]').click(); await pg.locator('#sheet [data-k="cE"]').click();
  check(JSON.stringify(await chips()) === JSON.stringify(FARM8), 'lançamento manual no cartão Eduardo: só as operações da fazenda');
  await pg.locator('#sheet [data-k="cN"]').click();
  check(JSON.stringify(await chips()) === JSON.stringify(['Nicolas', 'Ana Paula', 'Nicolas & Ana Paula']), 'trocar para o cartão do Nicolas troca as opções para as da casa');
  await pg.locator('#mClose').click();
  await tab(pg, 'ajustes');
  check(/Fazenda \(cartão Eduardo\): Leite · Investimento Leite · Granja/.test(norm(await pg.locator('#v-ajustes').innerText())), 'Ajustes explica a divisão: casa (cartões Nicolas e Ana Paula) e fazenda (cartão Eduardo)');
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
