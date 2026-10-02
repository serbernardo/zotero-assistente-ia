# Assistente IA para Zotero

Addon para o Zotero (versao 0.7) que ajuda a ler, avaliar e escrever a partir
de artigos cientificos, com a conta de IA do proprio utilizador (gratuita ou
paga). Cinco motores: Claude com chave da API (`anthropic`), Claude com a
subscricao Pro/Max atraves do Claude Code em subprocesso (`claude`), ChatGPT
com chave da API da OpenAI (`openai`), ChatGPT com a conta do utilizador,
gratuita ou paga, atraves do Codex CLI em subprocesso (`codex`) e Gemini com
chave da API (`gemini`). Interface em PT-PT e ingles (`content/i18n.js`,
pref `ui.lang`: auto, pt-PT, en). As respostas da IA saem sempre na lingua da app
(`buildSystemPrompt("ui")`, ja nao ha opcao propria). Botao PT/EN no titulo do
painel (sectionButton `zoteroia-lang`, `toggleLanguage`, `showLang` troca o icone
`lang-pt16.svg`/`lang-en16.svg`). Todas as respostas citam a pagina do PDF em formato
[Dn:pX], que fica clicavel e abre o PDF nessa pagina
(zotero://open-pdf/library/items/<key>?page=<n>).

Acoes (em `lib.js`, `ACTIONS`, agrupadas em separadores `ACTION_GROUPS`):
Compreender (resumo, pontos, simples, conceitos, esquema: resumo e esquema adaptam-se
a teses, revisoes e textos teoricos, o esquema passa a indice de temas com paginas),
Avaliar (critica: tipo de estudo e grelha CONSORT/STROBE/PRISMA/COREQ/CASP/JBI e
"Apreciacao global" marcada como opiniao da IA, sem GRADE; metodos; afirmacoes e
evidencia: acao `conclusoes`, o id fica por causa do historico, tabela Afirmacao |
Tipo | Suporte no texto | Avaliacao e [Pouco claro] nas ambiguas), Escrever (ficha, excertos, revisao, palavras-chave: acao `etiquetas`, extrai as
palavras-chave do autor e os termos principais e adiciona-as como etiquetas do Zotero),
Investigar (lacunas, perguntas), Comparar (visao geral com pontos fortes e fracos,
metodos, resultados, conceitos, sintese, triagem; so na janela grande, no painel o separador "Comparar ↗"
abre a janela com os PDFs da conversa) e
Personalizado (prompts do utilizador,
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
- **Fidelidade (o mais importante):** `buildSystemPrompt` comeca pela regra
  "FIDELIDADE AOS DOCUMENTOS": so a informacao escrita nos documentos, sem
  conhecimento geral nem suposicoes. [Inferencia] so para ligacoes diretas entre
  factos citados. Contas so se forem exatas e escritas por inteiro
  (100% - 47% = 53%). Texto entre aspas e copia exata do PDF.
- **Verificacao automatica** (`verifyAnswer` em `lib.js`): cada resposta e
  confirmada contra o texto dos PDFs. Excertos entre aspas seguidos de citacao
  (literal, com palavras alteradas, noutra pagina ou inexistente), paginas
  citadas que nao existem, numeros (decimais e percentagens) que nao estao nos
  PDFs e contas (`findCalculations`, so valem se o resultado estiver certo). O
  resultado (`msg.check`) aparece por baixo da resposta e fica no historico.
- **Historico enviado a IA:** as acoes nao levam historico (sao pedidos
  completos). As perguntas livres levam so as ultimas 3 trocas, ate 24 mil
  caracteres (`selectHistory`).
- **Gemini, tarefas exigentes** (`isHeavyTask`: Avaliar, Comparar, Investigar,
  revisao e perguntas com 2 ou mais PDFs): `runGeminiHeavy` tenta primeiro o
  modelo de analise (pref `gemini.modelStrong`: auto = os dois flash estaveis
  mais recentes, off, ou um nome), uma vez e sem esperas. Se falhar, passa logo
  ao modelo principal e evita o de analise durante 15 minutos (ou ate ao fim do
  dia, se for quota diaria). A lista de modelos fica em cache 1 hora
  (`geminiModels`). Botao "Testar modelos agora" (`probeGeminiModels`) testa
  varios modelos em paralelo. As comparacoes (grupo `comparar`) passam `noLite`:
  nunca usam modelos "lite" (nem na troca, nem nos alternativos). Sem modelo
  completo disponivel, erro claro `err.geminiNoFull`.
- **Janela:** "+ Colecao" abre uma lista de todas as colecoes (`listCollections`,
  `collectionItems`), sem ter de selecionar antes no Zotero. A janela carrega o
  `zoteroia.css` pelo rootURI com `?v=<versao>` (o chrome:// ficava em cache
  depois de atualizar e as cores nao batiam com o painel).
- **Icone a seguir a Info:** `placeAfterInfo` no `bootstrap.js` poe o paneID
  logo depois de "info" na pref do Zotero `sidenav.order`, uma so vez (pref
  `sidenav.placed`), para respeitar se a pessoa mudar a ordem depois.
- **Acoes proprias:** ao escolher uma acao do Personalizado aparece "Editar" ao
  lado do pedido. O formulario tem Guardar, Cancelar e Eliminar (`_deleteCustom`).
- **Colecao indicada:** depois de juntar uma colecao aparece a etiqueta
  "Colecao: X" antes dos artigos e uma mensagem com quantos foram juntados.
- **Botoes principais iguais** (Enviar, Pedir, Guardar, Juntar): tinta cheia,
  texto branco, mesmo tamanho. O Enviar nunca fica cinzento: se faltar algo, o
  clique explica o que falta.
- **Mesmo autor e ano:** `disambiguateRefs` (lib.js) acrescenta a, b, c ao ano
  (Silva et al., 2021a e 2021b) nos chips, citacoes e notas. O id Dn continua unico
  internamente, mas nunca aparece a quem le: `replaceDocIds` (lib.js) troca "D1" pelo
  autor e ano, retira "(D1, D2)" e "documento D1" no texto, titulos e notas.
- **Citacoes ao estilo APA de cada lingua:** dois autores com "e" em PT e "&" em ingles
  (`ref.and`); varias fontes no mesmo parentesis separadas por ";" e varias paginas do
  mesmo documento juntas (`joinCites`): (Silva et al., 2021, pp. 1, 5; Costa, 2019, p. 3).
  As ligacoes clicaveis continuam uma por pagina.
- **Estilo de citacao do Zotero** (pref `cite.style`, "" = formato simples):
  `formatCitesWithStyle` (zoteroia.js) usa o motor de citacoes do proprio Zotero
  (`Zotero.Styles.get(id).getCiteProc`) com os dados do item (autores e ano do
  Zotero, nunca da IA). Regista primeiro uma citacao escondida com todos os
  artigos da conversa (so assim o citeproc distingue 2021a e 2021b) e depois
  formata a citacao pedida num so parentesis, com paginas (`locator`, label
  `page`). Usado ao copiar e nas notas (`lib.setCiteFormatter`); no ecra os botoes
  das citacoes ficam curtos. Sem item-pai, estilo inexistente ou erro: formato
  simples. O APA oficial usa "&" no parentesis tambem em portugues.
  As letras do formato simples (`disambiguateRefs`) seguem a ordem alfabetica do
  titulo, como o APA.
- **Fichas no separador Escrever:** botao "i" ao lado de "Ficha" com a explicacao e
  os 14 campos (com financiamento e conflitos de interesse) (`_fichaInfoEl`, campos em `ficha.info.fields`). Lista "Fichas:" com
  os artigos da conversa (`_fichasListEl`): as que existem abrem a nota do Zotero,
  as que faltam criam-se com um clique e ficam logo guardadas como nota
  (`_createFicha`). As fichas so existem como notas do Zotero (uma so copia).
- **Eliminar respostas:** todas as respostas tem um x no
  titulo. Antes de eliminar aparece um aviso (`_confirmDelEl`): se a resposta ainda
  nao esta guardada como nota, oferece "Guardar como nota e eliminar". Retira a
  resposta e a pergunta da conversa e do historico (`_removeMessage`); a nota ja
  guardada no Zotero nao e apagada.
- **Colecoes:** a barra lateral e para um artigo. As colecoes analisam-se na
  janela: botao "Comparar colecao" no rodape do painel (`openCollectionWindow`,
  abre a janela com `pickCollection`) e clique direito numa colecao
  ("Assistente IA: analisar esta colecao", menu `main/library/collection`).
- **Icone sempre visivel:** `onItemChange` faz `setEnabled(!!item)`. Num registo
  sem PDF o painel mostra o cartao "Este registo nao tem PDF" com "+ PDF" e
  "Comparar uma colecao".
- **Creditos com versao e data:** `build.py` grava `content/buildinfo.json` (data
  de empacotamento) dentro do `.xpi`; `showBuildInfo` mostra versao e data.
- **Comparar so na janela:** no painel o separador Comparar e um atalho
  (`openInWindow({ group: "comparar" })`) e o painel nunca salta para Comparar.
  O menu do clique direito nos itens tem so as 5 comparacoes (precisam de 2 ou
  mais PDFs) e abre a janela ja no separador Comparar. A janela mostra so as
  acoes de Comparar (sem a fila de separadores, `.zia-tabs[hidden]`): as outras
  acoes estao no painel.
- **Painel sem deslocacao interna:** as respostas no painel nao tem altura maxima
  (o painel do Zotero ja desliza); evita texto cortado.
- **Titulos das notas de comparacao:** "Comparacao: <tipo> · <artigos>" (PT) e
  "Comparison: <type> · <articles>" (EN), com ate 3 artigos e "e mais N" / "and N more"
  (`_heading`). No menu do clique direito os mesmos tipos aparecem como verbo:
  "Comparar: metodos" / "Compare: methods".
- **Nunca fixado:** o Zotero fixa a seccao cujo icone se carregou; o `onItemChange`
  desfaz isso para o assistente, para cada registo abrir na Info.
- **Painel = um artigo:** no painel nao ha "+ PDF" nem "D1" nos chips. Varios PDFs
  so na janela (com "+ PDF" e "+ Colecao" na barra de cima). O cartao "sem PDF" tem
  "Abrir a janela do assistente" e "Comparar uma colecao". Na janela, o "i" das
  fichas tambem aparece junto de "Usar fichas" e a lista das fichas em Comparar.
- **Eliminar:** uma resposta com texto nunca e tratada como erro no aviso (oferece
  guardar como nota), mesmo que tenha um erro associado.
- **Separadores (um por acao e por pergunta):** `state.convs` (listas de
  mensagens) e `state.active`; `state.messages` e sempre `convs[active]`.
  `_routeConversation` (chamado em `_ask`): uma acao vai para o separador dela
  (ou um novo), cada pergunta abre um novo (sem historico), um separador vazio e
  aproveitado; "Repetir" fica no mesmo (`stay`). Escolher uma acao ja pedida abre
  o separador dela sem enviar. "Nova conversa" abre um separador vazio. Fechar
  pede sempre confirmacao. Sem limite automatico. O historico antigo (tudo numa
  conversa) e separado por acao ao abrir (`_splitByAction`). Ficheiro de historico versao 2
  (`conversations`, `active`); a versao 1 ainda se le.
- **Triagem por criterios** (acao `triagem`, grupo comparar, `perDoc`,
  `needsCriteria`): sem criterios na caixa de texto nao envia e a acao fica escolhida.
  Um pedido por PDF: tabela "Verificacao dos criterios" e so depois a decisao. Ultima
  linha tecnica `TRIAGEM: INCLUIR|EXCLUIR|DUVIDOSO` (`parseScreening`, retirada do texto
  com `removeScreeningLine`). No fim a app junta "Resumo da triagem"
  (`screeningSummary`, `_addScreeningSummary`), sem motor e sem "Repetir", com CSV.
  Botao "i" (`_triagemInfoEl`). Nunca pedir "raciocinio" a IA: o filtro do Sonnet 5.5
  recusa isso como extracao do pensamento interno (`reasoning_extraction`).
- **Sem titulo repetido:** numa acao a bolha do pedido fica escondida
  (`_hideRepeatedAsks`) e as indicacoes aparecem ao lado do nome da acao
  (`.zia-action-extra`). As perguntas livres mantem a bolha.
- **Respostas:** Copiar e Guardar como nota ficam por cima do texto. O titulo
  tem so a acao e o x (nunca recolhe). O motor, o modelo e o consumo ficam por
  baixo do texto (`.zia-msg-meta`). Rodape do painel so com
  "Nova conversa" e "Abrir em janela".
- **Avisos com x:** `_setStatus` com "warn" ou "error" mostra um botao para fechar.
- **Paleta** (no fim de `zoteroia.css`, um so bloco de variaveis, claro e
  escuro): creme quente, tinta azul-noite para texto e o que esta escolhido,
  dourado so como marca, azul so nas citacoes e ligacoes. O que esta escolhido
  (separador, acao) fica claro e sobrio: fundo claro, contorno fino, texto a tinta.
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
  também pelos pedidos reais na conversa. O motor em uso nunca aparece "Por
  configurar": sem teste mostra "Falta testar". O Claude Code tambem e procurado na
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
  provided"). O `mockzotero.js` imita esta regra. Todas as respostas tem
  "Guardar como nota".
- **Painel:** caixa de texto por cima das respostas e a resposta mais recente
  logo abaixo dela. Separador "Personalizado" (grupo `meus`) com formulario
  para criar, editar e apagar acoes (`setCustomPrompt`/`removeCustomPrompt`,
  ids estaveis `custom:<nome>`). Botao "+ PDF" abre um seletor com os artigos
  da lista central do Zotero (`pickableItems`, `getSortedItems`), com pesquisa.
  Uma acao que precisa de mais PDFs (Comparar) abre o seletor.
- **Enviar so com o botao:** Enter na caixa de texto muda de linha, nunca envia.
  Enviar com a caixa vazia mostra um aviso. O seletor "+ PDF" ordena por data de
  adicao (omissao), autor ou data de publicacao.
- **Acoes em dois passos:** clicar numa acao so a escolhe (`selectAction`); o
  pedido segue com "Enviar" (o mesmo botao das perguntas, no painel e na janela),
  com indicacoes opcionais. Acoes ja pedidas levam um visto e
  escolher uma acao ja feita mostra a resposta existente.
- **Historico por artigo:** `saveConversation`/`loadConversation` guardam as
  mensagens (sem o texto dos PDFs) em
  `<pasta de dados do Zotero>/zoteroia/conversas/<biblioteca>_<chave>.json`.
  Varias conversas por artigo. Pref `history.save` (ligada por omissao), botao para apagar nas definicoes.
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

- `node --test tests/lib.test.js` — testes unitarios puros (36), incluindo
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
- `node tests/harness/run_prefs.js` — converte `preferences.xhtml` para HTML e
  carrega em todos os botoes, separadores e ligacoes das definicoes (cada um tem
  de fazer alguma coisa e nenhum pode dar erro). O `run_ui.js` faz o mesmo para
  os botoes do painel
- `ONLY=<acoes>` corre so essas acoes (ex.: `ONLY=triagem,critica`).
- `CLAUDE_PATH=<exe> node tests/harness/run_ai_real.js claude` ou
  `GEMINI_API_KEY=<chave> node tests/harness/run_ai_real.js gemini` — todas as
  acoes com a IA REAL, mais perguntas-armadilha (informacao que nao existe,
  premissa falsa) e uma pergunta de seguimento, verificadas com `verifyAnswer`.
  Respostas em `tests/harness/out/ia_real_<motor>/` (gasta quota)
- `ZOTERO_SRC=<clone> node tests/harness/run_cite.js` — citacoes nos estilos APA e
  ABNT com o `citeproc.js` REAL do Zotero (precisa de `git sparse-checkout add
  chrome/content/zotero/xpcom`); estilos de teste em `tests/harness/csl/`
- `ZOTERO_SRC=<clone> node tests/harness/run_bootstrap.mjs` — valida (3 menus)
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

Gera `dist/assistente-ia-0.7.3.xpi` e `dist/updates.json`. O `.xpi` fica pronto a instalar em
**Ferramentas -> Plugins -> Install Plugin From File...**

## Creditos

Sergio Bernardo (sem email por agora). Grupo "Creditos" no fim das definicoes
(nome da app, versao e autor; sem data) e campo `author` do manifest. Nao mostrar
autoria do Claude no addon, na documentacao nem nos commits.

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
