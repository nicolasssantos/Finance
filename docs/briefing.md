# Briefing: Controle de Finanças (Fazenda Mirante do Juá)

Cole este texto na nova sessão do Claude Code e anexe `controle-financas.html`.

## Objetivo
Substituir minha planilha Excel de controle de gastos (cartões, casa e fazenda) por um app web que eu use no celular, com o mínimo de trabalho manual.

- Atualizável pelo celular.
- Automático: eu importo o extrato do cartão em Excel (.xlsx) todo mês e o app classifica.
- Visão de para onde o dinheiro está indo (casa x fazenda, por responsável, por categoria, evolução mensal).
- Aprende com os meses anteriores: classifica sozinho o que já conhece, pede confirmação quando tem dúvida e marca despesa nova em amarelo.

## Regras de negócio
- Cartão **Eduardo Silveira** = fazenda. Cartões **Nicolas Santos** e **Ana Paula** = casa.
- Segue a estrutura da minha planilha `Financas_2026_v1.xlsm`: Responsável, Despesas (categoria), Método e Receita.
- Responsáveis: Nicolas, Ana Paula, Nicolas & Ana Paula, Leite, Investimento Leite, Granja, Investimento Granja, Peixe (tilápia), Investimento Peixe, Combustível, Outros.
- Segmentos da fazenda: Leite, Tilápia, Granja, Fazenda geral e Investimento Fazenda.
- Categorias: as 49 que já existem na planilha.

## Como o aprendizado funciona (já implementado)
- A chave de cada lançamento é o nome do estabelecimento normalizado (sem acento, sem parcela, sem dígitos, sem prefixos PAG/MP/PP/PG/EC; primeiros 3 termos).
- Só contam lançamentos confirmados por mim.
- Classifica automaticamente com 2 ou mais ocorrências e 85% ou mais de consenso de categoria (e de responsável, no caso da fazenda).
- Em cartão de casa, o responsável padrão é o titular do cartão.
- Caso contrário: laranja = confirmar (com sugestão), amarelo = novo.
- Deduplicação por data + valor + estabelecimento + tipo, então reimportar não duplica.

## Estado atual
- `controle-financas.html` é um arquivo único (HTML, CSS e JS), com 5 abas: Resumo, Confirmar, Gastos, Importar, Ajustes.
- Usa as capacidades de artifact `db` (coleções `tx_AAAA` e documento `config/main`), `user` e `downloads` (backup em xlsx). Biblioteca SheetJS 0.18.5 via cdnjs.
- **Testado com minha planilha real** (lógica em Node): totais mensais conferem com a planilha, 1.059 lançamentos de Jan a Set sem duplicados, 302 estabelecimentos aprendidos, reimportação gera 0 lançamentos novos.
- **Nunca foi aberto em navegador de verdade.** Só existem testes de sintaxe e de lógica.
- **Nunca foi testado com um extrato real de cartão.** A importação de extrato é genérica (mapeamento de colunas, titulares, competência por fatura ou por compra).
- Não foi publicado: recusei a publicação duas vezes e ainda preciso decidir onde hospedar.
- Os primeiros meses da planilha têm classificações ruins (ex.: "LOUCOS POR SALGADOS" como Combustível), o que contamina o aprendizado.

## Próximos passos
1. Abrir o app em um navegador, conferir layout no celular (modo claro e escuro) e corrigir o que aparecer.
2. Testar a importação com um extrato real do cartão (vou anexar um).
3. Decidir onde hospedar e guardar os dados (artifact com `db` ou outra opção).
4. Limpar ou revisar as classificações antigas que prejudicam o aprendizado.

## Preferências
- Português, resposta direta e orientada a execução.
- Decisões guiadas por dados.
