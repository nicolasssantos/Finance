# Controle de Finanças

App web para o celular que substitui a planilha de gastos da casa e da Fazenda Mirante do Juá.
Você importa o extrato do cartão (Excel) todo mês, o app classifica o que já conhece, pede confirmação quando tem dúvida e marca em amarelo o que é novo.

As regras de negócio e o histórico do projeto estão em [`docs/briefing.md`](docs/briefing.md).

## Onde ficam os dados

| Modo | Quando | Dados |
|---|---|---|
| **Nuvem** (recomendado) | `config.js` tem o bloco `firebase` | Na sua conta Firebase (Firestore), iguais em todos os aparelhos. Login por e-mail e senha. Sem sinal, o app grava no aparelho e envia quando a internet volta. |
| **Local** (só para testar) | `config.js` sem o bloco `firebase` | Só no navegador deste aparelho. Se limpar o navegador, perde. O app mostra um aviso vermelho/laranja enquanto estiver neste modo. |

Cada usuário só lê e grava a própria área (`users/{uid}/...`), garantido por [`firestore.rules`](firestore.rules).

## Ligar a nuvem (uma vez, ~10 minutos)

1. Em <https://console.firebase.google.com>, **Adicionar projeto** (pode desligar o Google Analytics).
2. **Build > Firestore Database > Criar banco de dados**, modo de produção, região `southamerica-east1` (São Paulo).
3. **Build > Authentication > Vamos começar > E-mail/senha > Ativar**. Na aba **Users**, **Adicionar usuário** com o seu e-mail e uma senha forte. Em **Settings > User actions**, desmarque *Enable create (sign-up)* para ninguém mais criar conta.
4. **Configurações do projeto > Seus apps > Web (`</>`)**, registre o app e copie o objeto `firebaseConfig`.
5. Cole esse objeto em [`config.js`](config.js), no campo `firebase`. Esses valores não são segredo; quem protege os dados são o login e as regras.
6. Publique (precisa de Node.js):
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add          # escolha o projeto
   firebase deploy             # publica o app (Hosting) e as regras de segurança (Firestore)
   ```
   O app fica em `https://SEU-PROJETO.web.app`.
7. No celular, abra o endereço, entre e use **Adicionar à tela inicial**. Abre como app, até sem internet.
8. Primeira carga: **Importar** > escolha a planilha `Financas_2026_v1.xlsm`. O app reconhece o formato e traz Janeiro a Setembro.

Cotas gratuitas do plano Spark (50 mil leituras e 20 mil gravações por dia no Firestore) são folgadas para este uso: cada abertura lê os lançamentos dos últimos 3 anos, cerca de mil por ano.

## Publicação

O app está publicado no Netlify, em <https://casa-fazenda-saude-financeira.netlify.app> (só os arquivos do app; testes e documentação não vão para o ar).

- **Atualizar:** peça ao Claude para republicar, ou conecte este repositório ao Netlify (Project configuration > Build & deploy > Link repository) para publicar a cada push.
- **Conferir o que está no ar:** `npm run smoke -- https://casa-fazenda-saude-financeira.netlify.app` abre o site num navegador, tenta um login com senha errada e confere a mensagem e os erros de console.
- **Selo do Netlify:** o Netlify injeta um selo flutuante no canto inferior direito. O app reserva espaço para ele não cobrir as abas (hospedagem sem selo, como o Firebase Hosting, não muda nada).

## Uso mensal

1. **Importar**: escolha o extrato do cartão (`.xlsx`, `.xls`, `.csv` ou **`.pdf`**). O app detecta as colunas (Data, Descrição, Valor, Titular) e lembra a escolha para o mês seguinte.
   - **PDF:** o app lê PDFs com texto (não escaneados) em que cada compra tem data, descrição e valor na mesma linha, em qualquer ordem de colunas: `20/09`, `20/09/2026` ou `15 SET`; valores como `1.234,56`, `R$ 25,00`, `-25,00`, `25,00-` ou `25,00 CR` (crédito). Reconhece seções por cartão (`NOME - 56266`), o total da fatura (para conferir a soma), descrições que quebram em várias linhas e PDFs com várias páginas ou protegidos por senha (a senha fica só no aparelho). PDF escaneado (imagem) não tem texto para ler: use o Excel ou o CSV. O leitor (pdf.js, da Mozilla) só é carregado quando você escolhe um PDF.
   - **Mês do extrato:** ao escolher o arquivo, o app pergunta **"Para qual mês é este extrato?"**. Ele sugere o mês pela última compra do arquivo e oferece o mês anterior e o seguinte (ou qualquer outro, ou "usar o mês de cada compra"). O botão de importar só libera depois da sua resposta. O mês escolhido define para onde os lançamentos vão; o ano das datas vem do próprio arquivo.
   - **Fatura do Bradesco** (`.xls` do Internet Banking, com os 3 cartões no mesmo arquivo): o app lê uma seção por cartão, usa a coluna em R$, ignora o saldo anterior e o pagamento da fatura anterior, mantém estornos como crédito e dá o ano certo às parcelas antigas (o banco imprime só dia/mês). A prévia mostra se a soma lida confere com o "Total da fatura" do arquivo.
   - **Ordem:** pode importar a planilha e o extrato em qualquer ordem. O gasto que já existe não é duplicado: o extrato preenche o cartão, e a planilha preenche a classificação que você já fez. O mais prático é importar a planilha primeiro, para o app já conhecer os seus lugares.
2. **Confirmar**: o que o app não tem certeza aparece aqui. Laranja = sugestão para confirmar, amarelo = lugar novo. Depois de 2 confirmações iguais ele passa a classificar sozinho.
3. **Resumo** e **Gastos**: para onde o dinheiro está indo, por casa x fazenda, responsável, categoria e mês. Cada gasto mostra de qual cartão saiu (Nicolas, Ana Paula ou Eduardo).
   - No **Resumo**, a chave **Mês | Ano** troca para o **histórico do ano**: escolha o ano (2026 em diante) e veja janeiro a dezembro num gráfico e numa tabela, com total, média mensal e saldo. Toque em um mês para abri-lo.
4. **Ajustes > Backup**: baixe um backup JSON de vez em quando (restaura tudo, inclusive aprendizado). O Excel é só para consulta.

## Estrutura

```
index.html          o app (HTML, CSS e JS)
backend.js          armazenamento: Firebase (nuvem) ou IndexedDB (local)
config.js           onde você cola a configuração do Firebase
sw.js, manifest…    instalar na tela inicial e abrir sem internet
firestore.rules     regras: cada usuário só acessa a própria área
firebase.json       hospedagem e emuladores
vendor/             SheetJS, Firebase SDK e pdf.js (leitor de PDF), versionados no repositório
tests/              testes de ponta a ponta no navegador
docs/briefing.md    regras de negócio e histórico
```

## Testes

```bash
npm install
npm test              # modo local, Chromium com viewport de celular (61 verificações)
npm run test:cloud    # contra o emulador do Firebase (precisa de Java; 24 verificações)
```

`npm test` importa uma planilha e extratos sintéticos e confere totais, deduplicação, classificação, aprendizado, backup/restauração, modo escuro e abertura sem internet. Capturas de tela ficam em `tests/out/`.
`npm run test:cloud` confere login, sincronização entre dois aparelhos, as regras de segurança (outro usuário e visitante recebem 403) e gravação sem sinal.

Para rodar o app localmente: `npm run serve` e abra <http://localhost:5173>.
