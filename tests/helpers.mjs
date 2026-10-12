import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
