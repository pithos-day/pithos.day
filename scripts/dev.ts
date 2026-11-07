/**
 * `.hishaku/` を組み立てて `astro dev` を起動し、`overlay/` の変更を `.hishaku/` へ反映し続ける。
 *
 * 記事・画像 (content/) は symlink なので、編集はそのまま dev サーバーに伝わる。
 * overlay から削除したファイルは反映しない (再起動すると片付く)。
 */

import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { assemble, copyOverlayFile, OVERLAY_DIR, WORK_DIR } from './assemble';

await assemble({ install: true });

const server = spawn('pnpm', ['dev', ...process.argv.slice(2).filter((arg) => arg !== '--')], {
  cwd: WORK_DIR,
  stdio: 'inherit',
});

const watcher = watch(OVERLAY_DIR, { recursive: true }, (_event, filename) => {
  if (!filename || !existsSync(path.join(OVERLAY_DIR, filename))) return;
  copyOverlayFile(filename)
    .then(() => console.log(`[dev] overlay/${filename} を反映しました`))
    .catch(() => {
      // ディレクトリの作成通知や、保存途中の一時ファイルは無視する
    });
});

server.on('exit', (code) => {
  watcher.close();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
