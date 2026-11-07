/**
 * `.hishaku/` を組み立てて `astro dev` を起動し、`overlay/` の変更を `.hishaku/` へ反映し続ける。
 *
 * 記事・画像 (content/) は symlink なので、編集はそのまま dev サーバーに伝わる。
 * overlay から削除したファイルは反映しない (再起動すると片付く)。
 */

import { spawn, spawnSync } from 'node:child_process';
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

// TTY が無い環境では astro dev がバックグラウンドで起動し、pnpm dev はすぐ終了する。
// その場合も watcher は残し、終了時に `astro dev stop` でサーバーを止める。
let background = false;
let stopping = false;

server.on('exit', (code) => {
  if (code === 0 && !stopping) {
    background = true;
    console.log('[dev] astro dev はバックグラウンドで動いています。Ctrl+C で停止します');
    return;
  }
  watcher.close();
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    if (!background) {
      server.kill(signal);
      return;
    }
    watcher.close();
    spawnSync('pnpm', ['exec', 'astro', 'dev', 'stop'], { cwd: WORK_DIR, stdio: 'inherit' });
    process.exit(0);
  });
}
