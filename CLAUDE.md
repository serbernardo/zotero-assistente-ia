# Assistente IA para Zotero

Addon para o Zotero (8 ou superior) que ajuda a ler, avaliar e escrever a partir
de artigos cientificos, com a conta de IA do proprio utilizador (gratuita ou
paga). Seis motores: Claude com chave da API (`anthropic`), Claude com a
subscricao Pro/Max atraves do Claude Code em subprocesso (`claude`), ChatGPT
com chave da API da OpenAI (`openai`), ChatGPT com a conta do utilizador,
gratuita ou paga, atraves do Codex CLI em subprocesso (`codex`) e Gemini com
chave da API (`gemini`) e IAEdu (`iaedu`, agente da instituicao). Interface em PT-PT e ingles (`content/i18n.js`,
pref `ui.lang`: auto, pt-PT, en). As respostas da IA saem sempre na lingua da app
(`buildSystemPrompt("ui")`, ja nao ha opcao propria). Botao PT/EN no titulo do
painel (sectionButton `zoteroia-lang`, `toggleLanguage`, `showLang` troca o icone
`lang-pt16.svg`/`lang-en16.svg`). Todas as respostas citam a pagina do PDF em formato
[Dn:pX], que fica clicavel e abre o PDF nessa pagina
(zotero://open-pdf/library/items/<key>?page=<n>).

Acoes (em `lib.js`, `ACTIONS`, agrupadas em separadores `ACTION_GROUPS`). Nomes atuais (PT/EN):
- Compreender/Understand: Resumir (botao, `action.resumo.button`; a resposta chama-se Resumo)/Summarise,
  Ideias principais (`pontos`)/Main ideas, Explicacao simples (`simples`)/Plain-language summary,
  Conceitos-chave (`conceitos`)/Key concepts, Testar o que percebi (`estudo`)/Test my understanding,
  Esquema (texto por niveis)/Outline, Mapa mental (grafico com ramos, `mapa`)/Mind map.
- Avaliar/Appraise: Relevancia para o meu tema (`relevancia`, precisa do tema na caixa, `needsCriteria`
  e `needsMsg`), Avaliacao critica (grelha CONSORT/STROBE/PRISMA/COREQ/CASP/JBI, "Apreciacao global"
  marcada como opiniao da IA, sem GRADE), Metodos e dados, Afirmacoes e evidencia (`conclusoes`).
- Extrair/Extract (grupo `escrever`): Ficha de leitura/Reading sheet (14 campos, um so tipo nos dois
  modos), Excertos citaveis, Palavras-chave/Keywords (`etiquetas`, adiciona etiquetas do Zotero).
- Investigacao futura/Future research (grupo `investigar`): Lacunas, Referencias-chave (`referencias`,
  `keepRefs`: a lista de referencias do PDF nao e cortada), Perguntas de investigacao.
- Compreender tem tambem Explicar os meus destaques (`destaques`, `useAnnotations`, `needsHighlights`:
  so aparece no Avancado e quando o PDF tem destaques, `_hasHighlights`).
- Janela (varios artigos, `_renderWindowActions`): 4 botoes grandes, sem separadores e sem pergunta
  livre: a caixa de texto e o Enviar so aparecem depois de escolher uma opcao (`_syncInput`).
  O texto inicial mostra os 3 passos (`chat.empty.window`):
  - Comparar artigos: modelos `.zia-preset` Visao geral (`comparar`), Metodos, Resultados, Conceitos
    (`cmp_conceitos`) e As minhas colunas (`cmp_tabela`, colunas escritas na caixa).
  - Perguntar a colecao (`pergunta`): tabela por artigo, sintese e linhas tecnicas `RESPOSTA D1: SIM|EM
    PARTE|NAO|NAO ABORDA` (`parseStances`, `removeStanceLines`), barra `_stanceMeter` (`msg.stances`).
  - Mapa de temas (`temas`, `metaOnly`): envia so titulo, resumo e palavras-chave (`itemMetaText`, sem
    resumo usa o inicio do PDF). Vistas Constelacao (por omissao, `_themeGraph`: cada tema numa nuvem
    de cor com etiqueta clara, um artigo em varios temas e um so circulo com as cores dos temas e
    ligacoes tracejadas, cartao com titulo ao passar o rato, clicar abre o PDF, clicar num tema ou na
    legenda destaca-o) e Arvore (a lista). Avisa os artigos que ficaram de fora.
  - Revisao de literatura (`cmp_sintese`, a unica revisao).
  Visao geral nao se chama "Comparacao geral": as notas ja comecam por "Comparacao:".
- Testar o que percebi tem "Exportar para o Anki" (`studyToAnki`, CSV com `#separator:Comma`).
- Personalizado (prompts do utilizador, pref `custom.prompts`, uma linha "Nome: instrucao").
Regra dos nomes: um nome por acao em todo o addon, o mesmo no Simples e no Avancado. O botao usa um
verbo quando ha um natural (`button`, so Resumir), a resposta e a nota ficam com o nome (`label`).

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
- **Numero impresso nas paginas** (`detectPageOffset` e `pageLabel` em `lib.js`): o texto do PDF vem
  por posicao no ficheiro (1, 2, 3...), que muitas vezes nao e o numero impresso no artigo (a 1.a
  pagina do ficheiro pode ser a pagina 145 da revista, ou haver uma capa antes). O addon procura
  numeros no cabecalho e no rodape de cada pagina e so aceita um desvio constante confirmado em
  3 paginas, em pelo menos metade do documento e com margem clara sobre o segundo candidato. Um
  numero fixo (ano, volume, intervalo de paginas) nunca ganha, porque nao sobe de 1 em 1. Sem
  certeza, fica a posicao no ficheiro. As citacoes, as notas e o `locator` do estilo do Zotero
  mostram o numero impresso, as ligacoes continuam a abrir a pagina do ficheiro (`citeHref`) e o
  tooltip diz qual e ("(1.a pagina do PDF)", "(1st page of the PDF)", `ordinal`). Os avisos da verificacao usam
  `citeLabel(..., { raw: true })`, para mostrar o numero que a IA escreveu. O desvio fica guardado
  na resposta (`m.pageOffsets`, `_docsMap(m)`), para as citacoes continuarem certas depois de
  reiniciar o Zotero sem voltar a ler o PDF.
- **Lingua das respostas:** `buildSystemPrompt` diz que a lingua escolhida vale sempre, mesmo que os
  documentos ou a pergunta estejam noutra lingua (so os excertos entre aspas ficam na lingua do PDF).
  As instrucoes das acoes estao em portugues, por isso `buildRequestParts` acrescenta no fim do
  pedido, depois de `</pedido>`, um lembrete escrito na propria lingua da resposta
  (`answerReminder`, campo `remind` em `LANGUAGES`, so para linguas que nao o portugues): e a
  ultima coisa que o modelo le e e o que mais ajuda os modelos pequenos. Teste de paridade confirma
  que nenhum texto ingles ficou em portugues (menos os nomes das linguas). `UI_LANG=en
  tests/harness/run_ai_real.js` corre tudo com a app em ingles e marca as respostas que saiam em
  portugues (`wrongLanguage`, excertos entre aspas excluidos).
- **Verificacao automatica** (`verifyAnswer` em `lib.js`): cada resposta e
  confirmada contra o texto dos PDFs. Excertos entre aspas seguidos de citacao
  (literal, com palavras alteradas, noutra pagina ou inexistente), paginas
  citadas que nao existem, numeros (decimais e percentagens) que nao estao nos
  PDFs e contas (`findCalculations`, so valem se o resultado estiver certo). O
  resultado (`msg.check`) aparece por baixo da resposta e fica no historico.
  Termos (a pedido): **transcricao** = texto copiado do PDF entre aspas, **parafrase** = frase da IA
  com a pagina (em ingles "direct quote" e "paraphrase"). A acao "Excertos citaveis" mantem o nome.
  Auditoria da 1.0.17:
  - O visto so diz o que foi confirmado (`_checkBox`): "✓ N transcricoes confirmadas no PDF" ou
    "✓ N numeros encontrados" (`check.okNumbers`). Sem nada confirmado nao ha visto, so a linha
    discreta `.zia-check-info` "Parafrases da IA: as paginas citadas existem, confirma o conteudo no
    PDF" (ou `check.noCites` sem citacoes, `res.cites`). Antes o Simples dizia "✓ Confirmado no PDF"
    a respostas sem nada verificado.
  - `normForMatch` usa NFKC: as ligaduras dos PDFs (ﬁ, ﬀ) davam "transcricao nao encontrada".
  - Aspas simples ‘…’ tambem sao transcricoes (`QUOTE_SINGLE`, `quoteMatches`): o ’ tambem e
    apostrofo, por isso fecha o ultimo antes da citacao.
  - `n = 340` / `N = 1,234` (`STAT_N_RE`, inteiros do PDF em `docIntegers`) e valores de p sem zero
    (`p < .001`, `STAT_P_RE`, `docDecimals`: .001 e 0.001 sao o mesmo). Os outros inteiros continuam
    de fora (anos e paginas davam falsos alarmes).
  - Um artigo da conversa sem texto lido entra no `pool` com `pages: null`: as citacoes dele ja nao
    dao "pagina que nao existe". So um Dn que nao esta na conversa e erro.
  - Tolerancia de uma pagina e parafrases nunca verificadas: ficam assim (decisao da auditoria).
- **Destaque da transcricao no PDF:** `inlinesToDOM` guarda o texto desde a citacao anterior e
  `quoteBeforeCite` encontra a transcricao logo antes (ate 40 caracteres). O clique passa
  `{ quote }` a `_openCite`, que escolhe as primeiras 7 palavras que estao na pagina
  (`quoteSnippet`, so o pedaco antes de "...") e `openAtPage(d, page, { find })` abre a pagina e
  escreve o pedaco na pesquisa do leitor do Zotero (`findInReader`: `reader._internalReader.
  _handleFindStateChange(true, cloneInto(estado))`, `highlightAll` falso). Nao grava nada no PDF.
  E uma funcao INTERNA do leitor (zotero/reader `src/common/reader.js`): se mudar, abre so a pagina.
  Separador do PDF adormecido: `Zotero.Reader.open` devolve undefined, procura-se o leitor em
  `Zotero.Reader._readers` durante 3 s. Tooltip `cite.find`. As parafrases so abrem a pagina.
  Ainda nao testado no Zotero real.
- **Fichas das notas com paginas certas:** a nota guarda as citacoes como ligacoes
  `zotero://open-pdf/...?page=N` (pagina no ficheiro) com o numero impresso no texto.
  `noteToText(note, doc)` chama `noteCitesToMarkers` e volta a por `[Dn:pN]` (so as ligacoes desse
  PDF, pela chave do anexo). Antes a IA via "p. 147" e escrevia [D3:p147]: ligacao errada, aviso falso
  e o desvio somado duas vezes. Em `_ask` as fichas tambem leem o texto do PDF (so para a verificacao
  e o `pageOffset`, nao vai no pedido). Se falhar, a ficha segue.
- **Historico enviado a IA:** as acoes nao levam historico (sao pedidos
  completos). As perguntas livres ficam no separador a vista e levam as ultimas 3 trocas desse
  separador, ate 24 mil caracteres (`selectHistory`): assim da para perguntar "e quanto a amostra?".
- **Gemini, tarefas exigentes** (`isHeavyTask`: Avaliar, Comparar, Investigar,
  e perguntas com 2 ou mais PDFs): `runGeminiHeavy` tenta primeiro o
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
- **Abrir e fechar como no Zotero:** o addon nao mexe no estado da seccao nem desfaz o "fixar"
  do icone. A 0.10 fechava o assistente por omissao (`pane.closedApplied`): `undoClosedByDefault`
  no `bootstrap.js` volta a abri-lo uma so vez (pref `pane.normalApplied`) e dai em diante o
  Zotero guarda a escolha da pessoa.
- **Acoes proprias:** ao escolher uma acao do Personalizado aparece "Editar" ao
  lado do pedido. O formulario tem Guardar, Cancelar e Eliminar (`_deleteCustom`).
- **Colecao indicada:** depois de juntar uma colecao aparece a etiqueta
  "Colecao: X" antes dos artigos e uma mensagem com quantos foram juntados.
- **Botoes principais iguais** (Enviar, Pedir, Guardar, Juntar): azul acinzentado (`--zia-accent`
  #4a6fa5, no escuro #8fb0de), texto branco, mesmo tamanho. O interruptor Simples/Avancado usa a mesma cor. O Enviar nunca fica cinzento: se faltar algo, o
  clique explica o que falta.
- **Mesmo autor e ano:** `disambiguateRefs` (lib.js) acrescenta a, b, c ao ano
  (Silva et al., 2021a e 2021b) nos chips, citacoes e notas. O id Dn continua unico
  internamente, mas nunca aparece a quem le: `replaceDocIds` (lib.js) troca "D1" pelo
  autor e ano, retira "(D1, D2)" e "documento D1" no texto, titulos, notas e avisos. Excecao: um "D1"
  que o proprio PDF usa como nome ("recetores D1 e D2", "vitamina D3") fica como esta. Cada resposta
  guarda esses nomes em `m.literalIds` (`literalDocIds`), e `_docsMap(m)` passa-os ao `replaceDocIds`
  (propriedade `literalIds`, nao enumeravel). "documento D1" e as celulas so com "D1" trocam-se sempre.
- **Painel, troca rapida de artigo:** `showItem` usa um contador (`_showToken`): so conta o ultimo
  artigo pedido, e `_addItems` junta os artigos a conversa em que comecou (`st`), nunca a de outro
  artigo. Antes, passar depressa pela lista com as setas punha dois artigos na mesma conversa.
- **Janela ja aberta:** os artigos que chegam (clique direito, faixa "Varios artigos", menu das
  colecoes) substituem os que la estavam (`replaceItems`), as respostas antigas ficam. Antes
  somavam-se (comparar 2 artigos com 30 na janela comparava 32). Um artigo que volta usa o seu Dn
  antigo (`_addItems` procura em `allDocs`). A meio de um pedido nao muda nada (`win.busyReplace`).
- **Muitos artigos de uma vez:** acima de 100 (`MANY_CONFIRM`) o seletor e "Juntar a colecao toda"
  pedem confirmacao com a estimativa de pedidos (`_confirmMany`). Ao desistir o seletor fica aberto.
  Nao ha limite fixo de artigos: o que limita e o texto por pedido de cada motor (`maxChars`) e a quota
  da conta. Para o utilizador saber, ha tres avisos: o do seletor (acima de 50 escolhidos, com `r` = lotes
  + 1 pedidos), a confirmacao (acima de 100) e a linha `.zia-large-note` da janela (`_renderLargeNote`,
  `win.largeNote`, `win.largeNote.themes`), que so aparece com mais de 12 artigos e uma acao que faz
  lotes ou revisao por temas. README e GUIA tem a frase "Limites".
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
- **Fichas no separador Extrair:** botao "i" ao lado de "Ficha de leitura" com a explicacao e
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
- **Comparar so na janela:** no painel nao ha separador Comparar, o atalho "Comparar artigos ↗"
  esta no rodape do Avancado (`openInWindow({ group: "comparar" })`).
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
- **Painel Avancado** (`.zia-mode-section:not(.zia-simple)`): motor, ⚙ e interruptor Simples/Avancado
  numa linha. Separadores com sublinhado e nomes curtos (`group.<id>.tab`: Investigar, Pers.), o nome
  completo aparece ao passar o rato. Sem chip do artigo, menos se o registo tem varios PDFs
  (`_recordHasManyPdfs`). A acao escolhida mostra a descricao (`.zia-pending-desc`, o `hint`). Com os
  separadores de conversa visiveis o nome nao se repete na resposta (so o x no canto, `.zia-head-x`).
  O tempo fica na linha por baixo da resposta (`m.secs`), nao no estado. Com 2 ou mais motores
  prontos, "Repetir com" e uma lista (`.zia-retry-sel`). Rodape sem "Nova conversa".
  Opcao B: um clique numa acao envia logo (`_runAdvanced`, `_isAdv`). Sem "+ indicacoes" (retirado a
  pedido). So a Relevancia abre um campo (`_renderHints`, `.zia-hints`) com o pedido do tema e um
  botao "Pedir: X" (`_hintsFor`). Linha "ou"
  (`.zia-or`) antes da caixa, que e so para perguntas ("Ou pergunta algo sobre o artigo…").
  Sugestoes em pastilhas, sem texto de ajuda repetido.
- **Repetir com:** so aparecem os motores "Prontos" (`<motor>.lastTest` = ok, `_otherReadyEngines`).
- **Listas na janela:** a janela e uma janela XUL propria onde os select nativos nao abrem. `_select`
  devolve um select normal no painel e uma lista feita com botoes na janela (`.zia-dd`, com
  `addOption`, `clearOptions`, `value`, `disabled` e evento change): motor, "Procurar em" e "Ordenar".
- **Clique direito nos itens** (submenu Assistente IA): Abrir na janela do assistente, Perguntar a
  estes artigos (`chooseAction`: fica escolhida a espera da pergunta), Mapa de temas (`autoAction`) e
  as comparacoes.
- **Simples por omissao:** `simpleModeOnce` no `bootstrap.js` poe `ui.mode` = simple uma so vez (pref
  `ui.simpleApplied`), depois fica a escolha da pessoa.
- **Icones das acoes** (`_actionIcon`, `_icon`): cada acao tem um icone em linha fina num quadrado claro
  com a cor da acao (`.zia-ic`, `.zia-k-<cor>`), igual no Simples, no Avancado e nos 4 cartoes da janela.
- **Painel sem ajuda nem motor:** sem lista do motor no painel (Simples e Avancado, motor nas definicoes),
  sem perguntas por baixo da caixa e sem rodape ("Nova conversa" retirado). As perguntas de exemplo estao
  em Pers. (`.zia-examples`, um clique escreve a pergunta na caixa). A janela mantem os 3 passos.
- **Muitos artigos na janela** (`DOCS_INLINE` = 12, `_docsOpen`, `_fichasOpen`): com mais de 12
  artigos a lista de cima (`_renderDocs`) encolhe para "N artigos" mais "ver a lista"
  (`.zia-docs-count`, `.zia-docs-toggle`), e a lista das fichas faz o mesmo
  (`ficha.list.count`, `.zia-fichas-toggle-list`). Abertas, tem altura maxima em vh e deslizam por
  dentro (`.zia-docs` 22vh, `.zia-fichas-scroll` 16vh). Sem isto, com uma colecao grande as duas
  listas enchiam a janela (428px + 317px numa janela de 900px), a caixa de texto e o Enviar ficavam
  fora do ecra e a janela nao rola, por isso eram inalcancaveis. Teste "janela com 50 artigos" em
  `run_ui.js` mede que ficam dentro da janela, com as listas fechadas e abertas.
- **Muitos artigos: lotes** (`largeMode`, `LARGE_DOCS` = 12, `BATCH_SIZE` = 10, `BATCH` em `lib.js`; `_runLarge`,
  `_largeTables`, `_largeReview`, `_engineCall`, `_loadTextsTolerant` em `chatview.js`). Com mais de 12 artigos, Comparar
  (os 5 modelos) e Perguntar a colecao fazem um pedido por lote de 10 so com a tabela (`batchPrompt`: colunas fixas, a
  coluna Documento so com o id "D3", que o addon troca pelo autor e ano), juntam as linhas numa tabela (`rawTables`,
  `mergeTables`, `sortMergedRows`) e no fim um pedido de sintese em que cada documento leva so as suas linhas
  (`rowsAsFichas`, `synthPrompt`). Resultados e Conceitos passam a tabela longa (uma linha por resultado ou conceito de
  cada documento, ordenada pelo tema), que se junta entre lotes e da para tabelas dinamicas no Excel. A Revisao de
  literatura faz primeiro os temas so com os metadados (`parseThemeList`), depois uma parte por tema
  (`reviewPartPrompt`, os artigos sem tema vao para "Outros") e o fecho (`reviewEndPrompt`). Uma so resposta na conversa,
  a tabela vai crescendo a cada lote e o progresso aparece no estado; a nota por baixo diz "Feito em N lotes (M pedidos)".
  Um PDF ilegivel fica de fora e avisado; um erro do motor para, mas o que ja veio fica na resposta, e "Tentar de novo"
  refaz tudo (`request.large`, `_startLarge`). "Usar fichas" so se liga sozinho entre 6 e 12 artigos (`_fichasAuto`):
  com mais, os lotes chegam e as fichas seriam um pedido a mais por artigo (56 pedidos em vez de 6 com 50 artigos).
  O texto da caixa diz o que vai acontecer (`_renderFichasLabel`): "Criar as 8 fichas e usa-las (8 pedidos a mais)",
  "Usar fichas (3 feitas, criar as 5 em falta)" ou "Usar as 8 fichas ja feitas". So na janela: no painel (um artigo)
  nao ha "Usar fichas".
- **Limite de pedidos por minuto** (`LIMIT_WAITS` = 30, 60 e 90 s, `LIMIT_PACE` = 15 s, `_waitsOnLimit`, `_limitPause`,
  `_askWaiting`): so nos motores com chave (IAEdu, Claude API, ChatGPT API). O Gemini ja espera sozinho e o limite da
  subscricao do Claude Code e do Codex dura horas. Num lote (`_engineCall`) ou num pedido de uma serie (fichas),
  um erro `limit` faz uma pausa com contagem ("O IAEdu pediu uma pausa… Continua sozinho dentro de 30 s"), que o botao de
  parar interrompe, e repete o mesmo pedido; depois do primeiro aviso ha uma pausa curta entre lotes. O IAEdu manda o
  limite dentro da resposta ("Rate limit reached (429)", HTTP 200): `classifyIAEduError` reconhece-o pelo texto. Se
  mesmo assim parar, o progresso fica em `request.progress` (lotes feitos, temas e partes da revisao) e o botao passa
  a "Continuar de onde parou", que so faz o que falta, tambem com outro motor ("Repetir com").
- **Tabelas grandes na janela** (`_enhanceTables`, `TABLE_TOOLS` = 8 linhas): altura propria (55vh) a deslizar por
  dentro, cabecalho e 1.a coluna fixos (`position: sticky`), pesquisa sem acentos nem maiusculas, contagem "X de N
  linhas" e filtros por uma coluna de categorias (2 a 5 valores curtos, `_categoryColumn`: Resposta). O CSV
  exporta sempre a tabela inteira. Botao "Exportar para Excel (CSV)" (`;` e BOM, abre em colunas no Excel portugues).
  Mapa de temas exporta uma linha por artigo e tema (`themesToCSV`). Revisao de literatura com indice (`_tocRow`).
- **Seletor + Artigos** (`_openPicker`): pesquisa com lupa, "Toda a biblioteca" e "Coleção" em botoes. "Coleção"
  mostra a lista das colecoes NO LUGAR dos artigos, como no Zotero (`renderCols`, `.zia-col-pick`: pasta, nome,
  subcolecoes recuadas, numero de artigos com PDF `pdfCount`, seta). Clicar abre a colecao, com o caminho
  "‹ Colecoes · Tese" (`.zia-picker-crumb`, `.zia-picker-back`) para voltar. Sem lista suspensa (a pedido: era
  pouco visivel). A pesquisa filtra as colecoes nessa vista ("Procurar colecao"), "Ordenar" discreto a direita (Mais recentes, Autor, Ano, Titulo). Sem "Pasta
  aberta". Linhas compactas de duas linhas (autor e ano a negrito, titulo por baixo, `x.ref`/`x.title`
  de `pickableItems`). Uma caixa "Marcar todos (N)" por cima do primeiro artigo marca e desmarca os artigos
  visiveis (a pesquisa conta, fica mista com so alguns). Rodape: "Escolhidos: N", "Juntar a colecao toda"
  numa colecao, Cancelar e Juntar. Aviso com mais de 50 escolhidos (`chat.picker.many`). As escolhas ficam ao
  mudar de colecao. Os artigos ja na conversa aparecem marcados e bloqueados ("na conversa", `.zia-picker-in`)
  e nao contam no "Marcar todos". "Colecao" aparece sempre: sem colecoes explica como criar uma
  (`chat.picker.noCols`). Enviar com o seletor aberto junta os marcados e faz o pedido (`_pickerCommit`
  chamado em `runAction`). Faltando artigos, a acao fica escolhida na janela e a mensagem diz quantos faltam.
- **Linha de cima do painel** (`.zia-top`): sem titulo (o Zotero ja mostra "Assistente IA" no cabecalho),
  PT/EN (`.zia-langswitch`, muda `ui.lang` e redesenha) e definicoes (roda dentada, icone `gear`, desenhada em `_icon`). Icones em linha
  fina desenhados em SVG (`_icon`, `_iconButton`). Por baixo, a faixa "Varios artigos · Comparar, perguntar, mapa de temas ›"
  (`.zia-multi-strip`) abre a janela vazia (`openInWindow`, a pedido: os artigos escolhem-se la).
  Na janela, "+ Artigos" (`.zia-add-articles`, `this.addBtn`) fica a esquerda, antes da lista dos artigos, e e cheio na cor principal enquanto nao ha artigos e
  passa a fundo azul claro com artigos (`.zia-has-docs`, em `_renderDocs`), para nao competir com o Enviar. Sem botoes no titulo da seccao do Zotero (sem
  `sectionButtons`) e sem "Abrir em janela" nem "Comparar artigos ↗" no rodape.
- **Painel = um artigo:** o seletor de artigos nunca abre no painel (`_openPicker` sai se o modo nao for a janela).
  Num registo sem PDF os botoes das acoes ficam inativos e clicar mostra `chat.noPdfAction` (abre a janela). Teste
  "registo sem PDF" em `run_ui.js`. No painel nao ha "+ PDF" nem "D1" nos chips. Varios PDFs
  so na janela (com "+ Artigos" na barra de cima). O cartao "sem PDF" tem
  "Abrir a janela do assistente" e "Comparar uma colecao". Na janela, o "i" das
  fichas tambem aparece junto de "Usar fichas" e a lista das fichas em Comparar.
- **Eliminar:** uma resposta com texto nunca e tratada como erro no aviso (oferece
  guardar como nota), mesmo que tenha um erro associado.
- **Separadores (um por acao):** `state.convs` (listas de
  mensagens) e `state.active`; `state.messages` e sempre `convs[active]`.
  `_routeConversation` (chamado em `_ask`): uma acao vai para o separador dela
  (ou um novo, um separador vazio e aproveitado), uma pergunta fica no separador a vista
  (opcao A da auditoria da 1.0.13: antes cada pergunta abria um separador sem historico); "Repetir" fica no mesmo (`stay`). Escolher uma acao ja pedida abre
  o separador dela sem enviar. "Nova conversa" (so no Simples e na janela) abre um separador vazio. Fechar
  pede sempre confirmacao. Sem limite automatico. O historico antigo (tudo numa
  conversa) e separado por acao ao abrir (`_splitByAction`). Ficheiro de historico versao 2
  (`conversations`, `active`); a versao 1 ainda se le.
- **Triagem retirada (1.0.12, a pedido):** a acao `triagem` e o diagrama PRISMA 2020 sairam por
  desvirtuarem o objetivo da app (a pesquisa nas bases de dados faz-se fora do Zotero). Se voltar: nunca
  pedir "raciocinio" a IA, o filtro do Sonnet 5.5 recusa isso como extracao do pensamento interno.
- **Modo Simples / Avancado** (pref `ui.mode`, "simple" por omissao, so no painel lateral: a janela
  e sempre avancada). Interruptor no topo do painel (`.zia-modeswitch`) e lista nas definicoes
  (Respostas, `initUIMode`). Simples (`this.simple`, `_renderSimpleActions`, `_runSimple`): 6 botoes
  grandes com descricao (resumo, simples, conceitos, mapa, estudo, relevancia) que enviam logo (Ficha de
  leitura e Explicar os meus destaques so no Avancado);
  uma acao ja pedida mostra a resposta sem novo pedido (menos a relevancia, que usa o tema escrito na
  caixa e pode repetir-se). Sem "Excertos citaveis" no simples (estudantes devem parafrasear). Sem separadores, lista de motores (usa o das
  definicoes), "Repetir com" nem motor/modelo por baixo da resposta; verificacao curta
  ("Confirmado no PDF") quando nao ha problemas, os avisos aparecem inteiros. Mudar de modo nas
  definicoes a meio de uma resposta so redesenha no fim (`_rebuildLater`). Mesmas cores do resto.
  Nos testes do painel `ui.html` usa "advanced" por omissao (`?uimode=simple` para o simples).
- **Mapa mental** (acao `mapa`): a IA devolve so uma lista encaixada (`_mindmapNodes`). So a vista Ramos
  (`_mindmapBranches`, CSS `.zia-mm-m1`): raiz a azul, cada ramo com a sua cor, so a pagina nas citacoes
  quando ha um artigo, clicar no nome de um ramo esconde ou mostra as ideias (`.zia-mm-fold`,
  `.zia-folded`). O Diagrama em SVG foi retirado a pedido. Nas notas fica a lista.
- **Mapa de temas interativo** (`_mapCanvas`, so a Constelacao): arrastar para mover, botoes −, + e Ajustar, Ctrl + roda do
  rato. A vista fica em `m.mapView`. Os nos clicaveis tem `.zia-map-hit` (nao comecam o arrastar).
  Tudo em SVG feito pelo addon, sem bibliotecas de fora. Cores em `MAP_COLORS` (a primeira e o petroleo).
- **Testar o que percebi** (acao `estudo`): 8 perguntas (compreensao, ligacao de ideias, reflexao
  critica) com resposta modelo e pagina. "Ideias principais" (`pontos`) nao sao palavras-chave
  (essas sao a acao `etiquetas`).
- **Nome da acao na lingua atual:** o titulo de cada resposta e das conversas vem de
  `_actionTitle` (pelo `actionID`), nao do `actionLabel` gravado, para mudar com o botao PT/EN.
- **Sem titulo repetido:** numa acao a bolha do pedido fica escondida
  (`_hideRepeatedAsks`) e as indicacoes aparecem ao lado do nome da acao
  (`.zia-action-extra`). As perguntas livres mantem a bolha.
- **Respostas:** Copiar e Guardar como nota ficam por cima do texto. O titulo
  tem so a acao e o x (nunca recolhe). O motor, o modelo e o consumo ficam por
  baixo do texto (`.zia-msg-meta`). O painel nao tem rodape (o botao de apoio, escondido por agora,
  e o unico que la iria).
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
  `CODEX_API_KEY` sao retiradas do ambiente (usa-se a conta), com a pref propria
  `codex.ignoreApiKey` (antes dependia da opcao do Claude Code). A marca `<instrucoes_de_sistema>`
  tambem e neutralizada nos PDFs (`neutralizeTags`).
- **IAEdu** (motor `iaedu`, `runIAEdu`, `createIAEduStreamParser`, `classifyIAEduError`,
  `isIAEduEndpoint`): servico de IA para o ensino e a investigacao em Portugal. Por omissao
  liga ao agente "Assistente IA Zotero", partilhado com a UPorto (`IAEDU_DEFAULT_ENDPOINT` e
  `IAEDU_DEFAULT_CHANNEL` em `lib.js`, nao sao segredos: sem a chave pessoal nao responde).
  Cada cartao do IAEdu (agente) tem a sua chave, o seu endpoint (com o id do agente no meio) e o seu
  canal: uma chave de um cartao NAO funciona no agente de outro (foi o erro de uma colega, chave do cartao
  "OpenAI" com o agente por omissao: "chave invalida"). Nas definicoes os tres campos estao sempre a vista,
  pela ordem do painel Informacao da API: Endpoint da API (pref `iaedu.endpoint`, tem de ser https e do
  dominio iaedu.pt, senao nada e enviado), Chave da API (cofre, cabecalho `x-api-key`) e ID do Canal
  (`iaedu.channel`), com a nota `prefs.iaedu.fields` ("copia os tres do mesmo cartao"). Sem secao escondida
  "Usar outro agente". Endpoint e canal em branco voltam ao agente partilhado da UPorto (`iaeduEndpoint`,
  `iaeduChannel`), que so aceita chaves desse agente. Nao pre-preencher o endpoint: muda de agente para
  agente. Chave recusada (`_iaeduAuthHint`): `err.iaedu.authDefault` (campos em branco, diz para copiar o
  Endpoint e o Canal do mesmo cartao) ou `err.iaedu.auth` (os tres do mesmo cartao, chave inteira). Pedido multipart
  (`channel_id`, `thread_id` novo em cada pedido, `user_info` = "{}", `message` = instrucoes de
  sistema + pedido, porque nao ha campo proprio). Resposta em blocos JSON separados por linhas
  em branco: `start`, `token`, `message` (texto completo, vale mais do que os pedacos) e `done`.
  Sem consumo de tokens na resposta. O modelo e o do agente. Testado a mao com 80 mil e 320 mil
  caracteres (`maxChars` 3000000 por omissao, a pedido). Separador proprio nas definicoes. Termos de uso e limites do IAEdu desconhecidos: o aviso de privacidade
  manda confirmar. Teste: `run_iaedu.js`.
- **Mudar de modelo nao e um erro:** os avisos de troca do Gemini (modelo ocupado,
  nova tentativa, quota) aparecem como progresso normal (`_setStatus(texto, null, true)`,
  com spinner, sem laranja e sem x) e, quando a resposta comeca a chegar, passam a
  "A escrever a resposta…" (`chat.writing`). No fim a explicacao fica discreta por baixo
  da resposta ("Respondeu o X, porque o Y estava ocupado"). So uma falha real usa
  `chat.error` e o vermelho. Evitar as palavras "erro" e "sobrecarregado" nos avisos de
  troca. Teste "Gemini muda de modelo" em `run_ui.js`.
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
- **Definicoes simples:** em cada motor so ficam a vista o custo, os passos, o campo com titulo
  ("Chave da API:", texto de exemplo "Inserir API Key", `prefs.keyPlaceholder`) e o botao. Modelo,
  notas e limites ficam em "Opcoes avancadas". Sem "Copiar instrucoes": o texto seleciona-se e
  copia-se com Ctrl+C. Os comandos (PowerShell, Terminal) mantem o botao Copiar. Os blocos que
  abrem e fecham sao divs `.zia-pfold` (`.zia-pfold-head`, `.zia-pfold-body`, `initFolds`,
  `openFold`), nunca `<details>`: dentro de `<details>` as listas (select) nao abriam no Zotero.
  Nao usar o nome `zia-fold`, que e do painel. Titulos dos campos (`<label data-zia-label>`): o texto vai para
  DENTRO do elemento (`translate`), porque no Zotero um `<label>` nao mostra o atributo `label` (na 1.0.15 todos
  os titulos das definicoes estavam invisiveis). O `run_prefs.js` ja nao tem a regra CSS que mostrava esse
  atributo e confirma que todos os titulos tem texto. No IAEdu, "Apagar" limpa os tres campos e as prefs. Respostas e Creditos comecam abertas, Privacidade
  fechada. Sem "Acoes personalizadas" nas definicoes (estao no painel, separador Personalizado).
  "Procurar atualizacoes" esta no cartao dos Creditos.
- **Buy me a coffee** (`coffeeButton`, `SUPPORT_URL`, `SUPPORT_ENABLED` em `zoteroia.js`): botao
  amarelo com chavena desenhada em SVG, no rodape do painel e da janela (a esquerda) e no cartao dos
  Creditos. Abre a pagina de apoio `APOIAR.md` do GitHub (Ko-fi para cartao e MB WAY), que se
  muda sem versao nova. ESCONDIDO por agora (`SUPPORT_ENABLED: false`) ate a pagina existir com o
  nome do Ko-fi e o MB WAY. Nunca usar scripts de sites de pagamento (codigo de fora nao corre
  dentro do Zotero, que tem acesso total ao computador).
- **Separadores dos motores:** um por motor (IAEdu, Gemini, Claude API, ChatGPT API, Claude Pro/Max,
  ChatGPT conta), sem "Recomendado". O aberto fica com fundo azul claro, texto azul e barra azul por baixo
  (uma colega nao percebia qual estava aberto), e o nome do motor no "2. Configurar:" fica na mesma cor
  (`.zia-step-engine`). A estrela marca so o motor em uso. O resultado do teste (`#zia-test-result`) e
  movido para dentro do painel aberto, logo por baixo dos botoes (`refresh`), e nao no fim da pagina. Arrastar um separador muda a ordem (`tabOrder`, `moveTab`, pref
  `engines.tabOrder`).
- **Instrucoes de cada motor** (`GUIDES`, `renderGuides` em
  `preferences.js`, textos `guide.<motor>.*`): Claude Code, Codex, Claude API,
  ChatGPT API e IAEdu tem o mesmo bloco: "Quanto custa" e passos numerados com
  ligacoes oficiais e comandos com botao Copiar (o do Claude Code em versao Windows e
  Mac/Linux).
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
  openai, iaedu. A lista do painel mostra sempre `MAIN_ENGINES` (gemini, claude, codex)
  e as chaves de API so quando configuradas ou escolhidas. Nas definicoes,
  "Usar este motor" e um botao a parte. Gemini por omissao: `GEMINI_DEFAULT` = gemini-3.5-flash-lite
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
  ids estaveis `custom:<nome>`). Botao "+ Artigos" (so na janela) abre o seletor (ver acima:
  `pickableItems(limit, source)`, toda a biblioteca `Zotero.Items.getAll` ou uma colecao, "Juntar a colecao
  toda" `_addWholeCollection`). Ja nao ha botao "+ Colecao" (o `_openCollectionPicker` fica para o menu das colecoes).
  Uma acao que precisa de mais PDFs (Comparar) abre o seletor.
- **Enviar so com o botao:** Enter na caixa de texto muda de linha, nunca envia.
  Enviar com a caixa vazia mostra um aviso. O seletor "+ Artigos" ordena por data de
  adicao (omissao), autor ou data de publicacao.
- **Acoes em dois passos:** clicar numa acao so a escolhe (`selectAction`); o
  pedido segue com "Enviar" (o mesmo botao das perguntas, no painel e na janela),
  com indicacoes opcionais. Acoes ja pedidas levam um visto e
  escolher uma acao ja feita mostra a resposta existente.
- **Registo e PDF = uma conversa:** `conversationItem` (zoteroia.js) faz um PDF dentro de um registo
  usar o registo (sessao, historico e notas), se for o PDF que o registo daria (`resolvePDF`).
  Outros PDFs do mesmo registo ficam com a sua conversa. O historico guardado antes com o PDF
  selecionado junta-se ao do registo uma vez (`showItem`). Ao recuperar, nunca abre num separador
  sem respostas.
- **Historico por artigo:** `saveConversation`/`loadConversation` guardam as
  mensagens (sem o texto dos PDFs) em
  `<pasta de dados do Zotero>/zoteroia/conversas/<biblioteca>_<chave>.json`.
  Varias conversas por artigo. Pref `history.save` (ligada por omissao), botao para apagar nas definicoes.
  A escrita passa por um ficheiro `.tmp` (`tmpPath`): fechar o Zotero a meio nao estraga o historico.
- **Modelos Claude:** API com `claude-sonnet-5-5` por omissao (tambem quando a pref tem um nome
  invalido) e esforco `medium` (`output_config.effort`) nos modelos Sonnet, Opus e Haiku 5. Lista:
  Sonnet 5.5, Opus 5.5 e Haiku 5.5 (o Haiku 4.5 saiu: e 10 vezes mais caro). O Haiku nao tem reserva
  no servidor (`fallbacks`), so o Opus 5, Sonnet 5.5 e Fable. Claude Code
  com o nome curto `sonnet`, que aponta sempre para o mais recente.
- **Atualizacoes:** `update_url` do manifest aponta para
  `releases/latest/download/updates.json` do GitHub. `build.py` gera o
  `updates.json` com o sha256 do `.xpi`. A acao
  `.github/workflows/release.yml` publica a release sozinha quando o `main` recebe
  uma versao nova do `manifest.json` (cria a etiqueta `v<versao>`; se ja existir, nao
  faz nada). Esta sessao nao consegue enviar etiquetas, por isso nao ha etiquetas
  manuais. As atualizacoes automaticas so funcionam com o repositorio publico. Botao "Procurar
  atualizacoes agora" (`checkForUpdates`, AddonManager).
- **Aviso de versao nova** (a pedido): 30 s depois de arrancar, `refreshUpdateState` confirma no
  maximo uma vez a cada 20 h (pref `update.lastCheck`) com `findUpdates` SEM instalar e guarda
  `update.available` (versao) e `update.state` (available, ou restart se o Zotero ja a descarregou,
  `addon.pendingUpgrade`). A roda dentada do painel e da janela (`_gearButton`, observa as prefs)
  fica verde com um ponto (`.zia-has-update`) e o tooltip diz a versao. Nas definicoes aparece
  `#zia-update-banner` no topo com "Atualizar agora" (usa o `checkForUpdates`). Uma versao igual
  ou mais antiga que a instalada apaga o aviso (`_compareVersions`, `Services.vc`).
- **Contas gratuitas:** ChatGPT (Codex) e Gemini funcionam com contas
  gratuitas. A conta gratuita do Claude nao da acesso ao Claude Code nem a API.

## Testes

Antes de testar, instalar as dependencias do harness:

```
cd tests/harness
npm install
```

- `node --test tests/lib.test.js` — testes unitarios puros (44), incluindo
  a paridade PT-PT/ingles
- `node tests/harness/run_anthropic.js` — motor Claude API contra um
  servidor SSE simulado no formato oficial da Anthropic, e cofre de chaves
  (OSKeyStore, gestor de credenciais, migracao da 0.1)
- `node tests/harness/run_openai.js` — motor ChatGPT API contra um servidor
  simulado no formato oficial da OpenAI, e motor Codex com um Codex falso
  (`tests/harness/fake_codex/`, inclui um `.cmd` igual ao do npm)
- `node tests/harness/run_iaedu.js` — motor IAEdu contra um servidor simulado no formato
  real observado (pedido multipart, blocos JSON, erros, endereco de fora recusado)
- `node tests/harness/run_gemini.js` — motor Gemini contra um servidor SSE
  simulado no formato oficial da Google
- `node tests/harness/run_ui.js` — testes de interface com Playwright; no
  Windows usa o Edge instalado (ou `PW_CHROMIUM=<caminho>`); capturas em
  `tests/harness/out/`
- `node tests/harness/run_prefs.js` — converte `preferences.xhtml` para HTML e
  carrega em todos os botoes, separadores e ligacoes das definicoes (cada um tem
  de fazer alguma coisa e nenhum pode dar erro). O `run_ui.js` faz o mesmo para
  os botoes do painel
- `ONLY=<acoes>` corre so essas acoes (ex.: `ONLY=pergunta,critica`).
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

Gera `dist/assistente-ia-1.0.17.xpi` e `dist/updates.json`. O `.xpi` fica pronto a instalar em
**Ferramentas -> Plugins -> Install Plugin From File...**

## Licenca e documentacao publica

Licenca AGPL-3.0 (`LICENSE`, titular Sergio Bernardo). `README.md` (ingles, para quem vai usar o plugin) e
`GUIA.md` (guia rapido em portugues) sao publicos e nao mencionam a Anthropic nem o Claude, a pedido. O
`CLAUDE.md` e so de trabalho. A descricao do `manifest.json` tambem nao menciona o Claude. Os motores do
Claude continuam no plugin (definicoes e lista de motores). A descricao e as etiquetas (topics) do
repositorio no GitHub mudam-se na pagina do repositorio (esta sessao nao tem permissao).

## Creditos

Sergio Bernardo (sem email por agora). O repositorio e publico: os commits ficam em nome
do utilizador, "SBHG" com o email da conta dele (`git -c user.name=SBHG -c user.email=<email> commit`),
sem linhas Co-Authored-By nem Claude-Session. Versoes novas: subir a versao no
`manifest.json` e enviar para o `main` (a acao do GitHub cria a release com o `.xpi`). Grupo "Creditos" no fim das definicoes
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
- Nas explicacoes e nos textos de commit, manter linguagem simples e direta
