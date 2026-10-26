# Tonarium Agent のオーケストレーション調査

調査日: 2026-10-26。Discord で受けた声を並列に実装し、CI を通した PR を main へマージする現在の運用を対象にした。各プロジェクトの公開資料とコード上の仕様を読み、Tonarium Agent に取り込める点を選んだ。

## 結論

今の SQLite による案件状態、案件ごとの worktree、PR ごとの出荷レーンを維持する。まず指示をリポジトリ内の Markdown に移し、Bot が実行のたびに読むようにした。次は長時間実行の停止検知と、各判断で使った指示・コミット・CI 結果を追える記録を優先する。別のオーケストレータへ丸ごと移す段階ではない。

## 参考にした実装

| プロジェクト | 確認した実装・方針 | Tonarium での扱い |
| --- | --- | --- |
| [OpenAI Symphony](https://github.com/openai/symphony/blob/main/SPEC.md) | `WORKFLOW.md` をリポジトリで管理し、作業単位の隔離、同時実行数、失敗時の再試行、稼働状態の照合をオーケストレータが担当する。変更した方針は次の実行へ反映する。 | `WORKFLOW.md` と `prompts/` を追加し、各 AI 呼び出し時に読み込む。既存の worktree と SQLite の状態管理は継続する。 |
| [Issue-Orchestrator](https://github.com/issue-orchestrator/issue-orchestrator) | 案件ごとの worktree、検証対象の正確なコミット、回数を区切った再作業、再起動後の状態照合を重視する。エージェントの「終わった」という報告だけで次へ進めない。 | 既存のローカルテスト、PR head に対する CI 確認、PM による再作業判断を維持する。このプロジェクトは人がマージする設計だが、Tonarium はユーザーの希望どおり条件を満たした PR を自動マージする。 |
| [GitHub Agentic Workflows](https://github.com/github/gh-aw) | Markdown で判断が要る仕事を記述し、ビルドやテストは通常の CI で確定する。GitHub への書き込みは別の権限境界で検証して行う。 | Bot の役割指示を Markdown 化する。テスト・PR 作成・マージの判定は引き続きコードと GitHub の結果に置き、AI の文章だけで成功扱いにしない。 |
| [Symphony の Rust 実装](https://github.com/lilCnid/symphony) | Codex と Claude Code を実行層として切り替えられる。状態が進まない案件の連続実行に上限を設ける。 | 既存の `codex` / `claude` 切り替えと回数制限を維持する。今後、同じ状態で終了と再起動を繰り返す案件の検出を追加する。 |

Symphony は作業追跡から実装までの土台、Issue-Orchestrator は検証ゲート、GitHub Agentic Workflows は判断と確定的な処理の境界が特に参考になる。これらの機能をすべて導入するという意味ではない。

## 指示ファイルの使い分け

Tonarium Agent が起動する `codex exec` と `claude -p` には、アプリ自身が `WORKFLOW.md` と担当別の `prompts/*.md` を読み、案件情報と一緒に渡す。これらは次の AI 呼び出しから反映される。秘密情報は指示ファイルに置かない。

対象コードベースの `AGENTS.md` は Codex のリポジトリ共通指示、`CLAUDE.md` は Claude Code のリポジトリ共通指示に向く。Claude Code は `.claude/agents/*.md` でネイティブのサブエージェントを定義でき、Codex のカスタムサブエージェントは `.codex/agents/*.toml` で定義する。ただし、そのどちらも今の Bot が起動する独立した CLI 実行に、Tonarium の「ひより」「さくら」などの役割文として自動で適用されるものではない。[Codex の AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Codex のサブエージェント](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Claude Code のサブエージェント](https://code.claude.com/docs/en/sub-agents)を参照。

対象の `tonarium-prototype` には既に `CLAUDE.md` がある。Claude Code はこの場合、標準設定では `AGENTS.md` を追加しても自動では併読しない。共通指示を一つにまとめるなら、`CLAUDE.md` から `@AGENTS.md` を取り込むか、Claude 側の読み込み設定を明示する。[Claude Code の指示ファイル仕様](https://code.claude.com/docs/en/memory#agentsmd)を参照。

## 次に改善する点

1. 長時間実行の進捗時刻を保存し、無反応の作業を停止・再開する。Symphony の停止検知と状態照合が参考になる。
2. 案件ごとに試行番号、使用した指示ファイルの版、作業ツリー、PR head、CI の結果をイベントとして残す。失敗時に PM が同じ条件を再実行しないための材料にする。
3. Discord 送信、Issue 作成、PR 作成、マージの直前に外部状態を読み直し、再起動後の二重実行を避ける。既存の照合を段階ごとに点検する。

参考プロジェクトの運用条件は Tonarium と同じではない。特に Claude Code の agent teams は試験的機能で、長時間の常駐運用や復旧をそのまま任せる前提には置かない。[公式の制約](https://code.claude.com/docs/en/agent-teams#limitations)を参照。
