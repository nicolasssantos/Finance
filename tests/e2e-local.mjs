/* Teste de ponta a ponta no Chromium (viewport de celular), modo local (IndexedDB).
   Roda: npm test   -> imprime ok/FAIL e salva capturas de tela em tests/out/ */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { serve, check, section, finish, buildPlanilha, buildExtrato, dumpLocal, txOf, norm, OUT } from './helpers.mjs';

const { srv, url } = await serve();
const browser = await chromium.launch();
const NOW = new Date('2026-10-12T15:00:00Z');
const errors = [];

async function newPage(scheme = 'light', ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block', acceptDownloads: true, ...ctxOpts });
  await ctx.clock.setFixedTime(NOW);
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
check(/Nenhum lançamento ainda/.test(await page.locator('#v-resumo').innerText()), 'estado vazio no primeiro acesso');
await shot(page, '01-vazio-claro');

await tab(page, 'importar');
await page.setInputFiles('#file', planilha);
await page.waitForSelector('#hYear');
const monthsOn = await page.locator('[data-hn]:checked').count();
check(monthsOn === 9, 'Janeiro a Setembro marcados por padrão (outubro ainda em andamento)', monthsOn);
check(await page.locator('#hYear').inputValue() === '2026', 'ano da planilha = 2026');
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
await shot(page, '03-resumo-claro');
await tab(page, 'gastos');
await shot(page, '04-gastos-claro');
await tab(page, 'ajustes');
check(await noOverflow(page), 'sem rolagem horizontal em Ajustes');
await shot(page, '05-ajustes-claro');

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
await page.fill('#q', 'mercado');
const filtered = await page.locator('#gList .tx').count();
check(filtered === 1, 'busca por "mercado" mostra 1 lançamento em outubro', filtered);
await page.fill('#q', '');
await page.locator('#gList .tx', { hasText: 'CAFE CENTRAL' }).first().click();
check(await page.locator('#sheet #eAll').count() === 1, 'folha de edição oferece "aplicar aos outros deste lugar"');
await shot(page, '10-editar-claro');
await page.locator('#eClose').click();

await page.locator('#addBtn').click();
await page.fill('#mV', '150.50');
await page.fill('#mN', 'Pix diarista');
await page.locator('#sheet [data-seg="Nicolas & Ana Paula"]').click();
await page.locator('#mC').selectOption('Diarista / Empregada');
await page.locator('#mSave').click();
await page.waitForFunction(() => /Lançamento salvo/.test(document.querySelector('#toast').textContent));
const manual = txOf(await dumpLocal(page)).find((t) => t.src === 'manual');
check(manual && manual.amt === 150.5 && manual.ym === '2026-10' && manual.status === 'ok' && manual.cat === 'Diarista / Empregada', 'lançamento manual gravado', manual);

section('9. Ajustes: titulares e categorias');
await tab(page, 'ajustes');
await page.fill('#ncN', 'Categoria de teste');
await page.locator('#ncA').click();
check(await page.locator('.chip', { hasText: 'Categoria de teste' }).count() === 1, 'nova categoria aparece');
check(/Dados só neste navegador/.test(await page.locator('#v-ajustes').innerText()), 'aviso claro de que no modo local os dados ficam só no navegador');

section('10. Sem erros no console');
check(errors.length === 0, 'nenhum erro de JavaScript nem de console', errors);
await ctx.close();

section('11. Instalável e abre sem internet (service worker)');
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
