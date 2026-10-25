# Tonarium Agent Studio

Discord の声を聞き取り、GitHub PR の作成・チェック・`main` へのマージまで進める常駐エージェントです。対象は `.env` の `DISCORD_CHANNEL_ID` で指定した通常のテキストチャンネルです。親チャンネルへ発言すると Bot がそのメッセージから公開スレッドを作り、空いている聞き取り担当が詳細を聞きます。ユーザーが手動で作ったスレッドも受け付けます。

Tonarium リポジトリの既定ブランチ名は `master` ではなく **`main`** です。案件ごとに最初の発言を受けた時点の `main` commit を保存し、その commit の worktree で既存機能を調べ、実装します。後から `main` が進んでも、最初の判断に使ったコードは変わりません。

```mermaid
flowchart LR
  Voice[親チャンネルの発言] --> Thread[Bot がスレッドを作る]
  Thread --> H[聞き取り 5人 / 重複と既存機能の確認]
  H --> S[さくら / PM]
  S -->|製品判断が必要| Forum[判断用フォーラム]
  Forum --> S
  S --> A[開発リード 5人]
  A --> Workers[実装 15人 / 並列 worktree]
  Workers --> PR[main 宛ての PR]
  PR --> I[すず / 最新 main との統合・競合解決・テスト]
  I --> M[みのり / GitHub チェック確認・PR マージ]
  M --> Main[main]
  Main --> Q[完了後のスレッドで実装質問]
  Q --> Help[あん / 現在のコードと PR を調べて回答]
  Main --> Bug[完了後のスレッドで不具合報告]
  Bug --> Repair[元の PR にひも付けた新規修正スレッド]
  Repair --> H
```

似た声は既存案件にまとめます。リポジトリの実ファイルを確認できる既存機能は使い方を返信して閉じます。製品判断が必要な案件だけ判断用フォーラムに投稿します。フォーラム ID が未設定の場合は元のスレッドで質問します。

