/* Teste da versão em nuvem contra o emulador do Firebase (Auth + Firestore com as regras reais de firestore.rules).
   Roda: npm run test:cloud */
import { chromium } from 'playwright';
import path from 'node:path';
import { serve, check, section, finish, buildPlanilha, norm, OUT } from './helpers.mjs';

const AUTH = 'http://127.0.0.1:9099', FS = ['127.0.0.1', 8080], PROJECT = 'demo-finance';
const FSREST = `http://${FS[0]}:${FS[1]}/v1/projects/${PROJECT}/databases/(default)/documents`;
const CONFIG = { firebase: { apiKey: 'fake-key', authDomain: 'localhost', projectId: PROJECT, appId: 'demo' }, emulator: { auth: AUTH, firestore: FS } };
const NOW = new Date('2026-10-12T15:00:00Z');

async function signUp(email, password) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return r.json();
}
async function listDocs(uid, col, token = 'owner') {
  const docs = []; let pageToken = '';
  for (;;) {
    const r = await fetch(`${FSREST}/users/${uid}/${col}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) return { status: r.status, docs: [] };
    const j = await r.json(); docs.push(...(j.documents || [])); if (!j.nextPageToken) return { status: 200, docs }; pageToken = j.nextPageToken;
  }
}

const { srv, url } = await serve();
const browser = await chromium.launch();
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.clock.setFixedTime(NOW);
  await ctx.addInitScript((cfg) => { window.APP_CONFIG = cfg; }, CONFIG);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(m.text() + (m.location().url || ''))) errors.push(name + ' console: ' + m.text()); });
  return { ctx, page };
}
async function login(page, email, pass) {
  await page.fill('#lEmail', email); await page.fill('#lPass', pass); await page.locator('#lGo').click();
}
const waitReady = (page) => page.waitForFunction(() => document.querySelector('#login').hidden && !/Abrindo seus/.test(document.querySelector('#v-resumo').innerText));

const EMAIL = 'nicolas@example.com', PASS = 'senha-forte-123';
const u1 = await signUp(EMAIL, PASS);
const u2 = await signUp('intruso@example.com', 'outra-senha-456');
check(!!u1.localId && !!u2.localId, 'usuários de teste criados no emulador de Auth');
const { file: planilha, rows: expected } = buildPlanilha();

section('1. Login');
const A = await device('A');
await A.page.goto(url + '/index.html');
await A.page.waitForSelector('#login:not([hidden])');
check(await A.page.locator('#lEmail').isVisible(), 'sem sessão, o app mostra a tela de login');
await login(A.page, EMAIL, 'senha-errada');
await A.page.waitForFunction(() => !document.querySelector('#lErr').hidden);
check(norm(await A.page.locator('#lErr').innerText()) === 'E-mail ou senha incorretos.', 'senha errada: mensagem em português', await A.page.locator('#lErr').innerText());
await A.page.screenshot({ path: path.join(OUT, '11-login-erro.png') });
errors.splice(0, errors.length, ...errors.filter((e) => !/status of 400/.test(e))); // o 400 do Auth é a senha errada que acabamos de testar de propósito
await login(A.page, EMAIL, PASS);
await waitReady(A.page);
check(await A.page.locator('#login').isHidden(), 'login correto abre o app');
check(!/Dados só neste navegador/.test(await A.page.locator('#v-resumo').innerText()), 'sem aviso de "dados só neste navegador" na nuvem');

section('2. Importar no aparelho A grava na nuvem');
await A.page.locator('.tab[data-t="importar"]').click();
await A.page.setInputFiles('#file', planilha);
await A.page.waitForSelector('#hYear');
await A.page.locator('#iGo').click();
await A.page.waitForFunction(() => /Importação concluída/.test(document.querySelector('#impBody').innerText), null, { timeout: 60000 });
const remote = await listDocs(u1.localId, 'tx_2026');
check(remote.docs.length === expected.length, `${expected.length} lançamentos gravados no Firestore`, remote.docs.length);
const f0 = remote.docs[0].fields;
check(f0.amt && f0.desc && f0.ym && f0.status, 'documentos com os campos esperados');

section('3. Outro aparelho entra e vê tudo');
const B = await device('B');
await B.page.goto(url + '/index.html');
await B.page.waitForSelector('#login:not([hidden])');
await login(B.page, EMAIL, PASS);
await B.page.waitForFunction(() => /Set 2026|Out 2026/i.test((document.querySelector('#rMnav .m') || {}).textContent || ''), null, { timeout: 30000 });
await B.page.locator('#rMnav [data-mv="-1"]').click();
await B.page.waitForFunction(() => /1\.791,00/.test(document.querySelector('#v-resumo .big')?.innerText || ''), null, { timeout: 30000 });
check(true, 'aparelho B mostra as despesas de setembro (R$ 1.791,00) sem importar nada');
check(await B.page.locator('.tab[data-t="confirmar"] .badge').innerText() === '1', 'aparelho B mostra 1 lançamento para confirmar');

section('4. Sincronização em tempo real entre aparelhos');
await B.page.locator('.tab[data-t="confirmar"]').click();
const card = B.page.locator('.qcard', { hasText: 'LOJA SEM CATEGORIA' });
await card.locator('select[data-cat]').selectOption('Vestuario');
await card.locator('[data-ok]').click();
await A.page.waitForFunction(() => document.querySelector('#bdg').hidden, null, { timeout: 30000 });
check(true, 'confirmar no B faz o selo "Confirmar" sumir no A, sem recarregar');
const synced = (await listDocs(u1.localId, 'tx_2026')).docs.find((d) => d.fields.desc.stringValue === 'LOJA SEM CATEGORIA');
check(synced && synced.fields.status.stringValue === 'ok' && synced.fields.cat.stringValue === 'Vestuario', 'confirmação gravada na nuvem');

section('5. Segurança: cada usuário só enxerga a própria área');
const own = await listDocs(u1.localId, 'tx_2026', u1.idToken);
const other = await listDocs(u1.localId, 'tx_2026', u2.idToken);
const anon = await fetch(`${FSREST}/users/${u1.localId}/tx_2026`);
check(own.status === 200 && own.docs.length === expected.length, 'dono lê os próprios dados');
check(other.status === 403, 'outro usuário logado é recusado (403)', other.status);
check(anon.status === 403, 'sem login é recusado (403)', anon.status);
const w = await fetch(`${FSREST}/users/${u1.localId}/tx_2026/hack`, { method: 'PATCH', headers: { authorization: 'Bearer ' + u2.idToken, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { x: { stringValue: '1' } } }) });
check(w.status === 403, 'outro usuário não consegue gravar na sua área (403)', w.status);

section('6. Sem sinal: grava no aparelho e envia quando a internet volta');
await A.page.locator('.tab[data-t="gastos"]').click();
await A.ctx.setOffline(true);
await A.page.locator('#addBtn').click();
await A.page.fill('#mV', '88.80'); await A.page.fill('#mN', 'Pix sem sinal');
await A.page.locator('#sheet [data-seg="Nicolas"]').click();
await A.page.locator('#mC').selectOption('Mercado');
const t0 = Date.now();
await A.page.locator('#mSave').click();
await A.page.waitForFunction(() => /Lançamento salvo/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
const took = Date.now() - t0;
check(took < 1500, `sem internet, salva na hora (${took} ms)`, took);
check((await A.page.locator('#gList .tx', { hasText: 'Pix sem sinal' }).count()) === 1, 'lançamento aparece na lista mesmo offline');
check(!(await listDocs(u1.localId, 'tx_2026')).docs.some((d) => d.fields.desc.stringValue === 'Pix sem sinal'), 'ainda não chegou ao servidor (offline)');
await A.ctx.setOffline(false);
let arrived = false;
for (let i = 0; i < 40 && !arrived; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  arrived = (await listDocs(u1.localId, 'tx_2026')).docs.some((d) => d.fields.desc.stringValue === 'Pix sem sinal');
}
check(arrived, 'ao voltar a internet, o lançamento é enviado sozinho ao servidor');

section('7. Sessão e saída');
await A.page.reload();
await waitReady(A.page);
check(await A.page.locator('#login').isHidden(), 'recarregar a página mantém a sessão (não pede login de novo)');
await A.page.locator('.tab[data-t="gastos"]').click();
await A.page.locator('#gList .tx', { hasText: 'Pix sem sinal' }).waitFor({ timeout: 20000 });
check(true, 'depois de recarregar, os dados (inclusive o lançamento feito sem sinal) estão lá');
await A.page.locator('.tab[data-t="ajustes"]').click();
check(/Na nuvem/.test(await A.page.locator('#v-ajustes').innerText()) && (await A.page.locator('#v-ajustes').innerText()).includes(EMAIL), 'Ajustes mostra "Na nuvem" e o e-mail conectado');
await A.page.screenshot({ path: path.join(OUT, '12-ajustes-nuvem.png') });
await A.page.locator('#signOut').click();
await A.page.waitForSelector('#login:not([hidden])');
check(true, 'sair volta para a tela de login');

section('8. Sem erros no console');
check(errors.length === 0, 'nenhum erro de JavaScript nem de console', errors);

await browser.close();
srv.close();
finish();
