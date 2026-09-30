# Assistente IA para Zotero

Addon para o Zotero (versao 0.4) que ajuda a ler, avaliar e escrever a partir
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
- **Gemini sobrecarregado (erros 500 a 504):** `runGemini` repete o pedido tres
  vezes (3 s, 8 s e 15 s) e depois tenta ate tres modelos flash estaveis da conta,
  primeiro os "lite" (`geminiFallbacks` em `lib.js`). Um alternativo sem quota
  passa ao seguinte. So se ainda nada foi mostrado ao utilizador. Cada espera e
  anunciada na conversa (`onInfo({ notice })`) e a resposta diz que modelo usou.
- **Definições:** uma secção principal com um cartão por motor (estado:
  Pronto, Falta testar, Não funciona, Por configurar), só o motor escolhido
  mostra a sua configuração e o botão Testar faz um pedido real curto
  (`testEngine`). O estado vem das prefs `<motor>.lastTest`, atualizadas
  também pelos pedidos reais na conversa. O Claude Code tambem e procurado na
  pasta da aplicacao Claude para computador.
- **Instalar e iniciar sessao no Claude Code** (`openClaudeSetup`): depois de
  uma confirmacao, escreve um script na pasta temporaria e abre-o numa janela
  visivel (Windows: `cmd /c start` com um `.cmd`, Mac: Terminal com um
  `.command`). O script usa so o comando oficial fixo
  (`CLAUDE_INSTALL_WIN`/`CLAUDE_INSTALL_UNIX`), instala se faltar e corre
  `claude` para a pessoa entrar na conta. Caminhos com caracteres perigosos
  sao recusados. No Linux mostra-se so o comando para copiar.
- **Painel lateral em destaque:** o CSS carregado na janela principal usa
  `collapsible-section[data-pane$="zoteroia-section"]` (o Zotero junta o id
  do plugin ao paneID) para o fundo cinza, a barra azul e o titulo azul.
  O painel usa `contain: inline-size` e a barra de cima pode passar a duas
  linhas: o conteudo nunca obriga o painel do Zotero a alargar (teste
  "painel estreito" em `run_ui.js`).
- **Ordem dos motores:** `ENGINE_ORDER` = gemini, claude, codex, anthropic,
  openai. A lista do painel mostra sempre `MAIN_ENGINES` (gemini, claude, codex)
  e as chaves de API so quando configuradas ou escolhidas. Nas definicoes, os
  separadores seguem a mesma ordem (Gemini, Claude Pro/Max, ChatGPT conta,
  Outros), "Outros" junta o Claude API e o ChatGPT API, e "Usar este motor" e
  um botao a parte. Gemini por omissao: `GEMINI_DEFAULT` = gemini-3.5-flash-lite
  (migracao unica com a pref `gemini.defaultApplied`).
- **Gemini sem quota (429):** a quota gratuita conta por modelo. `parseGeminiQuota`
  le o modelo, o limite e se e por dia ou por minuto. Por minuto com espera curta:
  espera e repete. Por dia: passa logo aos alternativos e guarda em
  `_geminiSwap` o modelo que respondeu, para o resto do dia. Modelo inexistente
  (404) tambem passa aos alternativos. Os detalhes da Google ficam em `e.detail`
  e aparecem num bloco "Detalhes tecnicos".
- **Notas:** `saveNote` define sempre `libraryID` antes de `parentID` (o Zotero
  le a biblioteca ao consultar o item-pai; sem isso da "Library ID not
  provided"). O `mockzotero.js` imita esta regra. Todas as respostas, mesmo
  recolhidas, tem "Guardar como nota".
- **Painel:** caixa de texto por cima das respostas e a resposta mais recente
  logo abaixo dela. Separador "Personalizado" (grupo `meus`) com formulario
  para criar, editar e apagar acoes (`setCustomPrompt`/`removeCustomPrompt`,
  ids estaveis `custom:<nome>`). Botao "+ PDF" abre um seletor com os artigos
  da lista central do Zotero (`pickableItems`, `getSortedItems`), com pesquisa.
  Uma acao que precisa de mais PDFs (Comparar) abre o seletor.
- **Acoes em dois passos:** clicar numa acao so a escolhe (`selectAction`); o
  pedido segue com "Pedir" ou Enter, com indicacoes opcionais. Respostas
  anteriores ficam recolhidas (`collapsed`), acoes ja pedidas levam um visto e
  escolher uma acao ja feita mostra a resposta existente.
- **Historico por artigo:** `saveConversation`/`loadConversation` guardam as
  mensagens (sem o texto dos PDFs) em
  `<pasta de dados do Zotero>/zoteroia/conversas/<biblioteca>_<chave>.json`.
  Pref `history.save` (ligada por omissao), botao para apagar nas definicoes.
- **Modelos Claude:** API com `claude-sonnet-5-5` por omissao e esforco
  `medium` (`output_config.effort`) nos modelos Sonnet/Opus 5. Claude Code
  com o nome curto `sonnet`, que aponta sempre para o mais recente.
- **Atualizacoes:** `update_url` do manifest aponta para
  `releases/latest/download/updates.json` do GitHub. `build.py` gera o
  `updates.json` com o sha256 do `.xpi`. A acao
  `.github/workflows/release.yml` publica a release quando se cria a etiqueta
  `v<versao>`. So funciona com o repositorio publico. Botao "Procurar
  atualizacoes agora" (`checkForUpdates`, AddonManager).
- **Contas gratuitas:** ChatGPT (Codex) e Gemini funcionam com contas
  gratuitas. A conta gratuita do Claude nao da acesso ao Claude Code nem a API.

## Testes

Antes de testar, instalar as dependencias do harness:

```
cd tests/harness
npm install
```

- `node --test tests/lib.test.js` — testes unitarios puros (27), incluindo
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

Gera `dist/assistente-ia-0.4.1.xpi` e `dist/updates.json`. O `.xpi` fica pronto a instalar em
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
