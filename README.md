# Assistente IA para Zotero (versão 0.4)

*English summary at the end.*

Addon para o Zotero que ajuda a ler, avaliar e escrever a partir de artigos científicos. Funciona com a **tua própria conta de IA**, gratuita ou paga: **Claude**, **ChatGPT** ou **Gemini**. Todas as respostas citam a página do PDF, e cada citação abre o PDF nessa página. A interface está em **português de Portugal** e em **inglês**.

## O que faz

No **painel lateral de cada artigo** e no **leitor de PDF** (ícone de estrelas à direita), as ações estão organizadas em separadores:

| Separador | Ações |
|---|---|
| **Compreender** | Resumir, Pontos-chave, Explicar simples (sem jargão), Conceitos (glossário com as definições dos autores), Esquema do argumento |
| **Avaliar** | Avaliação crítica (pontos fortes, fragilidades, riscos de enviesamento, qualidade da evidência), Método e dados (com tabela dos resultados numéricos), Conclusões |
| **Escrever** | Ficha de extração, Excertos citáveis (citações literais com página), Revisão de literatura (texto corrido por temas), Sugerir etiquetas (adiciona tags ao item com um clique) |
| **Investigar** | Lacunas de investigação, Novas perguntas de investigação (com desenho de estudo sugerido) |
| **Comparar** | Visão geral, Métodos, Resultados, Conceitos e teorias, Síntese para revisão (abre sozinho quando juntas 2 PDFs) |
| **Personalizado** | As tuas próprias ações, criadas e editadas no painel |

Também podes fazer **perguntas livres**, em conversa. Quando o painel está vazio, aparecem sugestões de perguntas úteis.

Na **janela do assistente** (vários PDFs ao mesmo tempo):

- **+ Selecionados** e **+ Coleção**: junta os artigos selecionados ou uma coleção inteira
- **Usar fichas**: com muitos PDFs, cria uma ficha de extração por artigo (nota "Ficha IA"), reutiliza as que já existem e trabalha sobre as fichas. Gasta muito menos e evita cortes. Liga-se sozinho a partir de 6 PDFs

**Só os teus PDFs, nada inventado.** A IA é instruída a usar apenas o texto dos PDFs, sem conhecimento geral nem suposições, e a dizer quando algo não consta. Depois, o próprio addon **verifica cada resposta** contra o texto dos PDFs: confirma que os excertos entre aspas existem mesmo (e na página citada), que as páginas citadas existem, que os números aparecem nos PDFs e que as contas estão certas. O que não bate certo aparece num aviso por baixo da resposta.

Em **todas as respostas**: citações clicáveis, **Guardar como nota**, **Exportar tabela (CSV)** para o Excel, **Copiar** com as citações no formato (Autor, Ano, p. X) e **Repetir com** outro motor configurado.

## Línguas

- **Interface:** português de Portugal ou inglês. Por omissão segue a língua do Zotero. Muda-se em **Definições → Assistente IA → Língua da interface**
- **Respostas:** por omissão, na mesma língua da interface. Também podes escolher português do Brasil, espanhol, francês, alemão ou a língua do documento

## Instalação

1. No Zotero: **Ferramentas → Plugins**
2. Roda dentada → **Install Plugin From File…**
3. Escolhe o ficheiro `assistente-ia-0.6.7.xpi`

Precisa do Zotero 8 ou superior.

## Escolher a IA (uma vez)

Abre **Editar → Definições** (Windows) ou **Zotero → Settings** (macOS) → **Assistente IA**. Basta configurar **uma** opção. Enquanto nada estiver configurado, o painel mostra o cartão "Liga o assistente a uma IA".

| Opção | Conta | Custo | O que é preciso |
|---|---|---|---|
| **ChatGPT, conta ChatGPT** | Gratuita ou paga (Plus, Pro…) | Sem custos extra, conta para os limites da tua conta | Instalar o Codex e iniciar sessão uma vez |
| **Gemini, chave da API** | Gratuita ou paga | Quota gratuita diária | Criar uma chave em aistudio.google.com |
| **Claude, subscrição** | Pro ou Max | Sem custos extra, conta para os limites da subscrição | Instalar o Claude Code e iniciar sessão uma vez |
| **Claude, chave da API** | Conta da API da Anthropic | Pagas o que usares (cêntimos por pedido) | Criar uma chave em console.anthropic.com |
| **ChatGPT, chave da API** | Conta da API da OpenAI | Pagas o que usares | Criar uma chave em platform.openai.com |

**Nota sobre contas gratuitas:** a conta gratuita do Claude não dá acesso ao Claude Code nem à API. As subscrições ChatGPT Plus ou Pro não incluem crédito de API (para as usar, escolhe a opção Codex). As opções verdadeiramente gratuitas são o **ChatGPT com conta gratuita (Codex)** e o **Gemini**.

### ChatGPT com a tua conta (Codex)

