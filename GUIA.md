# Assistente IA para Zotero: guia rápido

Ajuda a **ler, avaliar e comparar artigos científicos** no Zotero, com a **tua própria conta de IA**, gratuita ou paga. Todas as respostas citam a página do PDF e cada citação abre o PDF nessa página. A descrição completa, em inglês, está no [README](README.md).

## Instalar

1. Descarrega o `.xpi` mais recente em [Releases](https://github.com/serbernardo/zotero-assistente-ia/releases/latest).
2. No Zotero: **Ferramentas → Plugins** e arrasta o ficheiro para a janela (ou roda dentada → **Install Plugin From File…**).
3. Precisa do **Zotero 8 ou superior**. O plugin atualiza-se sozinho.

## Ligar uma IA

Nas definições do plugin (botão de definições no topo do painel) escolhe uma e segue os passos, que têm ligações oficiais e um botão **Testar**:

| Serviço | Custo | O que precisas |
|---|---|---|
| **IAEdu** | Gratuito no ensino superior português | A tua chave pessoal do IAEdu |
| **Gemini** (Google) | Tem plano gratuito | Uma chave gratuita do Google AI Studio |
| **ChatGPT** (conta) | Conta gratuita ou paga | A ferramenta Codex da OpenAI, com sessão iniciada |
| **ChatGPT** (API) | Pago por utilização | Uma chave da API da OpenAI |

## Usar

- **Painel lateral:** abre-se no registo de um artigo. O modo **Simples** tem botões grandes (Resumir, Explicação simples, Conceitos-chave, Mapa mental, Testar o que percebi, Relevância para o meu tema). O modo **Avançado** tem todas as ações, em separadores, e permite fazer qualquer pergunta sobre o artigo.
- **Vários artigos:** a faixa "Vários artigos" no topo do painel abre a janela do assistente, onde juntas artigos de qualquer pasta com **+ Artigos**. Podes comparar, perguntar a todos, criar um mapa de temas, uma revisão de literatura ou fazer uma triagem.
- **Coleções grandes (mais de 12 artigos):** as tabelas fazem-se por lotes de 10 e juntam-se numa tabela só, com a síntese escrita no fim a partir dela. A revisão de literatura escreve-se tema a tema. As tabelas longas têm pesquisa e filtros, e exportam para o Excel (CSV). Um artigo com o PDF ilegível fica de fora e avisado, sem parar os outros.
- **Triagem e PRISMA 2020:** cada artigo excluído fica com o critério que falhou. O resumo traz o diagrama PRISMA 2020: escreves os números das bases de dados (identificados, duplicados, excluídos no título e resumo) e o resto é calculado e confirmado. Exporta para o Excel e traz uma frase sobre o uso da IA para a secção de métodos. Em **As minhas colunas**, um botão escreve as colunas da folha de dados PRISMA.
- **Clique direito** em artigos selecionados: Assistente IA → Abrir na janela, Perguntar a estes artigos, Mapa de temas ou comparar.
- **Notas e citações:** cada resposta pode guardar-se como nota do Zotero e as citações seguem o estilo APA ou o estilo de citação do teu Zotero.

## Verificação e privacidade

- O assistente só usa o texto dos teus PDFs e **verifica cada resposta** contra eles: excertos, páginas, números e contas.
- Para responder, o texto dos PDFs escolhidos é enviado ao serviço de IA que escolheste. Não há nenhum servidor deste projeto pelo meio e as conversas ficam só no teu computador.

## Licença

AGPL-3.0, ver [LICENSE](LICENSE). Autor: Sérgio Bernardo.
