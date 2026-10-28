<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="Estrelas no GitHub" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Última versão do Orca NP" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Licença: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Builds do Orca NP: macOS e Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.tr.md">Türkçe</a></sub>
</p>

<p align="center">
  <strong>🔱 Este é o <a href="#o-que-é-diferente-neste-fork">Orca NP</a> — um fork do <a href="https://github.com/stablyai/orca">stablyai/orca</a> com recursos, correções e versões próprios.</strong><br/>
  <sub>Instala-se ao lado do Orca oficial · <a href="https://github.com/nplez1/orca/releases/latest">Baixe o build mais recente do Orca NP</a> · <a href="#o-que-é-diferente-neste-fork">Veja o que é diferente ↓</a></sub>
</p>

<p align="center">
  <strong>O orquestrador de IA para builders 100x.</strong><br/>
  Rode Codex, ClaudeCode, OpenCode ou Pi lado a lado — cada um em seu próprio worktree, acompanhado em um só lugar.
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Baixar o Orca NP</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="App desktop do Orca executando agentes em worktrees paralelos, com o app companion móvel do Orca no canto" width="960" />
</p>

## O que é diferente neste fork

O Orca NP é o [stablyai/orca](https://github.com/stablyai/orca) mais uma série de recursos e correções exclusivos do fork. A lista de recursos do upstream abaixo continua valendo (exceto onde um build não é publicado aqui — veja [Instalação](#instalação)); isto é o que o Orca NP acrescenta por cima. A lista completa está nos [pull requests mesclados](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged), e a série de patches exclusivos do fork está documentada em [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md).

### Tarefas, issues e Jira

- **Visão de quadro do Jira** — escolha um quadro padrão e a aba do Jira mostra colunas, o sprint ativo e o backlog, com arrastar e soltar entre colunas, uma caixa de filtro e cores por prioridade.
- **O item fica na lane em que você solta** — soltar um item do Jira numa lane resolve a transição, pede os campos exigidos pela tela daquela transição e move o card antes de o Jira confirmar, desfazendo só se o Jira recusar.
- **Sprints, story points e campos personalizados** — mova um item do backlog para um sprint a partir da sua linha ou da gaveta da issue, defina ou limpe os story points ao lado de status, prioridade e responsável, e edite campos personalizados de seleção de usuário (Dev, QE) no detalhe da issue. Uma mudança de sprint feita na issue aberta recarrega o quadro.
- **"Me" casa com qualquer campo de função** — uma issue em que você é o Dev ou o QE, não apenas o responsável, agora aparece no filtro Me do quadro.
- **Seletor de responsável pesquisável** — com você e a sua equipe fixados no topo.
- **Issue vinculada na barra lateral direita** — um workspace criado a partir de uma issue do Jira, Linear ou GitHub ganha uma aba Issue com status, responsável, prioridade, labels, descrição e um botão Abrir. As issues do Jira também têm desvincular/revincular, uma caixa de comentários em Markdown ao vivo e exibem corretamente as descrições de Jira auto-hospedado (Server/Data Center). Uma issue do GitHub é lida do repo de onde ela veio, então um workspace em outro projeto ainda a carrega; quando esse repo não está nesta máquina, a aba avisa em vez de falhar.
- **Vincule um workspace a uma issue do Jira** por chave ou URL no diálogo de detalhes; a página de Tarefas mostra um chip de workspace anexado e abre o workspace existente em vez de criar um duplicado.

### Revisão de pull requests e CI

- **Comentários de PR do GitHub em linha** — os comentários aparecem sob a respectiva linha no editor, com responder, resolver e recolher (exibidos só quando o seu checkout corresponde ao commit head do PR).
- **Prontidão de merge num relance** — o ícone do PR mantém a cor da CI e acrescenta um ponto para aprovações pendentes, conflitos ou bloqueios, com o motivo no tooltip. Funciona com GitHub, GitLab, Bitbucket, Azure DevOps e Gitea.
- **Vereditos de revisão no painel de Checks** — Aprovado / Alterações solicitadas com o nome dos revisores, e o painel se atualiza quando a CI muda, em vez de esperar uma troca de aba.
- **Um painel de Checks ao vivo** — enquanto um run está em andamento, um painel aberto atualiza a cada 10s em vez de esperar a cadência de revisão, espaçando para 20s e depois 30s enquanto nada muda, e o seu veredito atualiza o card da barra lateral e os ícones da barra de atividades (GitHub).
- **Detalhes de builds do Jenkins** — expanda um check do Jenkins para ver suas etapas, qual está em execução ou falhou, e os dados do build.
- **Merge de admin em PRs que exigem revisão** — se a sua conta pode ignorar a proteção de branch, o Merge é oferecido após uma confirmação que informa o que será ignorado.

### Agentes

- **Resumos de sessão** — um relatório escrito de uma sessão de agente (atividade, objetivo, plano, bloqueios, linha do tempo) na barra lateral direita, com sua própria configuração de agente/modelo. Cobre também sessões do Pi, Copilot, OpenCode e Cursor; uma sessão num host pareado é resumida nesse host, e uma num destino SSH é resumida a partir da sua transcrição transmitida.
- **Status de agentes mais preciso** — as linhas do Pi não ficam mais presas em "Working" nem viram "Done" quando um sub-agente auxiliar termina; o Copilot CLI não pede mais a sua atenção para prompts aprovados automaticamente; um sub-agente do Grok aguardando a sua resposta mantém a linha em espera; e um painel restaurado em outro cliente descarta o aviso de "aguardando resposta" que o seu diálogo deixou para trás. Além disso, um sub-agente do Claude que uma sessão do Pi inicia pela CLI `claude` fica na linha dessa sessão do Pi (exige um plugin pi-subagents atualizado).
- **Os prompts do Copilot são lidos da tela** — uma aprovação de shell ou URL e o diálogo "Copilot needs information" aparecem como prompts em vez de um spinner, enquanto uma permissão que o CLI aprovou por conta própria fica em silêncio.
- **O foco permanece na aba do agente** — clicar num card da barra lateral, numa aba de atividades da barra lateral direita ou no fundo do painel devolve o teclado à aba do agente, e fechar um menu ou diálogo devolve o cursor também, para que a próxima tecla ainda signifique o que deveria.
- **A área de transferência acompanha o leitor** — uma cópia de um painel do Pi assistido de um cliente pareado cai também na área de transferência desse cliente, além da do host.
- **Agente padrão com um clique** — o botão `+` da barra de abas inicia o seu agente padrão; segure-o ou use a seta para abrir o menu completo.
- **Agent Dashboard como página** — abre na janela principal com voltar/avançar, e clicar num card abre o workspace daquele agente.
- **Histórico de sessões de agentes** — "All" agora lista todas as sessões, as sessões de sub-agentes ficam aninhadas sob a sessão pai, e a indexação de transcrições torna pesquisáveis as transcrições existentes. O histórico de um host pareado carrega em páginas e atualiza só o que mudou, então um histórico remoto grande chega em vez de falhar.
- **Acompanhamento de uso para mais provedores** — orçamentos de créditos de IA do Copilot Enterprise, saldo do DeepSeek e gasto do Fireworks.ai na barra de status, além de uma chave por provedor que interrompe o polling e a leitura de credenciais. Um login do Claude expirado é renovado a partir do refresh token armazenado, em vez de ficar em "Updates when Claude runs", e o login renovado é gravado de volta onde o Claude o guarda.

### Workspaces e organização

- **Uma pasta por projeto** — o checkout principal e todos os seus worktrees ficam juntos numa pasta com um `AGENTS.md` compartilhado; `orca repo relocate` move os checkouts existentes para lá.
- **Workspaces agrupados entre máquinas** — a mesma branch em dois hosts vira um único card com um menu suspenso de host; um workspace num host pareado lê a sua issue do GitHub e o PR a partir desse host, e o seu ponto de status para de girar quando os agentes do host terminarem.
- **Clientes pareados ficam em dia** — projetos e workspaces que um host adiciona ou remove, inclusive os criados na própria janela do host ou pela sua CLI, chegam aos seus clientes pareados sem precisar de uma atualização manual.
- **Filtro de status** — oculte os status escolhidos da barra lateral e do Cmd+J enquanto o quadro continua mostrando tudo.
- **Indicador "Setting up…"** enquanto o script de setup de um repo roda, inclusive em workspaces iniciados sem agente.
- **Modos de diretórios compartilhados** — link simbólico, clone APFS, cópia ou ignorar, para diretórios compartilhados entre worktrees.
- **Workspace flutuante** — uma pasta própria, uma alça de arrasto na barra de título e o mesmo controle de lançamento de agente da barra de abas principal.
- **Oculte hosts SSH importados automaticamente** dos seletores e da barra de status; os hosts ocultos continuam listados em Configurações.
- **Filtro de arquivos mais rápido e honesto** — o filtro por nome do Explore pesquisa o workspace inteiro a partir de um índice pré-construído e avisa quando os resultados são parciais, em vez de dizer "no files match".
- **Replicação de configurações entre hosts** _(base preparada)_ — as configurações e credenciais de provedores de uma máquina podem ser replicadas para hosts pareados.

### Ambientes efêmeros

Adições às receitas de ambiente por workspace do upstream (Settings → Experimental → Cloud VM):

- **Contagem regressiva da concessão e Extend** — uma receita que informa quando o provedor retira o host ganha uma contagem regressiva no card do workspace e em Configurações, e, se ela também declarar como estender, uma ação Extend limitada aos prazos que ela lista. Após o prazo, o card e as Configurações mostram a concessão como expirada; quando mais 15 minutos tiverem passado e a conexão do Orca com o host tiver falhado, o Orca remove o workspace da lista, e a máquina do provedor fica sujeita ao próprio vencimento ou ao Cleanup em Settings.
- **Itens de menu de contexto declarados na receita** — até 20 ações que uma receita declara ganham as suas próprias entradas no menu de contexto desse workspace e executam com o host, o nome e o caminho do workspace. São declaradas em `orca.yaml`, então ficam cobertas pela aprovação da receita, e uma receita que não declara nenhuma não acrescenta entradas.

### Confiabilidade

- Hooks do git e autenticação do ssh-agent funcionam quando o app empacotado é aberto pelo Dock, porque o git agora enxerga os exports do seu perfil de shell.
- As permissões de computer use no macOS não se dividem mais entre duas identidades do helper.
- Colar com o botão direito no Copilot CLI cola uma vez, não duas.
- Um diagnóstico opcional "Log UI hangs" grava registros de travamentos, com contexto de foco, suspensão e CPU, para ajudar a rastrear beachballs.

### Como roda

- **Identidade própria** — o Orca NP usa seu próprio app id (`com.nplez1.orca`), diretório de dados, diretório home (`~/.orca-np`) e CLI (`orca-np`), então instala e roda ao lado de um Orca oficial sem compartilhar estado.
- **Versões e atualizações próprias** — os builds são marcados `v<versão do upstream>-np.<n>` e o atualizador integrado segue as [versões deste repositório](https://github.com/nplez1/orca/releases), não as do upstream.
- **Assinatura** — os builds de macOS são assinados e notarizados; o instalador do Windows não é assinado, então o SmartScreen avisa uma vez na instalação.
- **Sem telemetria** — as notas da versão informam que os builds não enviam diagnósticos nem dados de uso.
- **Skills apontam para este app** — os skills incluídos e os stubs publicados chamam `orca-np` (e `orca-np-dev` em desenvolvimento) em vez de cair num `orca` de uma instalação oficial.
- **Perfil novo** — o Orca NP não consegue ler os repos, credenciais nem dispositivos pareados de uma instalação oficial do Orca; essa separação é proposital, então pareie o seu celular com o Orca NP separadamente.
- **Acompanha o upstream** — o `main` do upstream é mesclado regularmente (o procedimento está em [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)), então o fork também recebe os recursos e correções do upstream.

---

## Recursos

A lista de recursos abaixo é a do Orca upstream; seus links "Docs" levam à documentação do upstream em onorca.dev, que não cobre os recursos exclusivos do fork acima.

<table>
<tr>
<td width="50%" valign="middle">

### Companion móvel

Monitore e conduza seus agentes pelo celular — receba uma notificação quando um agente terminar e envie instruções de acompanhamento de qualquer lugar.

[App Store para iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [APK Android](https://www.onorca.dev/download/android) · [Docs →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca desktop com o app companion móvel" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees paralelos

Envie um mesmo prompt para cinco agentes, cada um em seu próprio worktree git isolado — compare os resultados e faça merge do vencedor.

[Docs →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="Orquestração de worktrees paralelos" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminais divididos

Terminais no nível do Ghostty com renderização WebGL, divisões infinitas e scrollback que sobrevive a reinicializações.

[Docs →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Terminais divididos" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Modo Design

Clique em qualquer elemento de UI em uma janela real do Chromium para enviar HTML, CSS e uma captura recortada direto para o prompt do seu agente.

[Docs →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Navegador integrado e Modo Design" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub e Linear nativos

Navegue por PRs, issues e quadros de projeto dentro do app — abra um worktree a partir de qualquer tarefa e revise sem trocar de contexto.

[Docs →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Fluxos de trabalho de tarefas do GitHub e Linear no Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees por SSH

Execute agentes em uma máquina remota potente com edição completa de arquivos, git e terminais — com reconexão automática e encaminhamento de portas incluídos.

[Docs →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Worktrees remotos por SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Anotar diffs de IA

Deixe comentários em qualquer linha de diff e envie-os de volta ao agente — revise, edite e faça commit sem sair do Orca.

[Docs →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Anotar diffs gerados por IA" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Arraste arquivos para agentes

O editor do VS Code com salvamento automático em todos os lugares — arraste arquivos ou imagens direto para o prompt de um agente.

[Docs →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Arraste arquivos e imagens para o prompt de um agente" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Agentes também controlam o Orca — automatize qualquer fluxo de trabalho com `orca worktree create`, `snapshot`, `click` e `fill`.

[Docs →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Automatize o Orca pela CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Também incluído:**

- **[Abertura rápida](https://www.onorca.dev/docs/model/quick-open)** — Pesquise entre worktrees, arquivos, agentes, comandos e contexto do repositório sem sair do seu fluxo.
- **[Troca de contas e acompanhamento de uso](https://www.onorca.dev/docs/agents/usage-tracking)** — Veja o uso de Claude e Codex, os reinícios de limites e troque contas instantaneamente sem fazer login de novo.
- **[Prévias ricas do repositório](https://www.onorca.dev/docs/editing/markdown)** — Pré-visualize Markdown, imagens, PDFs e documentos do repositório no workspace.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Deixe agentes operarem apps de desktop e UI visível quando um fluxo de trabalho precisa de interação real.
- **[Notificações e estado de não lido](https://www.onorca.dev/docs/notifications)** — Saiba quando um agente termina ou precisa de atenção, depois marque conversas como não lidas para voltar depois.
- **E muito, muito mais** — lançamos todos os dias, então esta lista está sempre atrasada. As [versões do Orca NP](https://github.com/nplez1/orca/releases) são a lista de recursos de verdade deste fork, e as [do upstream](https://github.com/stablyai/orca/releases) são a de tudo o que ele herda.

---

## Agentes compatíveis

Funciona com **qualquer agente CLI** — se roda em um terminal, roda no Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Logotipo do Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Logotipo do Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Logotipo do Grok" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Logotipo do Cursor" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="Logotipo do GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Logotipo do Muse" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="Logotipo do ZCode" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="Logotipo do OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="Logotipo do MiMo Code" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Logotipo do Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="Logotipo do OpenClaude" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Logotipo do Antigravity" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Logotipo do Pi" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="Logotipo do oh-my-pi" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Logotipo do Hermes Agent" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Logotipo do Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Logotipo do Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Logotipo do Auggie" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Logotipo do Autohand Code" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Logotipo do Charm" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Logotipo do Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Logotipo do Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Logotipo do Freebuff" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Logotipo do Command Code" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Logotipo do Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Logotipo do Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Logotipo do Kilocode" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Logotipo do Kimi" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Logotipo do Kiro" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Logotipo do Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Logotipo do Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Logotipo do Rovo Dev" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ qualquer agente CLI</kbd>
</p>

---

## Instalação

### Desktop — macOS, Windows

- **[Baixe a versão mais recente do Orca NP](https://github.com/nplez1/orca/releases/latest)**
- Ou baixe um build diretamente: [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [Todos os builds](https://github.com/nplez1/orca/releases)

O Orca NP se instala ao lado de um Orca oficial e se atualiza a partir das versões deste repositório. Este fork não publica build para Linux nem pacote Homebrew/AUR — no Linux, [compile a partir do código-fonte](../../.github/CONTRIBUTING.md) ou use o [Orca upstream](https://github.com/stablyai/orca/releases/latest).

### Companion móvel — iOS, Android

Pareie o app móvel do Orca com o Orca NP para monitorar e conduzir seus agentes pelo celular. Os apps são publicados pelo Orca upstream e funcionam com o Orca NP.

- **iOS:** [Baixar na App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Baixar APK](https://www.onorca.dev/download/android)

---

## Comunidade e suporte

- **Issues e ideias do Orca NP:** [Abra uma issue](https://github.com/nplez1/orca/issues) para qualquer coisa específica deste fork.
- **Comunidade upstream:** os canais do Orca upstream cobrem tudo o que este fork herda — [Discord](https://discord.gg/fzjDKHxv8Q), [@orca_build no X](https://x.com/orca_build) e as [issues do upstream](https://github.com/stablyai/orca/issues) para bugs que também se reproduzem no Orca oficial.
- **Docs:** [onorca.dev/docs](https://www.onorca.dev/docs) documenta o Orca upstream.
- **Mostre seu apoio:** Dê uma [estrela](https://github.com/nplez1/orca) neste repo para acompanhar o fork, ou no [upstream](https://github.com/stablyai/orca).

---

## Desenvolvimento

Quer contribuir ou rodar localmente? Veja nosso guia [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Contribuidores do Orca" />
</a>

## Licença

Orca é livre e de código aberto sob a [Licença MIT](../../LICENSE).