1. Instala o Node.js (https://nodejs.org) se ainda não o tiveres
2. Num terminal: `npm install -g @openai/codex`
3. No mesmo terminal: `codex login` e entra com a tua conta ChatGPT
4. Nas definições do Assistente IA, secção ChatGPT com a tua conta, carrega em **Testar e ativar**

O assistente corre o Codex **sem ferramentas**: numa pasta temporária vazia, com permissões só de leitura, e interrompe o pedido se o Codex tentar executar um comando, alterar ficheiros ou pesquisar na Internet.

### Gemini com chave da API

1. Cria uma chave em https://aistudio.google.com/apikey
2. Nas definições, cola a chave e carrega em **Guardar e testar**
3. Por omissão usa o **Gemini 3.5 Flash-Lite**, que quase sempre responde. Para Avaliar, Comparar e Investigar tenta primeiro um modelo que raciocina melhor (por exemplo o 3.7 Flash). Se estiver sobrecarregado, passa logo ao Flash-Lite, sem esperas. O botão **Testar modelos agora** mostra quais modelos estão a responder nesse momento

**Atenção:** na quota gratuita, a Google pode usar os pedidos e as respostas para melhorar os seus produtos. Com faturação ativa, isso não acontece.

### Claude com a subscrição (Claude Code)

1. Instala o Claude Code: **Windows** (PowerShell) `irm https://claude.ai/install.ps1 | iex`, **macOS** `curl -fsSL https://claude.ai/install.sh | bash`
2. Num terminal **novo**, escreve `claude` e inicia sessão com a tua conta. Depois escreve `/exit`
3. Nas definições do Assistente IA, carrega em **Testar e ativar**

### Claude ou ChatGPT com chave da API

1. Cria conta em https://console.anthropic.com (Claude) ou https://platform.openai.com (ChatGPT)
2. Em **Billing**, adiciona crédito. Em **API Keys**, cria uma chave
3. Nas definições, cola a chave e carrega em **Guardar chave**. O teste é automático
4. Escolhe o modelo. Cada resposta mostra os tokens gastos

## Segurança e privacidade

- **Chaves encriptadas:** as chaves de API ficam no cofre do sistema operativo (Windows, macOS, Linux com libsecret) ou, em alternativa, no gestor de credenciais do Zotero. Nunca em texto simples
- **Cada pessoa usa a sua conta:** o addon nunca vê nem guarda palavras-passe. Nos modos Claude Code e Codex, a sessão é iniciada pela própria pessoa no programa oficial
- **Só vai para onde escolheres:** o texto dos PDFs e as perguntas só são enviados ao motor escolhido, e só quando carregas num botão. O addon não tem servidor próprio e não recolhe dados
- **Aviso antes do primeiro envio:** na primeira vez com cada motor, o assistente explica o que vai ser enviado e pede confirmação
- **Proteção contra instruções escondidas nos PDFs:** o texto dos documentos é tratado como material para analisar, nunca como ordens. Um PDF não consegue imitar as marcas internas do pedido
- **Sem ferramentas:** Claude Code e Codex correm sem acesso a comandos, ficheiros ou Internet
- **Respostas sem código ativo:** o texto da IA é mostrado sem HTML. As ligações só abrem se forem http ou https
- **Apagar tudo:** nas definições, **Apagar todas as chaves guardadas**

Não envies documentos confidenciais, dados pessoais sensíveis ou PDFs cuja licença proíba o uso em serviços de IA.

## Limites e cuidados

- **Páginas:** as citações usam a página do ficheiro PDF (1, 2, 3…), não a numeração impressa da revista
- **Confirma sempre** as citações antes de usar o texto
- **Só PDFs com texto:** PDFs digitalizados sem OCR ainda não são suportados
- **Menus de contexto:** seguem a língua do Zotero (o resto da interface segue a definição do addon)

## Se algo falhar

- **"Falta a chave" ou "chave inválida":** volta a colar a chave nas definições
- **"Sem crédito":** adiciona crédito na conta da API (Billing)
- **"Não encontrei o Claude Code" ou "o Codex":** nas definições, carrega em **Detetar**, ou indica o caminho do programa
- **"Não tem sessão iniciada":** num terminal, `claude` (Claude Code) ou `codex login` (Codex)
- **Limite atingido:** usa **Repetir com** outro motor, ou espera
- **Outros erros:** **Ajuda → Debug Output Logging → Enable**, repete a ação e procura linhas "Assistente IA"

## Partilhar com outras pessoas

Envia o ficheiro `.xpi` (por exemplo, das Releases do repositório). Cada pessoa configura a sua própria conta. Nada da tua configuração vai no ficheiro.

## Para quem desenvolve

- `python build.py` gera `dist/assistente-ia-<versão>.xpi`
- Testes e arquitetura: ver `CLAUDE.md`

---

## Créditos

Sérgio Bernardo

## English summary

AI Assistant for Zotero helps you read, appraise and write from scientific papers, with **your own AI account**, free or paid: **Claude**, **ChatGPT** or **Gemini**. Every answer cites the PDF page and each citation opens the PDF at that page. The interface is available in **European Portuguese** and **English** (Settings → AI Assistant → Interface language; by default it follows Zotero's language).

Actions: summarise, key points, plain explanation, concepts, outline, critical appraisal, methods and data, conclusions, extraction sheet, quotable excerpts, literature review draft, tag suggestions, PDF comparison, research gaps, new research questions, plus your own custom prompts. Free-form questions, notes with page links, CSV export.

AI options: ChatGPT with a free or paid ChatGPT account (through OpenAI's Codex CLI), Gemini API key (free tier), Claude Pro or Max subscription (through Claude Code), or Claude or OpenAI API keys (pay as you go). API keys are encrypted in the operating system key store. Documents are only sent to the engine you choose, after a one-time privacy notice per engine. Install the `.xpi` via **Tools → Plugins → Install Plugin From File…** (Zotero 8 or later).
