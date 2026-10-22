import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
export const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
const save = (wb, file) => fs.writeFileSync(file, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function serve(port = 0) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

let fails = 0, passes = 0;
export function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ok   ' + msg); }
  else { fails++; console.log('  FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
export function section(t) { console.log('\n' + t); }
export function finish() {
  console.log(`\n${passes} verificações ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
}

/* ---------- fixtures ---------- */
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Jun', 'Jul', 'Ago', 'Set'];
const pad = (n) => String(n).padStart(2, '0');

/* Planilha no formato da Financas_2026_v1.xlsm: uma aba por mês, colunas
   Data, Lugar, Valor, Responsável, Despesas, Método, Entrada vs Saída. */
export function buildPlanilha() {
  const rows = []; // verdade esperada, independente do app
  const wb = XLSX.utils.book_new();
  MESES.forEach((name, i) => {
    const m = i + 1, ym = `2026-${pad(m)}`;
    const sheet = [['Data', 'Lugar', 'Valor', 'Responsável', 'Despesas', 'Método', 'Entrada vs Saída']];
    const add = (day, desc, amt, seg, cat, met = 'Cartão Credito', tipo = 'Despesa') => {
      sheet.push([`${pad(day)}/${pad(m)}`, desc, amt, seg, cat, met, tipo]);
      if (amt) rows.push({ ym, desc, amt, seg, cat, tipo: tipo === 'Receita' ? 'R' : 'D' });
    };
    add(5, 'SALARIO FORD', 15000, 'Nicolas', null, 'Debito/Pix', 'Receita');
    add(5, 'MERCADO EXTRA SALVADOR', 400 + m * 10, 'Nicolas & Ana Paula', 'Mercado');
    add(8, 'PAG*UBER TRIP 123', 30 + m, 'Nicolas', 'Transporte por app');
    add(10, 'POSTO IPIRANGA SALVADOR', 250, 'Combustivel', 'Combustível');
    add(12, 'RACAO FAZENDA MIRANTE', 900, 'Granja', 'Ração Granja');
    // classificação ruim nos primeiros meses (caso do briefing): Janeiro foi para Combustível
    if (m === 1) add(15, 'LOUCOS POR SALGADOS', 35, 'Combustivel', 'Combustível');
    else add(15, 'LOUCOS POR SALGADOS', 35, 'Nicolas', 'Lanches / Junk food');
    // lugar que oscila entre categorias: nunca deve ser classificado sozinho
    if (m <= 2) add(18, 'PADARIA DO ZE', 22, 'Nicolas', 'Padaria');
    if (m === 3 || m === 4) add(18, 'PADARIA DO ZE', 22, 'Nicolas', 'Mercado');
    if (m === 1) sheet.push(['20/01', 'LINHA ZERADA', 0, 'Nicolas', 'Outros', 'Debito/Pix', 'Despesa']); // ignorada
    if (m === 9) add(20, 'LOJA SEM CATEGORIA', 77, 'Ana Paula', null); // vai para Confirmar
    wb.SheetNames.push(name);
    wb.Sheets[name] = XLSX.utils.aoa_to_sheet(sheet);
  });
  const file = path.join(OUT, 'planilha-teste.xlsx');
  save(wb, file);
  return { file, rows };
}

/* Extrato de cartão, com linhas de título antes do cabeçalho. */
export function buildExtrato(name, lines, { negative = false, sheetName = 'Fatura' } = {}) {
  const aoa = [['Extrato do cartão'], ['Emitido em 12/10/2026'], [], ['Data', 'Descrição', 'Valor', 'Titular']];
  lines.forEach(([d, desc, v, holder]) => aoa.push([d, desc, negative ? String(-v).replace('.', ',') : v, holder]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  const file = path.join(OUT, name);
  save(wb, file);
  return file;
}

/* leitura direta do IndexedDB do modo local, para conferir o que foi gravado de verdade */
export async function dumpLocal(page) {
  const all = await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('finance-local');
    r.onsuccess = () => {
      const t = r.result.transaction('docs', 'readonly'), out = {}, c = t.objectStore('docs').openCursor();
      c.onsuccess = () => { const k = c.result; if (k) { out[k.key] = k.value; k.continue(); } };
      t.oncomplete = () => res(out);
    };
    r.onerror = () => rej(r.error);
  }));
  return all;
}
export const txOf = (dump) => Object.entries(dump).filter(([k]) => k.startsWith('tx_')).map(([, v]) => v);
export const norm = (s) => String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/* Fatura no formato do Bradesco Internet Banking (.xls binário): uma seção por cartão ("NOME - 12345"), datas dd/mm sem ano,
   colunas Valor (US$) e Valor(R$), pagamento/saldo anterior no meio, totais por cartão e total da fatura.
   Dados inventados; o arquivo real do usuário nunca entra no repositório. */
const brl = (n) => n.toFixed(2).replace('.', ',');
export function buildBradesco(name, sections, { totalOverride } = {}) {
  const aoa = [[null], [null, null, 'Bradesco Internet Banking'], [null], [null], [null], [null], [null], ['Situação da Fatura: ABERTA'], ['']];
  const expect = { sections: {}, total: 0, n: 0 };
  for (const sec of sections) {
    aoa.push([`${sec.name} - ${sec.digits}`]);
    aoa.push(['Data', 'Histórico', '', 'Valor (US$)', 'Valor(R$)']);
    let sum = 0, n = 0;
    for (const [d, desc, brlv, usd = 0] of sec.rows) {
      aoa.push([d, desc, '', brl(usd), brl(brlv)]);
      if (!/SALDO ANTERIOR|^PAGTO/.test(desc)) { sum += brlv; n++; }
    }
    aoa.push([`Total para ${sec.name}`, null, null, null, brl(sum)]);
    aoa.push(['']);
    expect.sections[sec.name] = { n, sum: Math.round(sum * 100) / 100 };
    expect.total += sum; expect.n += n;
  }
  expect.total = Math.round(expect.total * 100) / 100;
  aoa.push(['Total da fatura em Real:', null, null, null, brl(totalOverride ?? expect.total)]);
  aoa.push([''], ['* Fatura em Aberto: Valores sujeitos a alteração até o fechamento da fatura.'], [''],
    ['Resumo das Despesas', 'Real'], ['Saldo Anterior', '1000,00'], ['(=)Total da fatura:', brl(expect.total)], ['Cotação do dólar utilizada:', '5,50']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet0');
  const file = path.join(OUT, name);
  fs.writeFileSync(file, XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
  return { file, expect };
}

/* Planilha mínima (só a aba Set) para testar a ordem de importação */
export function buildPlanilhaSet(name, rows) {
  const wb = XLSX.utils.book_new();
  ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'].forEach((n) => {
    const sheet = [['Data', 'Lugar', 'Valor', 'Responsável', 'Despesas', 'Método', 'Entrada vs Saída']];
    if (n === 'Set') rows.forEach((r) => sheet.push(r));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), n);
  });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  return file;
}

/* ---------- PDF ---------- */
export async function htmlToPdf(browser, html, file) {
  const p = await browser.newPage();
  await p.setContent(html);
  await p.pdf({ path: file, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
  await p.close();
  return file;
}

/* soma e quantidade esperadas de cada seção (sem saldo anterior e pagamento), como o app deve calcular */
export function expectOf(sections) {
  const expect = { sections: {}, total: 0, n: 0, lines: 0 };
  for (const sec of sections) {
    let sum = 0, n = 0;
    for (const [, desc, brlv] of sec.rows) { expect.lines++; if (!/SALDO ANTERIOR|^PAGTO/.test(desc)) { sum += brlv; n++; } }
    expect.sections[sec.name] = { n, sum: Math.round(sum * 100) / 100 };
    expect.total += sum; expect.n += n;
  }
  expect.total = Math.round(expect.total * 100) / 100;
  return expect;
}

/* fatura no layout do Bradesco, em HTML (vira PDF com texto). descWidth estreito quebra descrições longas em duas linhas. */
export function bradescoHtml(sections, { totalOverride, valign = 'middle', descWidth = 260 } = {}) {
  const e = expectOf(sections);
  let h = `<html><body style="font-family:Arial;font-size:9pt"><style>td{vertical-align:${valign}}</style><h2>Bradesco Internet Banking</h2><p>Situação da Fatura: ABERTA</p>`;
  for (const sec of sections) {
    h += `<h4>${sec.name} - ${sec.digits}</h4><table><thead><tr><th>Data</th><th>Histórico</th><th>Valor (US$)</th><th>Valor(R$)</th></tr></thead><tbody>`;
    for (const [d, desc, brlv, usd = 0] of sec.rows)
      h += `<tr><td style="width:60px">${d}</td><td style="width:${descWidth}px">${desc}</td><td style="width:70px;text-align:right">${brl(usd)}</td><td style="width:80px;text-align:right">${brl(brlv)}</td></tr>`;
    h += `</tbody></table><p style="margin:2px 0"><b>Total para ${sec.name}</b> &nbsp; ${brl(e.sections[sec.name].sum)}</p>`;
  }
  h += `<p><b>Total da fatura em Real:</b> &nbsp; ${brl(totalOverride ?? e.total)}</p><p>* Fatura em Aberto: Valores sujeitos a alteração até o fechamento da fatura.</p>`;
  h += `<p>Resumo das Despesas &nbsp; Real</p><p>Saldo Anterior &nbsp; 1000,00</p><p>(=)Total da fatura: &nbsp; ${brl(e.total)}</p><p>Cotação do dólar utilizada: &nbsp; 5,50</p></body></html>`;
  return { html: h, expect: e };
}

/* PDF só com imagem (sem texto selecionável), como um extrato escaneado */
export async function imageOnlyPdf(browser, file) {
  const shot = await browser.newPage({ viewport: { width: 500, height: 120 } });
  await shot.setContent('<body style="margin:0;font:bold 28px Arial">20/09 MERCADO TESTE 100,00<br>19/09 PADARIA TESTE 20,50</body>');
  const png = (await shot.screenshot()).toString('base64');
  await shot.close();
  return htmlToPdf(browser, `<html><body><img src="data:image/png;base64,${png}"></body></html>`, file);
}

export function encryptPdf(inFile, outFile, password) {
  const r = spawnSync('python3', ['-I', path.join(ROOT, 'tests', 'encrypt_pdf.py'), inFile, outFile, password], { encoding: 'utf8' });
  return r.status === 0;
}

/* Fatura oficial do Bradesco (PDF): tabela "Data | Histórico | Cidade | US$ | R$" com uma BARRA LATERAL na mesma altura (limites, taxas,
   pontos), cidade que quebra em duas linhas, parcela colada na descrição ("CONS09/10"), crédito com o "-" solto depois do valor,
   título "NOME  Cartão 3747 XXXXXX 12345", "Total para NOME" e "Total da fatura em real". Dados inventados. */
const f2 = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const FATURA_SECS = [
  { name: 'NICOLAS DE TESTE SANTOS', card: 'Nicolas', digits: '12345', rows: [
    ['30/01', 'D E MATERIAL DE CONS09/10', 'SANTO\nESTEVAO', 322.5, 'Compras R$ 60.428,11'],
    ['09/02', 'CLARO LJ SALVADOR SH09/12', 'SALVADOR', 36.5],
    ['22/09', 'MARKET4U*COMPRA*710786', 'CURITIBA', 9.98, 'Juros e encargos financeiros até o momento:'],
    ['26/09', 'CHURRASCARIA E LANCHONETE', 'FEIRA DE\nSANT', 103.49],
    ['03/10', 'PADARIA TESTE', 'SALVADOR', 20.5, 'Saldo de pontos Livelo em 21/10/26'],
    ['19/10', 'POSTO TESTE', 'CAMACARI', 150] ] },
  { name: 'ANA PAULA TESTE S', card: 'Ana Paula', digits: '23456', rows: [
    ['25/09', 'APPLE.COM/BILL', 'SAO PAULO', 69.9, 'Taxa ao Mês (%)'],
    ['08/10', 'AMAZONMKTPLC*USEEBRASI', 'SERRANA', -60],
    ['10/10', 'FARMACIA TESTE', 'SALVADOR', 45.9] ] },
  { name: 'EDUARDO X DA SILVEIRA', card: 'Eduardo', digits: '34567', rows: [
    ['17/09', 'RACAO TESTE', 'SANTO\nALVES', 900],
    ['16/10', 'LOJA AGRO TESTE02/10', 'ALVES', 188.93, 'Associado.'] ] },
];
export function faturaExpect() {
  const expect = { cards: {}, total: 0, lines: 1 };   // +1: a linha do pagamento da fatura anterior
  for (const sec of FATURA_SECS) {
    const sum = Math.round(sec.rows.reduce((a, r) => a + r[3], 0) * 100) / 100;
    expect.cards[sec.card] = { n: sec.rows.length, sum, name: sec.name };
    expect.total += sum; expect.lines += sec.rows.length;
  }
  expect.total = Math.round(expect.total * 100) / 100;
  return expect;
}

/* mesma fatura, desenhada item por item nas coordenadas do PDF real (Data x=45, Histórico 67, Cidade 205, R$ à direita em 349,
   sinal solto em 347, barra lateral em 362-366, cabeçalho só na primeira página da tabela) */
export function faturaColsPdf(file) {
  const expect = faturaExpect();
  const pages = [[], [], []];
  const L = (x, t) => [x, t, 'L'], R = (x, t) => [x, t, 'R'];
  pages[0].push({ y: 821, cells: [L(53, 'Fatura Mensal')] }, { y: 790, cells: [L(40, 'Total da fatura'), L(250, 'Vencimento')] }, { y: 776, cells: [L(40, `R$ ${f2(expect.total)}`), L(250, '01/11/2026')] },
    { y: 700, cells: [L(40, 'Resumo da fatura')] }, { y: 690, cells: [L(40, 'Saldo anterior......... R$ 5.000,00')] });
  const p2 = pages[1];
  p2.push({ y: 803, cells: [L(53, 'Fatura Mensal')] }, { y: 766, cells: [L(40, 'Número do Cartão'), L(130, '3747 XXXXXX 12345')] }, { y: 748, cells: [L(43, 'Lançamentos')] },
    { y: 732, cells: [L(273, 'Cotação')] },
    { y: 728, cells: [L(45, 'Data'), L(67, 'Histórico de Lançamentos'), L(204, 'Cidade'), L(253, 'US$'), L(332, 'R$')] },
    { y: 724, cells: [L(272, 'do Dólar')] },
    { y: 714, cells: [L(45, '01/10'), L(74, 'PAGTO. POR DEB EM C/C'), L(315, '5.000,00 -'), L(364, 'Total'), L(420, 'Utilizado')] });
  let y = 704, page = p2;
  const place = (cells) => { page.push({ y, cells }); };
  FATURA_SECS.forEach((sec, si) => {
    if (si === 1) { page = pages[2]; y = 780; page.push({ y: 821, cells: [L(53, 'Fatura Mensal')] }); }
    place([L(45, sec.name), L(210, 'Cartão'), L(232, `3747 XXXXXX ${sec.digits}`)]); y -= 10;
    for (const [d, desc, city, amt, side] of sec.rows) {
      const cells = [L(45, d), L(67, desc), L(205, city.split('\n')[0])];
      const neg = amt < 0, v = f2(Math.abs(amt));
      if (neg) { cells.push(R(344, v), L(347, '-')); } else cells.push(R(349, v));
      if (side) cells.push(L(/^(Juros|Saldo|Associado)/.test(side) ? 361 : 364, side));
      place(cells);
      if (city.includes('\n')) { y -= 8; place([L(205, city.split('\n')[1])]); }
      y -= 9;
    }
    place([L(45, `Total para ${sec.name}`), R(349, f2(expect.cards[sec.card].sum))]); y -= 12;
  });
  place([L(45, 'Total da fatura em real'), R(349, f2(expect.total))]);
  const spec = path.join(OUT, 'fatura-spec.json');
  fs.writeFileSync(spec, JSON.stringify({ pages }));
  const r = spawnSync('python3', ['-I', path.join(ROOT, 'tests', 'make_fatura_pdf.py'), spec, file], { encoding: 'utf8' });
  return r.status === 0 ? { file, expect } : null;
}

/* a mesma fatura como HTML, para gerar o PDF pelo navegador (que funde a data com a descrição num só texto) */
export function faturaColsHtml() {
  const expect = faturaExpect();
  const td = (v, st = '') => `<td style="${st}">${v ?? ''}</td>`;
  const row = (d, desc, city, amt, side) => {
    const neg = amt < 0, v = f2(Math.abs(amt));
    return `<tr>${td(d)}${td(desc)}${td((city || '').replace('\n', '<br>'))}${td('')}<td style="text-align:right">${v}${neg ? '<span style="margin-left:3px">-</span>' : ''}</td>${td('')}${td(side || '')}</tr>`;
  };
  let body = `<tr>${td('01/10')}${td('PAGTO. POR DEB EM C/C')}${td('')}${td('')}<td style="text-align:right">${f2(5000)} -</td>${td('')}${td('Total Utilizado Disponível em')}</tr>`;
  for (const sec of FATURA_SECS) {
    body += `<tr><td colspan="2" style="padding-top:6px">${sec.name}</td><td colspan="3" style="padding-top:6px">Cartão 3747 XXXXXX ${sec.digits}</td>${td('')}${td('')}</tr>`;
    for (const r of sec.rows) body += row(...r);
    body += `<tr><td colspan="4"><b>Total para ${sec.name}</b></td><td style="text-align:right">${f2(expect.cards[sec.card].sum)}</td>${td('')}${td('')}</tr>`;
  }
  body += `<tr><td colspan="4"><b>Total da fatura em real</b></td><td style="text-align:right">${f2(expect.total)}</td>${td('')}${td('')}</tr>`;
  const html = `<html><body style="font:8pt Arial;margin:0"><style>td,th{vertical-align:top;padding:1px 3px}thead{display:table-row-group}</style>
    <div>Fatura Mensal &nbsp; Página 1 de 1</div><div style="margin-top:14px">Total da fatura &nbsp; Vencimento</div><div>R$ ${f2(expect.total)} &nbsp; 01/11/2026</div>
    <div style="margin:14px 0 4px">Número do Cartão &nbsp; 3747 XXXXXX 12345</div>
    <table style="border-collapse:collapse;table-layout:fixed;width:680px"><colgroup><col style="width:48px"><col style="width:190px"><col style="width:92px"><col style="width:70px"><col style="width:70px"><col style="width:36px"><col style="width:174px"></colgroup>
    <thead><tr><th style="text-align:left">Data</th><th style="text-align:left">Histórico de Lançamentos</th><th style="text-align:left">Cidade</th><th style="text-align:left">US$</th><th style="text-align:right">R$</th><th></th><th></th></tr></thead>
    <tbody>${body}</tbody></table></body></html>`;
  return { html, expect };
}
