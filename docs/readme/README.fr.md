<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://badgen.net/github/stars/nplez1/orca?label=%E2%98%85" alt="Étoiles GitHub" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Dernière version d'Orca NP" /></a>
  <img src="https://badgen.net/github/license/nplez1/orca" alt="Licence" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Builds d'Orca NP : macOS et Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.ru.md">Русский</a></sub>
</p>

<p align="center">
  <strong>🔱 Voici <a href="#ce-qui-change-dans-ce-fork">Orca NP</a> — un fork de <a href="https://github.com/stablyai/orca">stablyai/orca</a> avec ses propres features, correctifs et releases.</strong><br/>
  <sub>S'installe à côté d'Orca officiel · <a href="https://github.com/nplez1/orca/releases/latest">Télécharger le dernier build d'Orca NP</a> · <a href="#ce-qui-change-dans-ce-fork">Voir ce qui change ↓</a></sub>
</p>

<p align="center">
  <strong>L'orchestrateur d'IA pour les builders 100x.</strong><br/>
  Lancez Codex, Claude Code, OpenCode ou Pi côte à côte — chacun dans son propre worktree, le tout suivi au même endroit.
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Télécharger Orca NP</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Application de bureau Orca exécutant des agents dans des worktrees parallèles, avec l'app companion mobile Orca dans le coin" width="960" />
</p>

## Ce qui change dans ce fork

