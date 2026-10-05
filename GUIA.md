# Assistente IA para Zotero

*English summary at the end.*

Addon para o Zotero que ajuda a **ler, avaliar e comparar artigos científicos** com a **tua própria conta de IA**, gratuita ou paga: **Gemini**, **ChatGPT**, **Claude** ou o **IAEdu** da tua instituição. Todas as respostas citam a página do PDF, e cada citação abre o PDF nessa página. A interface está em **português de Portugal** e em **inglês**.

**Só os teus PDFs, nada inventado.** A IA é instruída a usar apenas o texto dos PDFs, sem conhecimento geral nem suposições, e a dizer quando algo não consta. Depois, o próprio addon **verifica cada resposta** contra o texto dos PDFs: confirma que os excertos entre aspas existem mesmo e na página citada, que as páginas citadas existem, que os números aparecem nos PDFs e que as contas estão certas. O que não bate certo aparece num aviso por baixo da resposta.

## Instalação

1. Descarrega o ficheiro `.xpi` mais recente em **[Releases](https://github.com/serbernardo/zotero-assistente-ia/releases/latest)**
2. No Zotero: **Ferramentas → Plugins**
3. Roda dentada → **Install Plugin From File…** e escolhe o ficheiro

Precisa do Zotero 8 ou superior. Depois de instalado, o addon atualiza-se sozinho, ou com o botão **Procurar atualizações agora** nas definições.

## O que faz

### No painel lateral de cada artigo

O ícone do assistente fica logo a seguir à Info. As ações estão organizadas em separadores:

| Separador | Ações |
|---|---|
| **Compreender** | Resumo, Pontos-chave, Explicação simples (sem jargão), Conceitos (glossário com as definições dos autores), Esquema do argumento (índice de temas com páginas em teses, relatórios e livros) |
| **Avaliar** | Avaliação crítica (tipo de estudo e grelha adequada, como CONSORT, STROBE, PRISMA, COREQ ou CASP), Métodos e dados (com tabela dos resultados numéricos), Afirmações e evidência (separa dados de interpretações e mostra as afirmações com pouco suporte) |
| **Extrair** | Ficha de leitura (14 campos, guardada como nota), Excertos citáveis (citações literais com página), Revisão de literatura, Palavras-chave (do autor e do texto, adicionadas ao item como etiquetas com um clique) |
| **Investigar** | Lacunas de investigação, Perguntas de investigação (com desenho de estudo sugerido) |
| **Personalizado** | As tuas próprias ações, criadas, editadas e eliminadas no painel |

Também podes fazer **perguntas livres** sobre o artigo. Cada ação e cada pergunta abre o seu separador de conversa, e as conversas ficam guardadas por artigo.

### Na janela de comparação (vários PDFs)

Abre-se com o ícone de janela no título do painel, com **Comparar** no painel ou com o clique direito numa coleção.

- **+ PDF** e **+ Coleção**: junta artigos da biblioteca ou uma coleção inteira, sem a teres de selecionar antes
- **Comparar**: Visão geral, Métodos, Resultados, Conceitos e teorias, Síntese para revisão
- **Seleção por critérios**: escreves os critérios de inclusão e de exclusão e, para cada artigo, a IA verifica critério a critério, com a página, e sugere Incluir, Excluir ou Duvidoso. No fim junta um resumo que se exporta para CSV
- **Usar fichas**: com muitos PDFs, trabalha sobre as fichas de leitura de cada artigo em vez do texto completo. Gasta muito menos e evita misturar artigos. Liga-se sozinho a partir de 6 PDFs

### Em todas as respostas

- Citações clicáveis que abrem o PDF na página
- **Copiar** e **Guardar como nota** com as citações no formato (Autor, Ano, p. X), ou no **estilo de citação do Zotero** que escolheres (APA, Chicago, ABNT e outros)
- **Exportar tabela (CSV)** para o Excel
- **Repetir com** outro motor configurado
- Eliminar uma resposta, com aviso e a opção de a guardar antes como nota

## Línguas

- **Interface:** português de Portugal ou inglês. Muda-se com o botão **PT / EN** no título do painel, ou nas definições
- **Respostas:** sempre na língua da interface

## Escolher a IA (uma vez)

Abre **Editar → Definições** (Windows) ou **Zotero → Settings** (macOS) → **Assistente IA**. Basta configurar **uma** opção. Cada motor tem os passos com as ligações oficiais, os comandos com um botão **Copiar** e um botão **Copiar instruções**, para enviares os passos a um colega. O botão **Testar** faz um pedido real curto e mostra se o motor está pronto.

**Recomendado: chave da API do Claude ou do ChatGPT.** É a forma mais rápida e fiável: não instala nada e fica pronta em cerca de 2 minutos. Tem um **custo mínimo de 5 $** (o primeiro carregamento de crédito). Depois pagas só o que usares, em regra alguns cêntimos por pedido sobre um artigo.

| Opção | Conta | Custo | O que é preciso |
|---|---|---|---|
| **Claude, chave da API** ⭐ | Conta da API da Anthropic | Mínimo 5 $ de crédito, cerca de 100 pedidos | Criar uma chave em console.anthropic.com |
| **ChatGPT, chave da API** ⭐ | Conta da API da OpenAI | Mínimo 5 $ de crédito | Criar uma chave em platform.openai.com |
| **Gemini, chave da API** | Gratuita ou paga | Quota gratuita diária | Criar uma chave em aistudio.google.com |
| **Claude, subscrição** | Pro ou Max | Sem custos extra, conta para os limites da subscrição | Instalar o Claude Code e iniciar sessão uma vez |
| **ChatGPT, conta ChatGPT** | Gratuita ou paga | Sem custos extra, conta para os limites da tua conta | Instalar o Codex e iniciar sessão uma vez |
| **IAEdu** | Conta da tua instituição | Os limites do IAEdu e da tua instituição | Criar um agente e copiar o Endpoint da API, o ID do Canal e a Chave da API |

**Contas gratuitas:** as opções gratuitas são o **Gemini** e o **ChatGPT com conta gratuita (Codex)**. A conta gratuita do Claude não dá acesso ao Claude Code nem à API.

### Gemini com chave da API

1. Cria uma chave em https://aistudio.google.com/apikey
2. Nas definições, cola a chave e carrega em **Guardar e testar**
3. Por omissão usa o **Gemini 3.5 Flash-Lite**, que quase sempre responde. Em Avaliar e Investigar tenta primeiro um modelo que raciocina melhor e, se estiver sobrecarregado, passa logo ao Flash-Lite. As comparações usam sempre um modelo completo. O botão **Testar modelos agora** mostra que modelos estão a responder nesse momento

**Atenção:** na quota gratuita, a Google pode usar os pedidos e as respostas para melhorar os seus produtos. Com faturação ativa, isso não acontece.

### Claude com a subscrição (Claude Code)

Nas definições, o botão **Instalar e iniciar sessão** abre uma janela com o comando oficial. Em alternativa:

1. Instala o Claude Code: **Windows** (PowerShell) `irm https://claude.ai/install.ps1 | iex`, **macOS** `curl -fsSL https://claude.ai/install.sh | bash`
2. Num terminal **novo**, escreve `claude` e inicia sessão com a tua conta. Depois escreve `/exit`
3. Nas definições do Assistente IA, carrega em **Testar**

### ChatGPT com a tua conta (Codex)

1. Instala o Node.js (https://nodejs.org) se ainda não o tiveres
2. Num terminal: `npm install -g @openai/codex`
3. No mesmo terminal: `codex login` e entra com a tua conta ChatGPT
4. Nas definições do Assistente IA, carrega em **Testar**

O assistente corre o Codex **sem ferramentas**: numa pasta temporária vazia, só de leitura, e interrompe o pedido se o Codex tentar executar um comando, alterar ficheiros ou pesquisar na Internet.

### Claude ou ChatGPT com chave da API (recomendado, cerca de 2 minutos)

1. Adiciona 5 $ de crédito (cria conta se for preciso): Claude em https://console.anthropic.com/settings/billing, ChatGPT em https://platform.openai.com/settings/organization/billing/overview
2. Cria uma chave e copia-a: Claude em https://console.anthropic.com/settings/keys, ChatGPT em https://platform.openai.com/api-keys
3. Nas definições, separador **Claude ou ChatGPT (API)**, cola a chave e carrega em **Guardar e testar**

O crédito expira ao fim de um ano e não é reembolsável.

### IAEdu (agente da tua instituição)

1. Entra em https://iaedu.pt com a conta da tua instituição
2. Precisas de um agente. Se alguém da tua instituição te partilhou um, pede-lhe o **Endpoint da API** e o **ID do Canal** (nunca a chave dela) e salta para o passo 4. Se não, cria o teu: em **Agentes**, **Criar agente**, com um nome à tua escolha e a visibilidade em **Privado**. Nas instruções do agente basta uma linha, por exemplo: *Responde apenas com base no texto que receberes*
3. Na lista de modelos, carrega na roda dentada do modelo que o agente usa (por exemplo, GPT-5.5) e escolhe **Informação da API**. A roda dentada está no cartão do modelo, não no do agente
4. Copia os três valores: o **Endpoint da API** (com o identificador do teu agente, a terminar com `stream`), o **ID do Canal** e a **Chave da API**. A chave é pessoal e não se partilha
5. Nas definições do Assistente IA, separador **IAEdu**, cola os três valores e carrega em **Guardar e testar**. Se um agente partilhado falhar com a tua chave, cria o teu

O endpoint tem de ser do domínio iaedu.pt. A chave só é enviada para lá. Confirma as regras de uso do IAEdu e da tua instituição antes de enviares artigos.

## Segurança e privacidade

- **Chaves encriptadas:** as chaves de API ficam no cofre do sistema operativo ou, em alternativa, no gestor de credenciais do Zotero. Nunca em texto simples
- **Cada pessoa usa a sua conta:** o addon nunca vê nem guarda palavras-passe. Nos modos Claude Code e Codex, a sessão é iniciada pela própria pessoa no programa oficial
- **Só vai para onde escolheres:** o texto dos PDFs e as perguntas só são enviados ao motor escolhido, e só quando carregas em Enviar. O addon não tem servidor próprio e não recolhe dados
- **Aviso antes do primeiro envio:** na primeira vez com cada motor, o assistente explica o que vai ser enviado e pede confirmação
- **Proteção contra instruções escondidas nos PDFs:** o texto dos documentos é tratado como material para analisar, nunca como ordens
- **Respostas sem código ativo:** o texto da IA é mostrado sem HTML. As ligações só abrem se forem http ou https

Não envies documentos confidenciais, dados pessoais, dados não publicados ou PDFs cuja licença proíba o uso em serviços de IA.

## Limites e cuidados

- **Confirma sempre** as citações e os números antes de usar o texto. A verificação automática ajuda, mas não substitui a leitura
- **Páginas:** as citações usam a página do ficheiro PDF (1, 2, 3…), não a numeração impressa da revista
- **Só PDFs com texto:** PDFs digitalizados sem OCR não são suportados
- **Título do painel e menus:** seguem a língua do Zotero. O resto da interface segue a língua do addon

## Se algo falhar

- **"Falta a chave" ou "chave inválida":** volta a colar a chave nas definições
- **"Sem crédito":** adiciona crédito na conta da API (Billing)
- **"Não encontrei o Claude Code" ou "o Codex":** nas definições, carrega em **Detetar**, ou indica o caminho do programa
- **"Não tem sessão iniciada":** num terminal, `claude` (Claude Code) ou `codex login` (Codex)
- **Limite atingido:** usa **Repetir com** outro motor, ou espera
- **Outros erros:** **Ajuda → Debug Output Logging → Enable**, repete a ação e procura linhas "Assistente IA"

## Para quem desenvolve

- `python build.py` gera `dist/assistente-ia-<versão>.xpi`
- Testes em `tests/` (ver `CLAUDE.md`)

## Créditos

Sérgio Bernardo

---

## English summary

**AI Assistant for Zotero** helps you read, appraise and compare scientific papers with **your own AI account**, free or paid: **Gemini**, **ChatGPT**, **Claude** or your institution's **IAEdu**. Every answer cites the PDF page, and each citation opens the PDF at that page. The AI is told to use only the text of your PDFs, and the add-on then **checks every answer** against the PDFs: quotes, pages, numbers and calculations.

- **Side pane, one article:** Understand (summary, key points, plain-language summary, concepts, outline), Appraise (critical appraisal with the right checklist for the study type, methods and data, claims and evidence), Extract (reading sheet, quotable excerpts, literature review, keywords added as Zotero tags), Future research (research gaps, research questions), plus your own custom actions and free questions
- **Compare window, many PDFs:** overview, methods, results, concepts and theories, synthesis for review, and **screening by criteria** (include, exclude or unclear for each article, with a CSV summary). Add PDFs or a whole collection
- **Every answer:** clickable citations, copy and save as note in your Zotero citation style, CSV export, retry with another engine
- **Languages:** European Portuguese or English (PT / EN button in the pane header). Answers follow the interface language
- **Privacy:** API keys encrypted in the operating system key store. Documents are only sent to the engine you choose, after a one-time notice per engine. No server, no data collection

Install: download the latest `.xpi` from **[Releases](https://github.com/serbernardo/zotero-assistente-ia/releases/latest)**, then in Zotero **Tools → Plugins → gear → Install Plugin From File…** (Zotero 8 or later).
