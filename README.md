# pithos.day

[pithos.day](https://pithos.day) のソースです。テーマは [blog-hishaku](https://github.com/pithos-day/blog-hishaku) を使っています。
blog-hishaku はフォークせず、ビルド時に取得してこのリポジトリのファイルを被せて組み立てます。

## 仕組み

```
pithos.day/
  hishaku.lock   # 使う blog-hishaku のタグ名 (例: v1.0.1) か commit SHA
  overlay/       # blog-hishaku に同じ相対パスで上書きコピーするファイル (設定・about・アバター)
  content/       # R2 と同期する記事 (blog/) と画像 (img/)。git 管理外
  .cache/        # OG カード・LQIP・関連記事のキャッシュ。git 管理外
  .hishaku/      # 組み立て先。git 管理外 (毎回作り直す)
  scripts/
    assemble.ts  # 組み立て
    dev.ts       # 組み立て + astro dev + overlay の監視
    r2-sync.ts   # R2 同期
```

`pnpm assemble` (`scripts/assemble.ts`) は次の順で `.hishaku/` を作ります。

1. `hishaku.lock` のタグか commit を取得する (前回と同じなら取得を省略し、`node_modules` を再利用)
2. upstream のサンプル記事・画像と `public/assets/avatar.svg` を削除する
3. `overlay/` をコピーする
4. `content/blog` → `src/content/blog`、`content/img` → `public/img`、`.cache` → `.cache` を symlink でつなぐ
5. `pnpm install --frozen-lockfile` (upstream の lockfile をそのまま使う)

## コマンド

要件: **Node.js ≥ 22.12.0** / **pnpm 12.10.1**

```bash
pnpm install
cp .env.example .env   # R2 の認証情報を記入
pnpm sync:pull         # R2 から記事・画像を取得
pnpm dev               # 組み立てて astro dev を起動 (overlay の変更は自動で反映)
pnpm build             # pull → 組み立て → ビルド → ./dist へ移動 → dist/img を削除
pnpm preview           # ./dist を wrangler dev で確認 (画像は表示されない)
```

| コマンド | 内容 |
| --- | --- |
| `pnpm assemble` | `.hishaku/` を組み立てる (`-- --skip-install` で install を省略) |
| `pnpm generate:lqips` / `generate:similarities` | `.hishaku/` で同名の生成スクリプトを実行する (先に `pnpm assemble`) |
| `pnpm sync` / `sync:pull` / `sync:push` | R2 同期 ([docs/r2-sync.md](./docs/r2-sync.md)) |
| `pnpm check` | `scripts/` の型チェック |

記事を書く・画像を置く場所は `content/blog/` と `content/img/` です。`git push` の前に R2 へ自動で送られます。

## blog-hishaku の更新

`hishaku.lock` を使いたいタグ名 (例: `v1.0.2`) に書き換えます。リリース前の commit を使うときは、40 桁の commit SHA も書けます。
次の `pnpm dev` / `pnpm build` で取得し直されます。

- 取得し直すかどうかは `hishaku.lock` の文字列だけで判定します。同じタグ名のまま付け直されたタグを取り直すには、`.hishaku/` を削除してください
- 存在しないタグを書くと取得に失敗し、`.hishaku/` は空になります。正しい値に戻せば次回取得し直されます
upstream で `config/site.yaml` や `src/pages/about.md` のスキーマ・レイアウトが変わったときは、`overlay/` の同名ファイルも追従させてください。

## デプロイ

Cloudflare Workers Builds でデプロイします (`wrangler.jsonc`)。

- ビルドコマンド: `pnpm build`
- デプロイコマンド: `npx wrangler deploy`
- 環境変数: `R2_*` (と任意で `R2_SYNC_IF_MISSING=1`)。詳しくは [docs/r2-sync.md](./docs/r2-sync.md)

## ライセンス

[MIT](./LICENSE)
