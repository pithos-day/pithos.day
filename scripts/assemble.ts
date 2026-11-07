/**
 * blog-hishaku を取得し、このリポジトリのファイルを被せて `.hishaku/` に組み立てる。
 *
 * 1. `hishaku.lock` の ref (タグ名か commit SHA) を `.hishaku/` に取得する
 *    (前回と同じ ref なら取得を省略し node_modules を再利用)
 * 2. 前回被せたファイルを片付け、upstream の追跡ファイルを元に戻す
 * 3. upstream のサンプル (記事・画像・不要アセット) を削除する
 * 4. `overlay/` を同じ相対パスで上書きコピーする
 *    (about.md の `../layouts/...` のような相対 import を壊さないよう symlink ではなくコピー)
 * 5. R2 と同期する記事・画像と `.cache/` を symlink でつなぐ
 * 6. `pnpm install --frozen-lockfile` (upstream の lockfile をそのまま使う)
 *
 * 使い方:
 *   tsx scripts/assemble.ts                # 組み立て + install
 *   tsx scripts/assemble.ts --skip-install # install を省略
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMain } from './cli';

const UPSTREAM_URL = 'https://github.com/pithos-day/blog-hishaku.git';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK_DIR = path.join(ROOT, '.hishaku');
export const OVERLAY_DIR = path.join(ROOT, 'overlay');
const LOCK_FILE = path.join(ROOT, 'hishaku.lock');

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN = /^[\w.-]+$/;

/**
 * 取得した ref の記録。同じ ref なら取得を省略する。
 * タグの付け直しは検出しないため、取り直すときは `.hishaku/` を消す。
 */
const FETCHED_REF_FILE = path.join(WORK_DIR, '.git', 'hishaku-ref');

/** 前回コピーした overlay のファイル一覧 (overlay から消したファイルを片付けるため) */
const OVERLAY_MANIFEST = path.join(WORK_DIR, '.overlay-files');

/** upstream から削除するパス (サンプル記事・画像は下の LINKS で置き換わる) */
const REMOVED_FROM_UPSTREAM = ['public/assets/avatar.svg'];

/** `.hishaku/` 内のパス -> このリポジトリ内の実体 */
const LINKS: Record<string, string> = {
  'src/content/blog': 'content/blog',
  'public/img': 'content/img',
  '.cache': '.cache',
};

function git(args: string[], cwd = WORK_DIR): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

/**
 * `hishaku.lock` の ref を読む。タグ名 (例: `v1.0.1`) か 40 桁の commit SHA を受け付ける。
 */
async function readLockedRef(): Promise<string> {
  const ref = (await fs.readFile(LOCK_FILE, 'utf-8')).trim();
  if (!SHA_PATTERN.test(ref) && !TAG_PATTERN.test(ref)) {
    throw new Error(`hishaku.lock にはタグ名か 40 桁の commit SHA を書いてください (現在: "${ref}")`);
  }
  return ref;
}

/** 前回取得した ref (`.hishaku/` が無い・記録が無いときは undefined) */
async function fetchedRef(): Promise<string | undefined> {
  const recorded = await fs.readFile(FETCHED_REF_FILE, 'utf-8').catch(() => undefined);
  return recorded?.trim() || undefined;
}

async function fetchUpstream(ref: string): Promise<void> {
  console.log(`[assemble] blog-hishaku@${ref} を取得します`);
  await fs.rm(WORK_DIR, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  git(['init', '-q']);
  git(['fetch', '-q', '--depth', '1', UPSTREAM_URL, SHA_PATTERN.test(ref) ? ref : `refs/tags/${ref}`]);
  git(['checkout', '-q', 'FETCH_HEAD']);
  await fs.writeFile(FETCHED_REF_FILE, `${ref}\n`);
}

/**
 * 前回の組み立て結果を片付けて upstream の状態に戻す。
 * symlink を先に外さないと、checkout がサンプル記事を symlink 先 (content/) に書き込んでしまう。
 */
async function resetToUpstream(): Promise<void> {
  for (const target of Object.keys(LINKS)) {
    const linkPath = path.join(WORK_DIR, target);
    const stat = await fs.lstat(linkPath).catch(() => undefined);
    if (stat?.isSymbolicLink()) await fs.unlink(linkPath);
  }
  const previous = await fs.readFile(OVERLAY_MANIFEST, 'utf-8').catch(() => '');
  for (const relative of previous.split('\n').filter(Boolean)) {
    await fs.rm(path.join(WORK_DIR, relative), { force: true });
  }
  git(['checkout', '-q', '--', '.']);
}

async function removeUpstreamSamples(): Promise<void> {
  for (const relative of [...REMOVED_FROM_UPSTREAM, ...Object.keys(LINKS)]) {
    await fs.rm(path.join(WORK_DIR, relative), { recursive: true, force: true });
  }
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, base)));
    else if (entry.isFile()) files.push(path.relative(base, absolute));
  }
  return files;
}

/** overlay の 1 ファイルを `.hishaku/` へコピーする (dev の watcher からも使う) */
export async function copyOverlayFile(relative: string): Promise<void> {
  const dest = path.join(WORK_DIR, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(OVERLAY_DIR, relative), dest);
}

async function applyOverlay(): Promise<void> {
  const files = await listFiles(OVERLAY_DIR);
  for (const relative of files) await copyOverlayFile(relative);
  await fs.writeFile(OVERLAY_MANIFEST, `${files.join('\n')}\n`);
  console.log(`[assemble] overlay を ${files.length} 件コピーしました`);
}

async function linkLocalData(): Promise<void> {
  for (const [target, source] of Object.entries(LINKS)) {
    const linkPath = path.join(WORK_DIR, target);
    const sourcePath = path.join(ROOT, source);
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(path.relative(path.dirname(linkPath), sourcePath), linkPath);
  }
}

export async function assemble({ install }: { install: boolean }): Promise<void> {
  const ref = await readLockedRef();
  if ((await fetchedRef()) === ref) {
    await resetToUpstream();
  } else {
    await fetchUpstream(ref);
  }
  // upstream の .git は、次回の ref 判定と resetToUpstream の checkout に使うため残す
  await fs.writeFile(path.join(WORK_DIR, '.git', 'info', 'exclude'), '.overlay-files\n');
  await removeUpstreamSamples();
  await applyOverlay();
  await linkLocalData();
  if (install) {
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: WORK_DIR, stdio: 'inherit' });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const unknown = args.filter((arg) => arg !== '--skip-install');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}\nUsage: tsx scripts/assemble.ts [--skip-install]`);
    process.exit(1);
  }
  await runMain(async () => {
    await assemble({ install: !args.includes('--skip-install') });
    return { done: '[assemble] .hishaku/ を組み立てました' };
  });
}
