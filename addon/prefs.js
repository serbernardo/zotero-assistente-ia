/* Preferências por omissão do Assistente IA */
// Motor escolhido: "anthropic", "claude" (Claude Code), "openai", "codex" (conta ChatGPT) ou "gemini". Vazio até à configuração.
pref("extensions.zoteroia.engine", "");
// Língua da interface: "auto" (a do Zotero), "pt-PT" ou "en"
pref("extensions.zoteroia.ui.lang", "auto");
// Língua das respostas: "ui" (a mesma da interface), "pt-PT", "en", "auto" (a do documento)...
pref("extensions.zoteroia.context.annotations", false);
pref("extensions.zoteroia.fichas.autoSave", true);
pref("extensions.zoteroia.custom.prompts", "");
// Guardar as conversas de cada artigo neste computador (pasta de dados do Zotero)
pref("extensions.zoteroia.history.save", true);
pref("extensions.zoteroia.ui.group", "compreender");

// Claude com chave da API da Anthropic (a chave fica encriptada, nunca em texto simples)
pref("extensions.zoteroia.anthropic.key", "");
pref("extensions.zoteroia.anthropic.model", "claude-sonnet-5-5");
pref("extensions.zoteroia.anthropic.maxChars", 400000);

// Claude com a subscrição, através do Claude Code instalado no computador
pref("extensions.zoteroia.claude.enabled", false);
pref("extensions.zoteroia.claude.path", "");
pref("extensions.zoteroia.claude.model", "sonnet");
pref("extensions.zoteroia.claude.ignoreApiKey", true);
pref("extensions.zoteroia.claude.maxChars", 600000);

// ChatGPT com chave da API da OpenAI (a chave fica encriptada)
pref("extensions.zoteroia.openai.key", "");
pref("extensions.zoteroia.openai.model", "gpt-6-sol");
pref("extensions.zoteroia.openai.maxChars", 400000);

// ChatGPT com a conta do utilizador (gratuita ou paga), através do Codex
pref("extensions.zoteroia.codex.enabled", false);
pref("extensions.zoteroia.codex.path", "");
pref("extensions.zoteroia.codex.model", "");
pref("extensions.zoteroia.codex.maxChars", 400000);

// Gemini com chave da API do Google (a chave fica encriptada)
pref("extensions.zoteroia.gemini.key", "");
pref("extensions.zoteroia.gemini.model", "gemini-3.5-flash-lite");
// Modelo para tarefas exigentes (avaliar, comparar, investigar): "auto", "off" ou o nome de um modelo
pref("extensions.zoteroia.gemini.modelStrong", "auto");
// Aplicado uma vez: passa o modelo Gemini para o novo modelo por omissão (versão 0.4.1)
pref("extensions.zoteroia.gemini.defaultApplied", false);
pref("extensions.zoteroia.gemini.maxChars", 400000);

// IAEdu: chave (encriptada), endereço do agente e identificador do canal
pref("extensions.zoteroia.iaedu.key", "");
pref("extensions.zoteroia.iaedu.endpoint", "");
pref("extensions.zoteroia.iaedu.channel", "");
pref("extensions.zoteroia.iaedu.maxChars", 300000);

// Resultado do último teste nas definições, por motor: "", "ok" ou "fail"
pref("extensions.zoteroia.anthropic.lastTest", "");
pref("extensions.zoteroia.claude.lastTest", "");
pref("extensions.zoteroia.openai.lastTest", "");
pref("extensions.zoteroia.codex.lastTest", "");
pref("extensions.zoteroia.gemini.lastTest", "");
pref("extensions.zoteroia.iaedu.lastTest", "");

// Aviso de privacidade aceite, por motor
pref("extensions.zoteroia.privacy.ack.anthropic", false);
pref("extensions.zoteroia.privacy.ack.claude", false);
pref("extensions.zoteroia.privacy.ack.openai", false);
pref("extensions.zoteroia.privacy.ack.codex", false);
pref("extensions.zoteroia.privacy.ack.gemini", false);
pref("extensions.zoteroia.privacy.ack.iaedu", false);
// Ícone do assistente já colocado a seguir à Info (só uma vez)
pref("extensions.zoteroia.sidenav.placed", false);
// Estilo das citações ao copiar e nas notas: "" = formato simples, ou o id de um estilo do Zotero
pref("extensions.zoteroia.cite.style", "");
// Ordem dos separadores dos motores nas definições (arrastar para mudar)
pref("extensions.zoteroia.engines.tabOrder", "");