Orca NP, c'est [stablyai/orca](https://github.com/stablyai/orca) plus une série de features et de correctifs propres au fork. La liste de features d'upstream ci-dessous reste valable (sauf là où aucun build n'est publié ici — voir [Installation](#installation)) ; voici ce qu'Orca NP ajoute par-dessus. La liste complète est dans les [pull requests fusionnées](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged), et la série de patchs propres au fork est documentée dans [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md).

### Tâches, issues et Jira

- **Vue tableau Jira** — choisissez un tableau par défaut et l'onglet Jira affiche les colonnes, le sprint actif et le backlog, avec glisser-déposer entre colonnes, un champ de filtre et des couleurs de priorité.
- **Un glisser-déposer qui tient** — déposer une issue Jira dans une colonne résout la transition, demande les champs exigés par l'écran de cette transition et déplace la carte avant que Jira ne confirme, en annulant seulement si Jira refuse.
- **Sprints, story points et champs personnalisés** — déplacez un élément de backlog sur un sprint depuis sa ligne ou le tiroir d'issue, définissez ou effacez les story points à côté du statut, de la priorité et de l'assigné, et modifiez les champs personnalisés de sélection d'utilisateur (Dev, QE) depuis le détail de l'issue. Un changement de sprint effectué dans l'issue ouverte recharge le tableau.
- **« Me » correspond à tous les champs de rôle** — une issue où vous êtes le Dev ou le QE, et pas seulement l'assigné, apparaît désormais sous le filtre Me du tableau.
- **Sélecteur d'assigné avec recherche** — vous et votre équipe restez épinglés en tête.
- **Issue liée dans la barre latérale droite** — un workspace créé depuis une issue Jira, Linear ou GitHub reçoit un onglet Issue avec statut, assigné, priorité, labels, description et un bouton Ouvrir. Les issues Jira permettent aussi de délier/relier, offrent une zone de commentaire Markdown en direct et affichent correctement les descriptions d'un Jira auto-hébergé (Server/Data Center). Une issue GitHub est lue depuis le repo dont elle provient, si bien qu'un workspace dans un autre projet la charge quand même ; quand ce repo n'est pas sur cette machine, l'onglet l'indique au lieu d'échouer.
- **Liez un workspace à une issue Jira** par clé ou URL depuis sa boîte de détails ; la page Tâches affiche une pastille de workspace rattaché et ouvre le workspace existant au lieu d'en créer un doublon.

### Revue de pull requests et CI

- **Commentaires de PR GitHub en ligne** — les commentaires apparaissent sous leur ligne dans l'éditeur, avec répondre, résoudre et réduire (affichés seulement quand votre checkout correspond au commit head de la PR).
- **État de fusion d'un coup d'œil** — l'icône de PR garde sa couleur de CI et ajoute un point pour les approbations en attente, les conflits ou les blocages, avec la raison dans l'infobulle. Fonctionne avec GitHub, GitLab, Bitbucket, Azure DevOps et Gitea.
- **Verdicts de revue dans le panneau Checks** — Approuvé / Modifications demandées avec le nom des relecteurs, et le panneau se met à jour quand la CI change au lieu d'attendre un changement d'onglet.
- **Panneau Checks en direct** — pendant l'exécution d'un run, un panneau ouvert se rafraîchit toutes les 10s au lieu d'attendre le rythme de revue, en espaçant à 20s puis 30s quand rien ne change, et son verdict met à jour la carte de la barre latérale et les icônes de la barre d'activité (GitHub).
- **Détails des builds Jenkins** — dépliez un check Jenkins pour voir ses étapes, laquelle est en cours ou en échec, et les infos du build.
- **Fusion admin des PR soumises à revue** — si votre compte peut contourner la protection de branche, Merge est proposé après une confirmation qui précise ce qui est ignoré.

### Agents

- **Résumés de session** — un compte rendu écrit d'une session d'agent (activité, objectif, plan, blocages, chronologie) dans la barre latérale droite, avec son propre réglage agent/modèle. Couvre aussi les sessions Pi, Copilot, OpenCode et Cursor. Une session sur un hôte appairé est résumée sur cet hôte, et une session sur une cible SSH est résumée à partir de sa transcription diffusée en retour.
- **Statut des agents plus fiable** — les lignes Pi ne restent plus bloquées sur « Working » ni ne passent à « Done » quand un sous-agent auxiliaire se termine ; Copilot CLI ne réclame plus votre attention pour des prompts auto-approuvés ; un sous-agent Grok qui attend votre réponse garde sa ligne en attente ; et un volet restauré sur un autre client retire le marqueur « attend une réponse » laissé par sa boîte de dialogue. Un sous-agent Claude qu'une session Pi lance via la CLI `claude` reste sur la ligne de cette session Pi (plugin `pi-subagents` à jour requis).
- **Les prompts de Copilot se lisent à l'écran** — une approbation de shell ou d'URL et la boîte « Copilot needs information » s'affichent comme des prompts au lieu d'un spinner, tandis qu'une permission que la CLI a approuvée d'elle-même reste silencieuse.
- **Le focus reste dans l'onglet de l'agent** — un clic sur une carte de la barre latérale, un onglet d'activité de la barre latérale droite ou l'arrière-plan du panneau rend le clavier à l'onglet de l'agent, et fermer un menu ou une boîte de dialogue y rend aussi le curseur, pour que la frappe suivante garde son sens.
- **Le presse-papiers suit le lecteur** — une copie depuis un volet Pi regardé depuis un client appairé atterrit dans le presse-papiers de ce client en plus de celui de l'hôte.
- **Agent par défaut en un clic** — le bouton `+` de la barre d'onglets lance votre agent par défaut ; maintenez-le ou utilisez le chevron pour le menu complet.
- **Agent Dashboard en page** — s'ouvre dans la fenêtre principale avec précédent/suivant, et un clic sur une carte ouvre le workspace de cet agent.
- **Historique des sessions d'agents** — « All » liste enfin toutes les sessions, les sessions de sous-agents s'imbriquent sous leur parent, et l'indexation des transcriptions rend les transcriptions existantes recherchables. L'historique d'un hôte appairé se charge par pages et ne rafraîchit que ce qui a changé, si bien qu'un gros historique distant arrive au lieu d'échouer.
- **Suivi d'usage pour plus de fournisseurs** — budgets de crédits IA Copilot Enterprise, solde DeepSeek et dépenses Fireworks.ai dans la barre d'état, plus un interrupteur par fournisseur qui arrête le polling et la lecture des identifiants. Une connexion Claude expirée est rafraîchie depuis le jeton de rafraîchissement stocké au lieu de rester sur « Se met à jour quand Claude s'exécute », et la connexion renouvelée est réécrite là où Claude la conserve.

### Workspaces et organisation

- **Un dossier par projet** — le checkout principal et tous ses worktrees vivent ensemble dans un dossier avec un `AGENTS.md` partagé ; `orca repo relocate` y déplace les checkouts existants.
- **Workspaces groupés entre machines** — la même branche sur deux hôtes devient une seule carte avec un menu déroulant d'hôte. Un workspace sur un hôte appairé lit son issue GitHub et sa PR depuis cet hôte, et son point de statut cesse de tourner une fois les agents de cet hôte terminés.
- **Les clients appairés restent alignés** — les projets et workspaces qu'un hôte ajoute ou supprime, y compris ceux créés dans la fenêtre de cet hôte ou depuis sa CLI, parviennent à ses clients appairés sans rechargement manuel.
- **Filtre de statut** — masquez les statuts choisis dans la barre latérale et Cmd+J pendant que le tableau montre toujours tout.
- **Indicateur « Setting up… »** pendant l'exécution du script de setup d'un repo, y compris pour les workspaces démarrés sans agent.
- **Modes de répertoires partagés** — lien symbolique, clone APFS, copie ou ignorer pour les répertoires partagés entre worktrees.
- **Workspace flottant** — son propre dossier, une poignée de déplacement sur la barre de titre et le même contrôle de lancement d'agent que la barre d'onglets principale.
- **Masquez les hôtes SSH importés automatiquement** des sélecteurs et de la barre d'état ; les hôtes masqués restent listés dans les Réglages.
- **Filtre de fichiers plus rapide et honnête** — le filtre par nom d'Explore cherche dans tout le workspace depuis un index précalculé et indique quand les résultats sont partiels au lieu d'afficher « no files match ».
- **Réplication des réglages entre hôtes** _(socle)_ — les réglages et identifiants de fournisseurs d'une machine peuvent être répliqués vers les hôtes appairés.

### Environnements éphémères

Ajouts aux recettes d'environnement par workspace d'upstream (Paramètres → Expérimental → VM cloud) :

- **Compte à rebours du bail et Extend** — une recette qui indique quand le fournisseur reprend l'hôte reçoit un compte à rebours sur la carte du workspace et dans les Paramètres et, si elle déclare aussi comment le prolonger, une action Extend limitée aux durées qu'elle liste. Passé le délai, la carte et les Paramètres affichent le bail comme expiré ; une fois 15 minutes de plus écoulées et la connexion d'Orca avec l'hôte en échec, Orca retire le workspace de sa liste, et la machine du fournisseur reste soumise à sa propre expiration ou au nettoyage dans les Paramètres.
- **Éléments de menu contextuel déclarés par la recette** — jusqu'à 20 actions qu'une recette déclare ont leurs propres entrées dans le menu contextuel de ce workspace et s'exécutent avec l'hôte, le nom et le chemin du workspace. Elles sont déclarées dans `orca.yaml`, donc couvertes par l'approbation de la recette, et une recette qui n'en déclare aucune n'ajoute aucune entrée.

### Fiabilité

- Les hooks git et l'authentification ssh-agent fonctionnent quand l'app packagée est lancée depuis le Dock, car git voit maintenant les exports de votre profil de shell.
- Les permissions de computer use sur macOS ne se répartissent plus entre deux identités du helper.
- Le collage par clic droit dans Copilot CLI colle une fois, pas deux.
- Un diagnostic optionnel « Log UI hangs » écrit des enregistrements de blocages, avec le contexte de focus, de veille et de CPU, pour aider à traquer les beachballs.

### Exécution

- **Identité propre** — Orca NP utilise son propre app id (`com.nplez1.orca`), son répertoire de données, son répertoire home (`~/.orca-np`) et sa CLI (`orca-np`) : il s'installe et s'exécute à côté d'un Orca officiel sans partager d'état.
- **Releases et mises à jour propres** — les builds sont taggés `v<version d'upstream>-np.<n>` et l'updater intégré suit les [releases de ce dépôt](https://github.com/nplez1/orca/releases), pas celles d'upstream.
- **Signature** — les builds macOS sont signés et notarisés ; l'installeur Windows n'est pas signé, donc SmartScreen avertit une fois à l'installation.
- **Aucune télémétrie** — les notes de release indiquent que les builds n'envoient ni diagnostics ni données d'usage.
- **Les skills pointent vers cette app** — les skills embarqués et les stubs publiés appellent `orca-np` (et `orca-np-dev` en développement) au lieu de retomber sur le `orca` d'une installation officielle.
- **Profil neuf** — Orca NP ne peut pas lire les repos, identifiants ni appareils appairés d'une installation Orca officielle ; cette séparation est voulue, donc appairez votre téléphone à Orca NP séparément.
- **Suit upstream** — `main` d'upstream est fusionné régulièrement (la procédure est dans [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)), donc le fork reçoit aussi les features et correctifs d'upstream.

---

## Fonctionnalités

La liste de features ci-dessous est celle d'Orca upstream ; ses liens « Docs » mènent à la documentation d'upstream sur onorca.dev, qui ne couvre pas les features propres au fork ci-dessus.

<table>
<tr>
<td width="50%" valign="middle">

### Companion mobile

Surveillez et pilotez vos agents depuis votre téléphone — soyez notifié quand un agent termine, et envoyez des instructions de suivi où que vous soyez.

[App Store iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [APK Android](https://www.onorca.dev/download/android) · [Docs →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca desktop avec l'app companion mobile" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees parallèles

Lancez un même prompt sur cinq agents, chacun dans son propre worktree git isolé — comparez les résultats et mergez le gagnant.

[Docs →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="Orchestration de worktrees parallèles" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Splits de terminal

Terminaux de niveau Ghostty avec rendu WebGL, splits infinis et un scrollback qui survit aux redémarrages.

[Docs →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Splits de terminal" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Mode Design

Cliquez sur n'importe quel élément d'UI dans une vraie fenêtre Chromium pour envoyer son HTML, son CSS et une capture recadrée directement dans le prompt de votre agent.

[Docs →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Navigateur intégré et Mode Design" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear, natifs

Parcourez PRs, issues et boards de projet dans l'app — ouvrez un worktree depuis n'importe quelle tâche et reviewz sans changer de contexte.

[Docs →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Workflows GitHub et Linear dans Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees SSH

Faites tourner des agents sur une machine distante costaude, avec édition de fichiers, git et terminaux complets — reconnexion auto et port forwarding inclus.

[Docs →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Worktrees distants via SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Annoter les diffs IA

Posez des commentaires sur n'importe quelle ligne de diff et renvoyez-les à l'agent — review, édition et commit sans quitter Orca.

[Docs →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Annoter les diffs générés par l'IA" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Glisser-déposer vers les agents

L'éditeur VS Code avec autosave partout — glissez fichiers ou images directement dans le prompt d'un agent.

[Docs →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Glisser des fichiers et images dans le prompt d'un agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Les agents pilotent aussi Orca — scriptez n'importe quel workflow avec `orca worktree create`, `snapshot`, `click` et `fill`.

[Docs →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Scripter Orca depuis la CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Aussi dans la boîte :**

- **[Quick open](https://www.onorca.dev/docs/model/quick-open)** — Cherchez parmi worktrees, fichiers, agents, commandes et contexte du repo sans quitter votre flow.
- **[Sélecteur de comptes &amp; suivi d'usage](https://www.onorca.dev/docs/agents/usage-tracking)** — Suivez l'usage Claude et Codex et les resets de rate limit, et basculez de compte à chaud sans vous reconnecter.
- **[Aperçus riches du repo](https://www.onorca.dev/docs/editing/markdown)** — Prévisualisez Markdown, images, PDF et docs du repo dans le workspace.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Laissez les agents piloter des apps desktop et l'UI visible quand un workflow demande une vraie interaction.
- **[Notifications et non-lus](https://www.onorca.dev/docs/notifications)** — Sachez quand un agent termine ou a besoin d'attention, puis marquez des fils comme non lus pour y revenir plus tard.
- **Et bien plus encore** — on ship tous les jours, donc cette liste est toujours en retard. Les [releases d'Orca NP](https://github.com/nplez1/orca/releases) sont la vraie liste des features de ce fork, et [celles d'upstream](https://github.com/stablyai/orca/releases) le sont pour tout ce qu'il hérite.

---

## Agents pris en charge

Fonctionne avec **n'importe quel agent CLI** — s'il tourne dans un terminal, il tourne dans Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Logo Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Logo Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Logo Grok" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Logo Cursor" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="Logo GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Logo Muse" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="Logo ZCode" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="Logo OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="Logo MiMo Code" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Logo Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="Logo OpenClaude" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Logo Antigravity" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Logo Pi" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="Logo oh-my-pi" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Logo Hermes Agent" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Logo Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Logo Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Logo Auggie" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Logo Autohand Code" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Logo Charm" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Logo Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Logo Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Logo Freebuff" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Logo Command Code" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Logo Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Logo Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Logo Kilocode" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Logo Kimi" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Logo Kiro" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Logo Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Logo Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Logo Rovo Dev" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ n'importe quel agent CLI</kbd>
</p>

---

## Installation

### Desktop — macOS, Windows

- **[Télécharger la dernière release d'Orca NP](https://github.com/nplez1/orca/releases/latest)**
- Ou récupérez un build directement : [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [Tous les builds](https://github.com/nplez1/orca/releases)

Orca NP s'installe à côté d'un Orca officiel et se met à jour depuis les releases de ce dépôt. Ce fork ne publie ni build Linux ni paquet Homebrew/AUR — sous Linux, [compilez depuis les sources](../../.github/CONTRIBUTING.md) ou utilisez [Orca upstream](https://github.com/stablyai/orca/releases/latest).

### Companion mobile — iOS, Android

Associez l'app mobile Orca à Orca NP pour surveiller et piloter vos agents depuis votre téléphone. Les apps sont publiées par Orca upstream et fonctionnent avec Orca NP.

- **iOS :** [Télécharger sur l'App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android :** [Télécharger l'APK](https://www.onorca.dev/download/android)

---

## Communauté &amp; support

- **Issues &amp; idées Orca NP :** [Ouvrez une issue](https://github.com/nplez1/orca/issues) pour tout ce qui est propre à ce fork.
- **Communauté upstream :** les canaux d'Orca upstream couvrent tout ce dont ce fork hérite — [Discord](https://discord.gg/fzjDKHxv8Q), [@orca_build sur X](https://x.com/orca_build) et les [issues upstream](https://github.com/stablyai/orca/issues) pour les bugs qui se reproduisent aussi dans Orca officiel.
- **Groupe WeChat upstream :** le groupe 11 est complet. Scannez pour rejoindre le groupe WeChat 12 de la communauté Orca.

  <img src="../assets/wechat-qr.jpg" alt="QR code du groupe WeChat de la communauté Orca" width="160" />

- **Docs :** [onorca.dev/docs](https://www.onorca.dev/docs) documente Orca upstream.
- **Soutenez-nous :** [Mettez une star](https://github.com/nplez1/orca) sur ce repo pour suivre le fork, ou sur [upstream](https://github.com/stablyai/orca).

---

## Développement

Envie de contribuer ou de lancer le projet en local ? Consultez notre guide [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Contributeurs Orca" />
</a>

## Builds signés

Les builds Windows d'Orca NP ne sont pas signés. Les builds Windows d'Orca upstream sont signés grâce à une signature de code sponsorisée / fournie par [SignPath.io](https://signpath.io), certificat par [SignPath Foundation](https://signpath.org).

## Licence

Orca est libre et open source sous la [licence MIT](../../LICENSE).
