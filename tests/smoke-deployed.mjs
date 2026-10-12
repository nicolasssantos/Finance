/* Teste de fumaça do site publicado: npm run smoke -- https://seu-site
   Abre o site com tela de celular, confere que o login aparece em modo nuvem e tenta entrar com uma conta que não existe
   (não usa a sua senha) para exercitar o Auth real do projeto. Não lê nem grava nenhum dado. */
import { chromium } from 'playwright';
import path from 'node:path';
import { OUT } from './helpers.mjs';

const url = process.argv[2];
if (!url) { console.error('Uso: npm run smoke -- https://endereco-do-site'); process.exit(2); }
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errs.push('console: ' + m.text().slice(0, 200)); });
let ok = true; const check = (c, msg, x) => { if (!c) ok = false; console.log((c ? '  ok   ' : '  FAIL ') + msg + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('#login:not([hidden])', { timeout: 30000 });
check(await page.evaluate(() => Backend.mode) === 'cloud', 'modo nuvem (config.js com o bloco firebase)');
check(await page.locator('#lEmail').isVisible(), 'tela de login visível');
await page.fill('#lEmail', 'sonda-inexistente@example.invalid');
await page.fill('#lPass', 'senha-que-nao-existe');
await page.locator('#lGo').click();
await page.waitForFunction(() => !document.querySelector('#lErr').hidden, null, { timeout: 30000 });
check((await page.locator('#lErr').innerText()).trim() === 'E-mail ou senha incorretos.', 'Auth real respondeu e o app mostrou a mensagem em português');
const g = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight - innerHeight, tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom), badge: (document.getElementById('nl-badge-frame') || { getBoundingClientRect: () => ({ top: innerHeight }) }).getBoundingClientRect().top }));
check(g.scroll <= 0, 'a página cabe na tela', g);
check(g.tabsBottom <= g.badge, 'a barra de abas não fica sob o selo do hospedeiro', g);
check(errs.length === 0, 'sem erros de JavaScript nem de console', errs);
await page.screenshot({ path: path.join(OUT, 'smoke-login.png') });
await browser.close();
console.log(ok ? '\nSite publicado OK' : '\nFALHOU');
process.exit(ok ? 0 : 1);
