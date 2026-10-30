<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub スター数" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Orca NP の最新リリース" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="ライセンス: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Orca NP のビルド: macOS と Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.ru.md">Русский</a></sub>
</p>

<p align="center">
  <strong>🔱 これは <a href="#このフォークの違い">Orca NP</a> です — 独自の機能・修正・リリースを持つ <a href="https://github.com/stablyai/orca">stablyai/orca</a> のフォークです。</strong><br/>
  <sub>公式の Orca と並べてインストールできます · <a href="https://github.com/nplez1/orca/releases/latest">最新の Orca NP ビルドをダウンロード</a> · <a href="#このフォークの違い">違いを見る ↓</a></sub>
</p>

<p align="center">
  <strong>100x ビルダーのための AI オーケストレーター。</strong><br/>
  Codex、Claude Code、OpenCode、Pi を並べて実行 — それぞれを専用のワークツリーで動かし、1 か所で追跡できます。
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Orca NP をダウンロード</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="並列ワークツリーでエージェントを実行する Orca デスクトップアプリと、隅に表示された Orca モバイル companion アプリ" width="960" />
</p>

## このフォークの違い

Orca NP は [stablyai/orca](https://github.com/stablyai/orca) に、フォーク独自の機能と修正を重ねたものです。下記のアップストリームの機能一覧はそのまま使えます（ここでビルドが公開されていないものを除く — [インストール](#インストール)を参照）。以下が Orca NP が追加する内容です。全リストは[マージ済みのプルリクエスト](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged)にあり、フォーク独自のパッチ群は [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md) に記載されています。

### タスク、Issue、Jira

- **Jira ボードビュー** — 既定のボードを選ぶと、Jira タブに列、アクティブなスプリント、バックログが表示されます。列間のドラッグ移動、フィルター欄、優先度の色分けに対応します。
- **レーンへのドロップが確実に反映される** — Jira 項目をレーンにドロップすると、トランジションを解決し、そのトランジションの画面が必要とするフィールドを求め、Jira が確認する前にカードを移動します。Jira が拒否した場合のみ取り消します。
- **スプリント、ストーリーポイント、カスタムフィールド** — バックログ項目を行から、または Issue ドロワーからスプリントに移動でき、ステータス・優先度・担当者の横でストーリーポイントを設定・クリアでき、Issue の詳細からカスタムのユーザー選択フィールド（Dev、QE）を編集できます。開いている Issue でスプリントを変更すると、ボードが再読み込みされます。
- **「Me」はすべてのロールフィールドに一致** — 担当者だけでなく、あなたが Dev または QE である Issue も、ボードの Me フィルターに表示されます。
- **検索できる担当者ピッカー** — 自分とチームが先頭に固定されます。
- **右サイドバーのリンク済み Issue** — Jira、Linear、GitHub の Issue から作成したワークスペースには、ステータス、担当者、優先度、ラベル、説明、「開く」ボタンを備えた Issue タブが付きます。Jira Issue ではリンク解除／再リンク、ライブ Markdown コメント欄、セルフホスト版 Jira（Server/Data Center）の説明の正しい表示にも対応します。GitHub Issue はそれが由来したリポジトリから読み込まれるため、別のプロジェクトのワークスペースでも読み込めます。そのリポジトリがこのマシンにない場合は、失敗する代わりにタブがその旨を表示します。
- **ワークスペースを Jira Issue にリンク** — 詳細ダイアログからキーまたは URL で指定できます。タスクページには紐づいたワークスペースのチップが表示され、重複して作成せず既存のワークスペースを開きます。

### プルリクエストのレビューと CI

- **インライン GitHub PR コメント** — コメントはエディタ内の該当行の下に表示され、返信・解決・折りたたみができます（チェックアウトが PR の head コミットと一致する場合のみ表示）。
- **マージ可否をひと目で** — PR アイコンは CI の色を保ったまま、未完了の承認・コンフリクト・ブロックがあるとドットが付き、理由はツールチップに表示されます。GitHub、GitLab、Bitbucket、Azure DevOps、Gitea で動作します。
- **Checks パネルにレビュー結果** — レビュアー名付きで Approved / Changes requested を表示し、タブを切り替えなくても CI の変化に合わせてパネルが更新されます。
- **ライブ Checks パネル** — 実行中は、開いているパネルがレビューの更新間隔を待たずに 10 秒ごとに再読み込みし、何も変化しなくなると 20 秒、さらに 30 秒へと間隔を緩めます。その判定は、サイドバーのカードとアクティビティバーのアイコンを更新します（GitHub）。
- **Jenkins ビルドの詳細** — Jenkins のチェックを展開すると、各ステージ、実行中または失敗したステージ、ビルド情報を確認できます。
- **レビュー必須 PR の管理者マージ** — アカウントがブランチ保護をバイパスできる場合、スキップされる内容を示す確認の後に Merge が表示されます。

### エージェント

- **セッション要約** — エージェントのセッションを文章にまとめたブリーフ（アクティビティ、目標、計画、ブロッカー、タイムライン）を右サイドバーに表示し、専用のエージェント／モデル設定を持ちます。Pi、Copilot、OpenCode、Cursor のセッションにも対応します。ペアリング済みホスト上のセッションはそのホスト側で、SSH ターゲット上のセッションはストリームで返ってきたトランスクリプトから、それぞれ要約されます。
- **より正確なエージェント状態** — Pi の行は、補助サブエージェントが終了しても「Working」のままになったり「Done」になったりしません。Copilot CLI は自動承認されたプロンプトで「needs you」を出さなくなりました。あなたの回答を待つ Grok のサブエージェントは、その行を待機中のまま保ちます。また、別のクライアントで復元したペインは、ダイアログが残した入力待ちマーカーを消します。pi セッションが `claude` CLI 経由で起動した Claude サブエージェントは、その pi セッションの行に留まります（最新の pi-subagents プラグインが必要です）。
- **Copilot のプロンプトは画面から読み取る** — シェルや URL の承認と「Copilot needs information」ダイアログが、スピナーではなくプロンプトとして表示され、CLI が自分で承認した権限は静かなままです。
- **フォーカスはエージェントのタブに留まる** — サイドバーのカード、右サイドバーのアクティビティタブ、またはパネルの背景をクリックしても、キーボードはエージェントのタブに戻り、メニューやダイアログを閉じるとキャレットも戻るため、次のキー入力の意味は変わりません。
- **クリップボードは読んでいる側に従う** — ペアリング済みクライアントから pi のペインを見ている場合、コピーした内容はホストのクリップボードに入るとともに、そのクライアントのクリップボードにも入ります。
- **ワンクリックで既定のエージェント** — タブバーの `+` ボタンで既定のエージェントを起動します。長押しするかシェブロンで完全なメニューを開けます。
- **ページとしての Agent Dashboard** — メインウィンドウで戻る／進む付きで開き、カードをクリックするとそのエージェントのワークスペースが開きます。
- **エージェントのセッション履歴** — 「All」がすべてのセッションを一覧表示し、サブエージェントのセッションは親の下に入れ子になり、トランスクリプトのインデックス化で既存のトランスクリプトも検索できます。ペアリング済みホストの履歴はページ単位で読み込まれ、変わった部分だけが更新されるため、大きなリモート履歴も失敗せずに届きます。
- **より多くのプロバイダーで使用量を追跡** — Copilot Enterprise の AI クレジット予算、DeepSeek の残高、Fireworks.ai の支出をステータスバーに表示。プロバイダーごとのオフスイッチでポーリングと認証情報の読み取りを止められます。期限が切れた Claude のログインは「Claude の実行時に更新」のまま待たず、保存されたリフレッシュトークンから更新され、更新後のログインは Claude が保管している場所に書き戻されます。

### ワークスペースとレイアウト

- **プロジェクトごとに 1 フォルダ** — メインのチェックアウトとすべてのワークツリーを、共有の `AGENTS.md` と一緒に 1 つのフォルダにまとめます。`orca repo relocate` で既存のチェックアウトを移動できます。
- **マシンをまたぐワークスペースのグループ化** — 2 つのホスト上の同じブランチが、ホスト切り替えドロップダウン付きの 1 枚のカードになり、ペアリング済みホスト上のワークスペースはそのホストから GitHub の Issue と PR を読み込み、ホスト上のエージェントが終了するとステータスドットの回転が止まります。
- **ペアリング済みクライアントの同期を維持** — ホストが追加・削除したプロジェクトとワークスペースは、ホスト自身のウィンドウや CLI で作成されたものも含め、手動で更新しなくても、そのペアリング済みクライアントに届きます。
- **ステータスフィルター** — 選んだステータスをサイドバーと Cmd+J から隠せます。ボードは引き続きすべてを表示します。
- **「Setting up…」インジケーター** — リポジトリのセットアップスクリプト実行中に表示されます。エージェントなしで開始したワークスペースも対象です。
- **共有ディレクトリのモード** — ワークツリー間で共有するディレクトリを、シンボリックリンク、APFS クローン、コピー、スキップから選べます。
- **フローティングワークスペース** — 専用のホームフォルダ、タイトルバーのドラッグハンドル、メインのタブバーと同じエージェント起動コントロールを備えます。
- **自動インポートされた SSH ホストを非表示に** — ピッカーとステータスバーから隠せます。非表示のホストは設定に残ります。
- **より速く正直なファイルフィルター** — Explore のファイル名フィルターは、構築済みのインデックスからワークスペース全体を検索し、結果が部分的なときは「no files match」ではなくその旨を表示します。
- **ホスト間の設定レプリケーション** _(基盤のみ)_ — 1 台のマシンの設定とプロバイダーの認証情報を、ペアリング済みのホストにレプリケートできます。

### 一時的な環境

アップストリームのワークスペースごとの環境レシピ（設定 → 実験的機能 → クラウド VM）への追加：

- **リースのカウントダウンと Extend** — プロバイダーがホストを回収する時刻を公開するレシピは、ワークスペースカードと設定にカウントダウンを表示し、延長方法まで宣言している場合は、そのレシピが挙げる存続時間に限った Extend 操作も提供します。期限を過ぎると、カードと設定はリースを期限切れとして表示します。さらに 15 分が経過し、かつ Orca からホストへの接続が失敗している場合、Orca はそのワークスペースを一覧から削除し、プロバイダーのマシンはそのまま期限切れか設定のクリーンアップに委ねられます。
- **レシピで宣言するコンテキストメニューアイテム** — レシピが宣言した最大 20 個のアクションが、そのワークスペースのコンテキストメニューに独自の項目として並び、ワークスペースのホスト・名前・パスを渡して実行されます。宣言は `orca.yaml` に書くものなので、レシピの承認が及びます。何も宣言しないレシピでは項目は増えません。

### 信頼性

- パッケージ版アプリを Dock から起動しても、git がシェルプロファイルの export を参照するため、git フックと ssh-agent 認証が動作します。
- macOS の computer use の権限が、2 つのヘルパー ID に分裂しなくなりました。
- Copilot CLI への右クリック貼り付けが 2 回ではなく 1 回だけ貼り付けられます。
- オプトインの「Log UI hangs」診断は、フォーカス、スリープ、CPU の情報付きでフリーズの記録を書き出し、ビーチボールの原因調査に役立ちます。

### 実行について

- **独自のアイデンティティ** — Orca NP は独自のアプリ ID（`com.nplez1.orca`）、データディレクトリ、ホームディレクトリ（`~/.orca-np`）、CLI（`orca-np`）を使うため、公式の Orca と状態を共有せずに並べてインストール・実行できます。
- **独自のリリースとアップデート** — ビルドは `v<アップストリームのバージョン>-np.<n>` のタグが付き、アプリ内アップデーターはアップストリームではなく[このリポジトリのリリース](https://github.com/nplez1/orca/releases)を参照します。
- **署名** — macOS ビルドは署名・公証済みです。Windows のインストーラーは未署名のため、インストール時に SmartScreen が 1 回警告します。
- **テレメトリーなし** — リリースノートによると、ビルドは診断データも利用データも送信しません。
- **スキルはこのアプリを指す** — 同梱のスキルと公開済みのスタブは、公式インストールの `orca` へフォールバックせず、`orca-np`（開発時には `orca-np-dev`）を呼び出します。
- **新しいプロファイル** — Orca NP は、公式 Orca のインストールのリポジトリ、認証情報、ペアリング済みデバイスを読み取れません。この分離は意図的なものなので、スマートフォンは Orca NP と別途ペアリングしてください。
- **アップストリームに追従** — アップストリームの `main` を定期的にマージしています（手順は [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)）。そのためフォークもアップストリームの機能と修正を受け取れます。

---

## 機能

以下の機能一覧はアップストリームの Orca のものです。「Docs」リンクは onorca.dev にあるアップストリームのドキュメントへ移動し、上記のフォーク独自機能は扱っていません。

<table>
<tr>
<td width="50%" valign="middle">

### モバイル Companion

スマートフォンからエージェントを監視・操作 — エージェントの完了を通知で受け取り、どこからでもフォローアップを送信できます。

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://www.onorca.dev/download/android) · [ドキュメント →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca デスクトップとモバイル companion アプリ" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 並列ワークツリー

1 つのプロンプトを 5 つのエージェントに展開し、それぞれを独立した git ワークツリーで実行 — 結果を比較して、最良のものをマージできます。

[ドキュメント →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="並列ワークツリーのオーケストレーション" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### ターミナル分割

WebGL レンダリング、無制限の分割、再起動後も残るスクロールバックを備えた Ghostty クラスのターミナル。

[ドキュメント →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="ターミナル分割" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### デザインモード

実際の Chromium ウィンドウで任意の UI 要素をクリックすると、その HTML、CSS、切り抜いたスクリーンショットがそのままエージェントのプロンプトに送られます。

[ドキュメント →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="組み込みブラウザとデザインモード" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear をネイティブに

PR、Issue、プロジェクトボードをアプリ内で閲覧 — 任意のタスクからワークツリーを開き、コンテキストスイッチなしでレビューできます。

[ドキュメント →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Orca の GitHub と Linear タスクワークフロー" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH ワークツリー

強力なリモートマシン上でエージェントを実行 — ファイル編集、git、ターミナルをフルに使え、自動再接続とポートフォワーディングも付属します。

[ドキュメント →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="SSH 経由のリモートワークツリー" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AI Diff に注釈

任意の Diff 行にコメントを付けてエージェントへ送り返せます — Orca から離れずにレビュー、編集、コミットまで完結します。

[ドキュメント →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="AI が生成した Diff への注釈" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### ファイルをエージェントへドラッグ

オートセーブが全面的に効く VS Code のエディタ — ファイルや画像をそのままエージェントのプロンプトへドラッグできます。

[ドキュメント →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="ファイルや画像をエージェントのプロンプトへドラッグ" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

エージェント自身も Orca を操作できます — `orca worktree create`、`snapshot`、`click`、`fill` であらゆるワークフローをスクリプト化できます。

[ドキュメント →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="CLI から Orca をスクリプト操作" width="100%" /></picture></a>
</td>
</tr>
</table>

**さらに同梱:**

- **[クイックオープン](https://www.onorca.dev/docs/model/quick-open)** — フローを離れずに、ワークツリー、ファイル、エージェント、コマンド、リポジトリコンテキストを横断検索できます。
- **[アカウント切り替えと使用量トラッキング](https://www.onorca.dev/docs/agents/usage-tracking)** — Claude と Codex の使用量やレート制限のリセットを確認し、再ログインなしでアカウントを切り替えられます。
- **[リッチなリポジトリプレビュー](https://www.onorca.dev/docs/editing/markdown)** — Markdown、画像、PDF、リポジトリ文書をワークスペース内でプレビューできます。
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — 実際の操作が必要なワークフローでは、エージェントにデスクトップアプリや画面上の UI を操作させられます。
- **[通知と未読ステータス](https://www.onorca.dev/docs/notifications)** — エージェントの完了や要対応をすぐに把握し、スレッドを未読に戻して後で確認できます。
- **その他、まだまだたくさん** — 毎日リリースしているので、このリストは常に追いついていません。このフォークの本当の機能一覧は [Orca NP のリリース](https://github.com/nplez1/orca/releases)、継承している部分は[アップストリームのリリース](https://github.com/stablyai/orca/releases)です。

---

## 対応するエージェント

**あらゆる CLI エージェント**で動作します — ターミナルで動くものなら、Orca でも動きます。

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

---

## インストール

### デスクトップ — macOS, Windows

- **[最新の Orca NP リリースをダウンロード](https://github.com/nplez1/orca/releases/latest)**
- またはビルドを直接入手: [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [すべてのビルド](https://github.com/nplez1/orca/releases)

Orca NP は公式の Orca と並べてインストールでき、このリポジトリのリリースから自動更新されます。このフォークは Linux ビルドも Homebrew/AUR パッケージも公開していません。Linux では[ソースからビルド](../../.github/CONTRIBUTING.md)するか、[アップストリームの Orca](https://github.com/stablyai/orca/releases/latest) を使ってください。

### モバイル Companion — iOS, Android

Orca のモバイルアプリを Orca NP とペアリングして、スマートフォンからエージェントを監視・操作できます。アプリはアップストリームの Orca が公開しており、Orca NP でも動作します。

- **iOS:** [App Store からダウンロード](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [APK をダウンロード](https://www.onorca.dev/download/android)

---

## コミュニティとサポート

- **Orca NP の Issue とアイデア:** このフォーク固有の件は [Issue を作成](https://github.com/nplez1/orca/issues)してください。
- **アップストリームのコミュニティ:** このフォークが継承する部分は、アップストリーム Orca のチャンネルが対象です — [Discord](https://discord.gg/fzjDKHxv8Q)、[X の @orca_build](https://x.com/orca_build)、公式 Orca でも再現するバグは[アップストリームの Issue](https://github.com/stablyai/orca/issues) へ。
- **ドキュメント:** [onorca.dev/docs](https://www.onorca.dev/docs) はアップストリームの Orca のドキュメントです。
- **応援する:** このフォークを追うにはこのリポジトリに[スター](https://github.com/nplez1/orca)を、または[アップストリーム](https://github.com/stablyai/orca)に付けてください。

---

## 開発について

貢献したい、またはローカルで実行したいですか？ [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) ガイドをご覧ください。

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Orca のコントリビューター" />
</a>

## ライセンス

Orca は [MIT License](../../LICENSE) の下で無料かつオープンソースです。
