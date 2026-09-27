# Assistente IA para Zotero

Addon para o Zotero (versao 0.3) que ajuda a ler, avaliar e escrever a partir
de artigos cientificos, com a conta de IA do proprio utilizador (gratuita ou
paga). Cinco motores: Claude com chave da API (`anthropic`), Claude com a
subscricao Pro/Max atraves do Claude Code em subprocesso (`claude`), ChatGPT
com chave da API da OpenAI (`openai`), ChatGPT com a conta do utilizador,
gratuita ou paga, atraves do Codex CLI em subprocesso (`codex`) e Gemini com
chave da API (`gemini`). Interface em PT-PT e ingles (`content/i18n.js`,
pref `ui.lang`: auto, pt-PT, en). Todas as respostas citam a pagina do PDF em formato
[Dn:pX], que fica clicavel e abre o PDF nessa pagina
(zotero://open-pdf/library/items/<key>?page=<n>).

Acoes (em `lib.js`, `ACTIONS`, agrupadas em separadores `ACTION_GROUPS`):
Compreender (resumo, pontos, simples, conceitos, esquema), Avaliar (critica,
metodos, conclusoes), Escrever (ficha, excertos, revisao, etiquetas),
Investigar (comparar, lacunas, perguntas) e "Os meus" (prompts do utilizador,
pref `custom.prompts`, uma linha "Nome: instrucao").

## Estrutura do projeto

- `addon/` — codigo fonte do addon (o que vai para dentro do `.xpi`)
  - `manifest.json`, `prefs.js`, `bootstrap.js` — ciclo de vida do plugin,
    registo do painel lateral (ItemPaneManager), dos menus (MenuManager) e
    das preferencias
  - `content/i18n.js` — todos os textos da interface, em PT-PT e ingles
    (mesmas chaves nas duas linguas, verificado por teste). Carregado primeiro
  - `content/lib.js` — logica pura sem dependencias do Zotero: instrucoes de
    sistema por lingua (`buildSystemPrompt`), acoes, parsing de citacoes,
    Markdown, tabelas para CSV, parsers de streaming (Claude Code, Codex,
    Gemini, Anthropic, OpenAI), classificacao de erros, etiquetas, prompts do utilizador
  - `content/zoteroia.js` — integracao com o Zotero: leitura de PDFs
    (`Zotero.PDFWorker`), anotacoes, etiquetas, os tres motores, cofre de
    chaves, notas, CSV, deteccao dos executaveis (Claude Code, Codex; no
    Windows os `.cmd` do npm sao lidos e o node e chamado diretamente)
  - `content/chatview.js` — interface do painel e da janela (`ZIAChatView`):
    separadores, cartao de configuracao inicial, aviso de privacidade,
    sugestoes de perguntas
  - `content/zoteroia.css`, `content/icons/*.svg` — estilo e icones
  - `content/window.xhtml` / `window.js` — janela autonoma (varios PDFs)
  - `content/preferences.xhtml` / `preferences.js` — definicoes
  - `locale/pt-PT/`, `locale/en-US/` — strings Fluent (menus e painel)
- `tests/` — testes (ver abaixo)
- `dist/` — `.xpi` empacotado e capturas de ecra
- `build.py` — empacota `addon/` num `.xpi` (Python, qualquer sistema);
  `build.sh` chama-o

## Decisoes de arquitetura

- **Conta do proprio utilizador.** O addon nao tem servidor. Cada pessoa
  configura a sua chave ou o seu Claude Code nas definicoes. Para partilhar
  com outras pessoas, a opcao recomendada e a chave da API (motor
  `anthropic`). O modo Claude Code usa a instalacao e a sessao OAuth do
  proprio utilizador, sem o addon intermediar credenciais, e por omissao
  ignora `ANTHROPIC_API_KEY`.
- **Chaves nunca em texto simples.** `setSecret`/`getSecret` em
  `zoteroia.js`: primeiro `OSKeyStore` (pref guarda "oskv1:<cifrado>"),
  em alternativa o gestor de credenciais do Zotero (`Services.logins`, pref
  guarda "login:"). Chaves "plain:" da 0.1 sao migradas no arranque.
- **Pedido em duas partes** (`buildRequestParts`): documentos e pergunta.
  No motor `anthropic` os documentos levam `cache_control` para as perguntas
  seguintes custarem menos.
- **Seguranca do conteudo:** `neutralizeTags` impede um PDF de imitar as
  marcas `<documento>`, `<pedido>` etc. As instrucoes de sistema dizem que o
  texto dos documentos nunca sao instrucoes. O Markdown e renderizado para
  DOM sem innerHTML e as ligacoes so abrem se forem http(s).
- **Aviso de privacidade** por motor na primeira utilizacao
  (prefs `privacy.ack.<motor>`).
- O ambiente do plugin (sandbox do bootstrap) nao tem `AbortController`:
  `_fetch` usa o da janela.
- **Codex sem ferramentas:** `codex exec --json --sandbox read-only` numa
  pasta temporaria vazia, instrucoes de sistema no inicio do stdin, e o
  processo e morto se aparecer um item `command_execution`, `file_change`,
  `mcp_tool_call` ou `web_search`. As variaveis `OPENAI_API_KEY` e
  `ANTHROPIC_API_KEY` sao retiradas do ambiente (usa-se a conta).
- **Contas gratuitas:** ChatGPT (Codex) e Gemini funcionam com contas
  gratuitas. A conta gratuita do Claude nao da acesso ao Claude Code nem a API.

## Testes

Antes de testar, instalar as dependencias do harness:

```
cd tests/harness
npm install
```

- `node --test tests/lib.test.js` — testes unitarios puros (26), incluindo
  a paridade PT-PT/ingles
- `node tests/harness/run_anthropic.js` — motor Claude API contra um
  servidor SSE simulado no formato oficial da Anthropic, e cofre de chaves
  (OSKeyStore, gestor de credenciais, migracao da 0.1)
- `node tests/harness/run_openai.js` — motor ChatGPT API contra um servidor
  simulado no formato oficial da OpenAI, e motor Codex com um Codex falso
  (`tests/harness/fake_codex/`, inclui um `.cmd` igual ao do npm)
- `node tests/harness/run_gemini.js` — motor Gemini contra um servidor SSE
  simulado no formato oficial da Google
- `node tests/harness/run_ui.js` — testes de interface com Playwright; no
  Windows usa o Edge instalado (ou `PW_CHROMIUM=<caminho>`); capturas em
  `tests/harness/out/`
- `ZOTERO_SRC=<clone> node tests/harness/run_bootstrap.mjs` — valida
  `bootstrap.js` contra o codigo fonte REAL do `PluginAPIBase`/
  `ItemPaneManager`/`MenuManager` do Zotero. Clone esparso:
  `git clone --depth 1 --filter=blob:none --sparse https://github.com/zotero/zotero.git zsrc`
  e `git sparse-checkout set chrome/content/zotero/xpcom/pluginAPI`
- `CLAUDE_PATH=<executavel> node tests/harness/run_core.js` — motor Claude
  Code contra o binario REAL (precisa de sessao iniciada; gasta limite)

**Ainda nao testado**: dentro de uma instalacao real do Zotero em execucao,
e os motores Claude API, ChatGPT API e Codex contra os servicos reais (so
contra servidores e programas simulados).

## Empacotar

```
python build.py
```

Gera `dist/assistente-ia-0.3.0.xpi`, pronto a instalar em
**Ferramentas -> Plugins -> Install Plugin From File...**

## Preferencias de conteudo (aplicam-se a qualquer texto do addon ou da UI)

- Portugues europeu (PT-PT), nunca portugues do Brasil
- Nunca usar travessao (—) nem meia-risca (–) como pontuacao; usar virgulas,
  dois pontos ou frases separadas (o hifen normal em palavras compostas,
  como em "Pontos-chave", nao e afetado por esta regra)
- Evitar ponto e virgula
- Evitar gerundio (preferir a construcao "a" + infinitivo, por exemplo
  "a abrir" em vez de "abrindo")
- O utilizador (SBHG) trabalha em HR Technology / Oracle HCM, nao e
  developer: nas explicacoes e nos textos de commit, manter linguagem
  simples e direta