聞き取り担当は Codex のサブスクログインを使います。Discord のスレッドに添付された PNG・JPEG 画像を新しい順に最大4枚、各10 MiBまで一時取得し、`codex exec --image` の視覚入力として渡します。処理後に一時ファイルを消します。対応外の形式や取得できない画像は URL を会話履歴に残し、画像内容を確認したものとしては扱いません。画像入力の方法は [公式 OpenAI Docs](https://learn.chatgpt.com/docs/image-inputs?surface=cli) に従っています。

ユーザーの発言と Bot の返答は、同じスレッドに **日本語・英語・韓国語**を併記します。元の発言は消しません。判断用フォーラムの会話も翻訳します。翻訳が失敗しても元の発言の聞き取りは続けます。マージ後や既存機能の案内後も同じスレッドで質問できます。実装案内の「あん」が PR と現在のコードを確認し、質問には回答します。不具合・回帰・修正依頼なら元の PR を引き継ぐ新規スレッドを作り、聞き取りから再開します。再現情報が足りなければ元スレッドで質問します。元の案件は完了状態のままです。

Bot が停止していた間に完了済みスレッドへ届いた質問も、再起動時に完了時刻と最終発言を比べて拾います。個別のスレッドで実装案内をすぐ動かすには `npm run answer:thread -- <Discord スレッド ID>` を使います。

実装担当は最大 15 件を並列処理します。各案件で `npm ci`、`npm run typecheck`、`npm run build`、`npm run test:client`、`npm run test:sync` を通してから PR を作ります。すずは PR ブランチへ最新 `main` を取り込み、競合を解決し、統合状態で同じチェックを実行します。みのりは GitHub の Web チェックと実行対象のワークフローすべての完了を待ち、PR の head commit を確認して `main` にマージします。チェックが現れない場合もマージしません。複数 PR は一件ずつ最新 `main` へ合わせます。

## セットアップ

Node.js 22.13 以降、Git、GitHub CLI (`gh`) が必要です。Codex CLI はこのプロジェクトに `@openai/codex` を固定しています。既定では受付、PM、リード、実装、出荷、通訳の全員が ChatGPT/Codex のサブスクログインを使い、AI 用 API キーを子プロセスへ渡しません。`claude` を明示的に選んだ場合だけ Claude Code CLI が必要です。

```powershell
cd C:\Users\neo\GitHub\tonarium-agent
Copy-Item .env.example .env  # まだ .env がない場合だけ
npm ci
npm run doctor
npm start
```

既存の `.env` はそのまま使えます。旧 `NIGHTLY_BRANCH` と `COOLIFY_*` は現在の出荷フローでは参照しません。必要な設定は次の通りです。

| 設定 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Bot token。Developer Portal で Message Content Intent を有効にする。 |
| `DISCORD_CHANNEL_ID` | フィードバック用テキストチャンネル。`.env` で指定します。 |
| `DISCORD_DECISION_FORUM_ID` | 任意。判断だけを投稿するフォーラムの ID。 |
| `DISCORD_DECISION_MENTION_ID` | 任意。判断投稿で呼ぶユーザー ID。 |
| `TONARIUM_REPO` | Tonarium の既存 checkout。初期値 `C:\Users\neo\GitHub\tonarium-prototype`。 |
| `GITHUB_REPO` | `katteni-kaihatu/tonarium-prototype`。`gh auth login` の書き込み権限が必要。 |
| `RELEASE_BRANCH` | `main`。 |
| `INTAKE_PROVIDER` | 聞き取り5人に使う `codex` または `claude`。既定 `codex`。 |
| `PLANNING_PROVIDER` | PM・リード・出荷・実装案内に使う `codex` または `claude`。既定 `codex`。 |
| `CODING_PROVIDER` / `INTEGRATION_PROVIDER` | 実装・競合解決に使う `codex` または `claude`。 |
| `CODEX_MODEL` / `CODEX_SPEED` | 既定は `gpt-6.1-sol` / `fast`。この PC でサブスクログインによる応答を確認済み。 |
| `TRANSLATION_PROVIDER` | 既定は `codex`（サブスク）。`openai` を選ぶと翻訳だけ OpenAI API を使う。 |
| `TRANSLATION_MODEL` | OpenAI API 翻訳時のモデル。既定は `gpt-6-luna`。 |
| `OPENAI_API_KEY` | `TRANSLATION_PROVIDER=openai` の場合だけ必要。Codex の聞き取り・実装には渡さない。 |
| `MAX_WORKERS` | 同時に動く実装担当の上限。既定 `15`。聞き取りとリードは各5人。 |
| `RELEASE_BATCH_MINUTES` | PR をまとめる待ち時間。既定 `0`（準備完了後、次の15秒巡回で出荷開始）。 |
| `REQUIRED_PR_CHECK` | GitHub で成功を待つチェック名。既定 `web`。 |
| `AUTO_RELEASE` | Bot 内蔵の出荷巡回。独立した `TonariumAgentRelease` を使う構成では `false`。 |

独立した出荷タスクが15秒ごとに出荷待ちの PR を確認します。すでに出荷待ちの PR を手動で即時処理する場合は `npm run release:ready` を実行できます。出荷担当が最新 `main` への統合、ローカルテスト、GitHub チェック、PR マージを順番に行います。

一時的な GitHub push 失敗は同じコミットを再送します。それでも失敗した場合や実装テストで失敗した場合は、PM がエラーと作業ツリーを確認し、回数制限付きで再作業を指示します。再試行時は前回の差分を保持し、push だけ失敗した案件では実装エージェントを再実行しません。Tonarium 本体の Web checks はすべての PR に `shared/changelog.ts` の新規項目を要求します。出荷時に漏れを見つけた場合は統合担当が追記してからチェックを再実行します。統合後のテスト失敗も統合担当が修正と再検証を行い、1件の失敗でほかの出荷待ち PR が止まらないようにします。

Bot には対象チャンネルで **View Channel、Read Message History、Create Public Threads、Send Messages in Threads** を与えてください。判断用フォーラムを使う場合は投稿権限も必要です。Message Content Intent の詳細は [Discord の公式資料](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx) を参照してください。

Codex の `gpt-6.1-sol` と Fast モードは [OpenAI Docs のモデル情報](https://learn.chatgpt.com/docs/models#gpt-61-sol) と [速度設定](https://learn.chatgpt.com/docs/agent-configuration/speed#fast-mode) に従っています。Fast はサブスクの利用枠を通常の 2.5 倍消費します。`CODEX_SPEED=standard` にすれば通常速度にできます。

OpenAI API 翻訳は [Responses API の Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs#structured-outputs-vs-json-mode) で日英韓の三項目を受け取ります。API 方式を選んだ場合、翻訳対象の発言は OpenAI API に送信されます。

## ダッシュボードと常駐

ダッシュボードはローカルの `http://127.0.0.1:43879` と公開 URL `https://tonarium-agent.kokopi.me` で見られます。担当者、案件の段階、最近の動き、PR マージ履歴をライブ更新します。公開 URL はこの PC からの SSH 逆トンネルを使用します。PC、Bot、トンネルのどれかが停止すると公開も停止します。画面には Discord の案件名・要約・活動内容が表示されます。

Windows ログオン時の起動タスクは `.env` を設定した後に登録できます。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install-public-tunnel-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install-release-task.ps1
Start-ScheduledTask -TaskName TonariumAgent
Start-ScheduledTask -TaskName TonariumAgentTunnel
Start-ScheduledTask -TaskName TonariumAgentRelease
```

`.data/state.sqlite` に案件、受信時の `main` commit、出荷履歴を保存します。`.worktrees/` は作業コピーです。実装中に Bot が再起動した場合は残った作業コピーと GitHub Issue を再利用します。これらと `.env` は Git に含めません。
