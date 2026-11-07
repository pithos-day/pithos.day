# R2 同期 (img / blog)

記事の Markdown (`content/blog/`) と画像 (`content/img/`) は **git 管理せず、Cloudflare R2 に保管**します。
この往復同期を行うのが `scripts/r2-sync.ts` です。

- 組み立て時に `.hishaku/src/content/blog` と `.hishaku/public/img` へ symlink でつながります ([README](../README.md#仕組み))
- 画像は R2 から配信されるため、ビルド成果物 (`dist/img`) には同梱しません
- `.gitignore` に `content/` が含まれているため、誤ってコミットされることはありません

## ディレクトリ対応表

| ローカル | R2 バケット | 公開 |
| --- | --- | --- |
| `content/img/` | `pithos-day-img` | 公開 (CDN として配信) |
| `content/blog/` | `pithos-day-blog` | **非公開** (記事の原稿・下書きを含む) |

- バケットごとにローカルディレクトリを 1:1 で保持します。キーはローカルの相対パスのままなので、
  `content/blog/tech/foo.md` は `pithos-day-blog` の `tech/foo.md` になります
- 別のコレクションを増やしたら、`scripts/r2-sync.ts` の `MAPPINGS` と `scripts/assemble.ts` の `LINKS` に対応表を追加します

## 同期ルール

同期は「マージ」であり **削除は伝播しません**。

| 状態 | 動作 |
| --- | --- |
| 片方にしかないファイル | もう片方へ**追加** |
| 両方にあり size が同一 | 内容 (MD5) を比較して**一致ならスキップ** |
| 両方にあり size が同一で内容が異なる | **更新日時の新しい方が勝って上書き** |
| 両方にあり size が相違 | **更新日時の新しい方が勝って上書き** |
| 削除 | **一切伝播しない** |

> size が同一でも内容が異なることがある (「Codeberg → Github」のような**バイト数が変わらない置換**など)。
> そのため size が一致し更新日時の新しい方が転送候補になったファイルだけ、ローカルの MD5 とリモートの ETag を比較して内容差を確認します。
> 比較材料が無い場合は従来どおり size 一致を以って同一とみなします。

- `pull` で取得したファイルには、リモートの最終更新時刻がローカルの mtime に反映されます (次回以降の新旧判定が狂わないため)
- どちらかから消したい場合は、**両側で手動削除**してください (このスクリプトは消しません)
- 同名ファイルを両側で編集すると新しい方が上書きされます。競合検出はしない設計です

## コマンド

```bash
pnpm sync:pull            # R2 -> ローカル
pnpm sync:push            # ローカル -> R2
pnpm sync                 # pull -> push (片方の新規ファイルをもう片方へ補充)
pnpm sync:pull -- --dry-run    # 転送せず差分だけ表示
pnpm sync:pull -- --if-missing # ローカルにファイルが在るディレクトリの取得を省略
```

自動実行されるタイミング:

| タイミング | 実行内容 |
| --- | --- |
| `pnpm build` の最初 | `pull` |
| `pnpm build` の最後 | `dist/img` を削除 (`clean`) |
| `git push` の前 | `push` (`.husky/pre-push`) |

> `pnpm dev` は同期しません。別マシンで追加した記事・画像や R2 側の更新を使うときは、事前に `pnpm sync:pull` を実行してください。
> `git push` は同期に失敗すると止まります。急ぐときは `git push --no-verify` でスキップできます。

### CI での二重 pull を避ける

CI のビルドコマンドで `generate:lqips` / `generate:similarities` を使う場合は、その前に `pnpm sync:pull` と `pnpm assemble` を置く必要があります。
その結果 `pnpm build` の最初の pull が同じ処理をもう一度実行することになるので、**Workers Builds の環境変数に `R2_SYNC_IF_MISSING=1` を登録**すると、ローカルにファイルが既に在るディレクトリの取得が省略されます (API リクエストも発生しません)。

- ローカルには設定しない。`pnpm build` は従来どおり R2 の最新を取り込む
- **設定を忘れても挙動は変わらない** (単に pull が余計に1回走るだけ)
- `pnpm build --if-missing` のように引数で渡すことはできません (pnpm は引数をスクリプト末尾のコマンドへ付けるため、build 内の pull に届きません)
- 判定は**ディレクトリ単位** (`content/img` / `content/blog` それぞれ)。1件でもファイルが在ればそのディレクトリ全体を省略するため、**欠落した1ファイルは取り込まれません**。最新化したいときは `pnpm sync:pull` (フラグなし) を実行してください

## 認証情報

`.env` (gitignore 済み) に書きます。サンプルは [.env.example](../.env.example) を参照してください。

```bash
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_IMG_BUCKET=pithos-day-img        # 既定値あり。変更時のみ
R2_BLOG_BUCKET=pithos-day-blog      # 既定値あり。変更時のみ
```

- 既に設定されている環境変数が優先されるため、CI では `.env` ではなく Workers Builds のシークレットを使います
- トークンは **ローカル用 (Object Read & Write)** と **CI 用 (Object Read Only)** を分けるのが望ましいです
- 両バケットを 1 つのトークンで扱うには、トークン作成時に `pithos-day-img` と `pithos-day-blog` の両方を選択します

## Cloudflare 側の準備

1. R2 でバケット `pithos-day-blog` を作成する (**Public Access は Off のまま**。公開すると下書きを含む原稿がダウンロード可能になります)
2. R2 > API トークン で上記の認証情報を作成する
3. Workers Builds (デプロイ先) の Environment > Variables/Secrets に `R2_*` を登録する
   - ビルドコマンドは `pnpm build` (pull・組み立て・clean まで含む)
   - 二重 pull を避けるため `R2_SYNC_IF_MISSING=1` も登録しておくと、build 内の pull がローカルにファイルが在るディレクトリを省略します
4. `pithos.day/img/*` が R2 のカスタムドメイン (または r2.dev の公開 URL) を指すようにゾーンの Redirect Rule を設定する

## 初回セットアップ

```bash
pnpm install
cp .env.example .env             # 値を記入
pnpm sync:pull                   # 既存の R2 から記事・画像を取得 (clone 直後)
pnpm dev
```

## 失敗時の挙動

| 状況 | 挙動 |
| --- | --- |
| `pull` が失敗し、ローカルにファイルが在る | 警告して**続行** (オフラインでも作業できる) |
| `pull` が失敗し、ローカルが空 | **エラー終了** (0 件のサイトをデプロイする事故を防ぐ) |
| `push` が失敗 | **エラー終了** → `git push` が止まる (git に無いデータを失うリスクが最大のため黙らない) |

## 注意

- `pnpm preview` (`wrangler dev`) では画像が表示されません (`dist/img` を削除しているため)。画像込みの確認は `pnpm dev` を使ってください
- build は `content/img` → `dist/img` へコピーしてから削除します (数百 MB の無駄な書き込みが数秒)
- LQIP (`.cache/lqips.json`) はローカルで `pnpm generate:lqips` を実行する必要があります。CI には `.cache/` が無いため、本番ビルドでは LQIP が付きません (従来と同様)
