/**
 * R2 とローカルディレクトリの往復同期スクリプト
 *
 * `content/img/` (画像) と `content/blog/` (記事の Markdown) は git 管理せず、
 * Cloudflare R2 を保管場所にする。このスクリプトはその往復同期を行う。
 *
 * 同期は「マージ」であり**削除は伝播しない**:
 * - 片方にしかないファイルはもう片方へ追加される
 * - 両方にあり size が同じなら内容 (MD5) が一致するかを確認してスキップ (無駄な転送を避ける)
 * - size が同じでも内容が異なる場合は、および size が異なる場合は更新日時の新しい方が勝って上書きされる
 * - どちらかから消したい場合は、両側で手動削除する (このスクリプトは消さない)
 *
 * ディレクトリ対応表 (バケット 1:1):
 * - pithos-day-img   <-> content/img
 * - pithos-day-blog  <-> content/blog
 *
 * 認証情報は環境変数 (ローカルなら .env、CI なら Workers Builds のシークレット) から読む:
 * - R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * - R2_IMG_BUCKET (既定: pithos-day-img) / R2_BLOG_BUCKET (既定: pithos-day-blog)
 *
 * その他の環境変数:
 * - R2_SYNC_IF_MISSING=1: pull で「ローカルにファイルが在るディレクトリ」の取得を省略する。
 *   CI はビルドコマンドから pnpm build 内の pull へフラグを渡せない (pnpm が引数を末尾のコマンドに
 *   付けてしまうため) ので、代わりにこの環境変数で指定する。未設定なら従来どおり。
 *
 * 使い方:
 *   pnpm sync:pull            # R2 -> ローカル (欠落分の取得と新しいファイルの反映)
 *   pnpm sync:push            # ローカル -> R2
 *   pnpm sync                 # pull -> push (両方向マージ)
 *   tsx scripts/r2-sync.ts clean   # dist/img を削除 (ビルド後に画像を同梱しないため)
 *   pnpm sync:pull -- --dry-run    # 転送せず差分だけ表示
 *   pnpm sync:pull -- --if-missing # ローカルに在る分は取得しない (CI と同じ挙動を手動で)
 */

import { createHash } from 'node:crypto';
import { createReadStream, type Dirent, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { runMain } from './cli';

const USAGE = `Usage: tsx scripts/r2-sync.ts <pull|push|both|clean> [--dry-run] [--if-missing]

  pull   R2 -> ローカル (削除は伝播しない)
  push   ローカル -> R2 (削除は伝播しない)
  both   pull の後に push (片方の新規ファイルをもう片方へ補充)
  clean  dist/img を削除する

  --dry-run     転送せず差分だけ表示
  --if-missing  pull 専用。ローカルにファイルが在るディレクトリは取得を省略する
                (CI では環境変数 R2_SYNC_IF_MISSING=1 でも指定できる)`;

const COMMANDS = ['pull', 'push', 'both', 'clean'] as const;
type Command = (typeof COMMANDS)[number];

/** 同期対象のディレクトリ (バケットとローカルディレクトリは 1:1 対応) */
const MAPPINGS = [
  {
    label: 'img',
    bucketEnv: 'R2_IMG_BUCKET',
    defaultBucket: 'pithos-day-img',
    localDir: 'content/img',
    /** 画像は CDN として配信するため Cache-Control を付与する (md 等は対象外) */
    cacheable: true,
  },
  {
    label: 'blog',
    bucketEnv: 'R2_BLOG_BUCKET',
    defaultBucket: 'pithos-day-blog',
    localDir: 'content/blog',
    cacheable: false,
  },
] as const;

/** 並列転送数 */
const TRANSFER_CONCURRENCY = 8;

/** 拡張子 -> Content-Type (R2 から配信される際の応答ヘッダになる) */
const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

/** 画像の既定 Cache-Control (旧ブログの /img/* と同じく 1 日) */
const IMAGE_CACHE_CONTROL = 'public, max-age=86400';

interface FileEntry {
  size: number;
  /** epoch ms。リモートは LastModified、ローカルは mtime */
  mtime: number;
  /** リモートのみ。シングルパート PUT の ETag は内容の MD5 そのもの */
  etag?: string;
}

type Direction = 'pull' | 'push';

/** 1 ファイルを source から destination へ転送するか */
type TransferPlan = 'transfer' | 'skip';

/** 1 ディレクトリ分の同期結果 (`transferred` は pull ならダウンロード数、push ならアップロード数) */
interface SyncResult {
  transferred: number;
  skipped: number;
  failed: number;
}

interface SyncOptions {
  dryRun: boolean;
  /** pull のとき「ローカルにファイルが在るディレクトリ」の取得を省略する */
  ifMissing: boolean;
}

interface SyncConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * `.env` を環境変数へ読み込む (CI では .env は存在しない)。
 * 既に設定されている環境変数は上書きしない (シークレット優先)。
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env が無い環境では何もしない (CI は環境変数だけで動く)
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。.env (ローカル) か Workers Builds のシークレット (CI) に設定してください。`,
    );
  }
  return value;
}

function resolveSyncConfig(): SyncConfig {
  return {
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  };
}

function createClient(config: SyncConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** 存在しないディレクトリを無視して readdir する */
async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** ローカルディレクトリ以下の全ファイルを相対パス付きで列挙する (無ければ空 Map) */
async function listLocalFiles(localDir: string): Promise<Map<string, FileEntry>> {
  const files = new Map<string, FileEntry>();
  const root = path.resolve(process.cwd(), localDir);

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdirSafe(dir)) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(relative, { size: stat.size, mtime: stat.mtimeMs });
    }
  }

  await walk(root);
  return files;
}

/** ローカルディレクトリに 1 件でもファイルが在るか (pull 失敗時の続行判定に使う) */
async function hasLocalFiles(localDir: string): Promise<boolean> {
  const files = await listLocalFiles(localDir);
  return files.size > 0;
}

/** バケット内の全オブジェクトを列挙する (末尾が / のキーはディレクトリ記号なので除外) */
async function listRemoteFiles(client: S3Client, bucket: string): Promise<Map<string, FileEntry>> {
  const files = new Map<string, FileEntry>();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) {
      if (!object.Key || object.Key.endsWith('/')) continue;
      files.set(object.Key, {
        size: object.Size ?? 0,
        mtime: object.LastModified?.getTime() ?? 0,
        // ETag は引用符で囲まれていることがあるので剥がしておく
        etag: object.ETag?.replaceAll('"', ''),
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return files;
}

/**
 * 1 ファイルを転送するかを決める。
 * source は転送元、destination は転送先 (pull なら R2 -> ローカル、push ならローカル -> R2)。
 * source に無い場合は skip (そのファイルは逆方向で補充される)。
 *
 * `contentMatches` は size が一致したファイルの内容比較結果で、
 * 比較していない (size が違う / 比較材料が無い) ときは undefined。
 * 「不一致」と確定したときだけ内容差を理由に転送する。
 */
function decideTransfer(
  source: FileEntry | undefined,
  destination: FileEntry | undefined,
  contentMatches: boolean | undefined,
): TransferPlan {
  if (!source) return 'skip';
  if (!destination) return 'transfer';
  // size が同じでも内容が異なることがある (バイト数が変わらない置換など)。
  // 比較せずに size だけで同一とみなすと、そういう変更が永遠に同期されない。
  if (source.size === destination.size && contentMatches !== false) return 'skip';
  // size または内容が異なる場合は更新日時の新しい方が勝つ (mtime だけの差で全量転送しないようにする)
  return source.mtime > destination.mtime ? 'transfer' : 'skip';
}

/**
 * ローカルファイルの内容がリモートと一致するかを MD5 で確認する (ローカルの MD5 とリモートの ETag を比較)。
 *
 * 比較材料が無い (マルチパートの ETag、読み込み失敗など) ときは undefined を返し、
 * 従来どおり size 一致を以って同一とみなす。
 */
async function matchesRemoteContent(
  localPath: string,
  remoteEtag: string | undefined,
): Promise<boolean | undefined> {
  // マルチパートアップロードの ETag は内容の MD5 ではないので比較に使えない
  if (!remoteEtag || remoteEtag.includes('-')) return undefined;

  try {
    const md5 = createHash('md5')
      .update(await fs.readFile(localPath))
      .digest('hex');
    return md5 === remoteEtag;
  } catch {
    return undefined;
  }
}

/** バケットのキー (`/` 区切り) をローカルのパスへ変換する */
function localPathFor(localDir: string, key: string): string {
  return path.join(localDir, ...key.split('/'));
}

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  localPath: string,
  entry: FileEntry,
  cacheable: boolean,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentLength: entry.size,
      ContentType: contentTypeFor(key),
      ...(cacheable ? { CacheControl: IMAGE_CACHE_CONTROL } : {}),
    }),
  );
}

async function downloadFile(
  client: S3Client,
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`空の応答: ${bucket}/${key}`);
  const bytes = await response.Body.transformToByteArray();
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, bytes);
  // 次回の新旧判定が狂わないよう、リモートの最終更新時刻をローカルへ反映する
  if (response.LastModified) {
    await fs.utimes(localPath, response.LastModified, response.LastModified);
  }
}

/** 並列度を制限しつつ全件を処理する */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * 1 ディレクトリ分の同期を行う。
 * `direction` が 'pull' なら R2 -> ローカル、'push' ならローカル -> R2。
 * 削除は行わない。
 */
async function syncMapping(
  client: S3Client,
  mapping: (typeof MAPPINGS)[number],
  direction: Direction,
  options: SyncOptions,
): Promise<SyncResult> {
  const bucket = process.env[mapping.bucketEnv] ?? mapping.defaultBucket;
  const localDir = mapping.localDir;

  // --if-missing: ローカルにファイルが在るディレクトリの pull を省略する (CI の二重 pull 回避)。
  // 判定はローカルのファイル数だけなので、このとき API は一切呼ばない。
  if (direction === 'pull' && options.ifMissing && (await hasLocalFiles(localDir))) {
    console.log(`[r2-sync] ${mapping.label}: ローカルにファイルが在るため取得を省略 (--if-missing)`);
    return { transferred: 0, skipped: 0, failed: 0 };
  }

  const [localFiles, remoteFiles] = await Promise.all([
    listLocalFiles(localDir),
    listRemoteFiles(client, bucket),
  ]);

  const isPush = direction === 'push';
  const source = isPush ? localFiles : remoteFiles;
  const destination = isPush ? remoteFiles : localFiles;
  const verb = isPush ? 'upload' : 'download';
  const result: SyncResult = { transferred: 0, skipped: 0, failed: 0 };

  const transfers: [key: string, entry: FileEntry][] = [];
  for (const [key, entry] of source) {
    const destinationEntry = destination.get(key);
    // size が同じでも内容が違う可能性があるのは、更新日時の新しい方が転送候補になっているときだけ。
    // それ以外 (同 size かつ新しい方が別側) は mtime 判定で skip するので内容比較は不要。
    let contentMatches: boolean | undefined;
    if (
      destinationEntry &&
      destinationEntry.size === entry.size &&
      entry.mtime > destinationEntry.mtime
    ) {
      const remoteEntry = isPush ? destinationEntry : entry;
      contentMatches = await matchesRemoteContent(localPathFor(localDir, key), remoteEntry.etag);
    }
    if (decideTransfer(entry, destinationEntry, contentMatches) === 'skip') {
      result.skipped += 1;
      continue;
    }
    transfers.push([key, entry]);
  }

  await runPool(transfers, TRANSFER_CONCURRENCY, async ([key, entry]) => {
    const localPath = localPathFor(localDir, key);
    try {
      if (options.dryRun) {
        console.log(`  [dry-run] ${verb.padEnd(8)} ${key}`);
      } else {
        if (isPush) {
          await uploadFile(client, bucket, key, localPath, entry, mapping.cacheable);
        } else {
          await downloadFile(client, bucket, key, localPath);
        }
        console.log(`  ${verb.padEnd(8)} ${key}`);
      }
      result.transferred += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`  Error ${direction} ${key}:`, error);
    }
  });

  console.log(
    `[r2-sync] ${mapping.label}: ${result.transferred} ${verb}ed, ${result.skipped} unchanged, ${result.failed} failed (bucket: ${bucket})`,
  );
  if (result.failed > 0) {
    throw new Error(`${mapping.label} の ${result.failed} 件の転送に失敗しました`);
  }
  return result;
}

async function runDirection(
  direction: Direction,
  config: SyncConfig,
  options: SyncOptions,
): Promise<void> {
  const client = createClient(config);
  for (const mapping of MAPPINGS) {
    await syncMapping(client, mapping, direction, options);
  }
}

/** dist/img を削除する (画像は R2 から配信されるためビルド成果物には同梱しない) */
async function cleanDistImages(): Promise<void> {
  const distImages = path.resolve(process.cwd(), 'dist', 'img');
  try {
    await fs.access(distImages);
  } catch {
    console.log('[r2-sync] dist/img は存在しません (スキップ)');
    return;
  }
  await fs.rm(distImages, { recursive: true, force: true });
  console.log('[r2-sync] dist/img を削除しました (画像は R2 から配信されます)');
}

/**
 * pull の失敗時は「ローカルにファイルが在るか」で続行を判断する。
 * ローカルが充填済みなら警告して続行 (オフラインでも作業できる)。
 * 空なら例外を再送出して終了コード 1 を返す (0 件のサイトをデプロイする事故を防ぐ)。
 */
async function pullWithFallback(config: SyncConfig, options: SyncOptions): Promise<void> {
  try {
    await runDirection('pull', config, options);
  } catch (error) {
    const emptyMappings: string[] = [];
    for (const mapping of MAPPINGS) {
      if (!(await hasLocalFiles(mapping.localDir))) emptyMappings.push(mapping.localDir);
    }
    if (emptyMappings.length > 0) {
      console.error(
        `[r2-sync] R2 から取得できない上、ローカルにも ${emptyMappings.join(', ')} にファイルがありません。`,
      );
      throw error;
    }
    console.warn(
      `[r2-sync] R2 からの取得に失敗しましたが、ローカルにファイルが在るため続行します: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<{ done: string } | undefined> {
  loadDotEnv();

  const [command, ...rest] = process.argv.slice(2);
  // pnpm は `pnpm sync:pull -- --dry-run` のような `--` をそのまま渡すため除外する
  const args = rest.filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const flagIfMissing = args.includes('--if-missing');
  const unknownArgs = args.filter((arg) => arg !== '--dry-run' && arg !== '--if-missing');
  if (unknownArgs.length > 0 || !COMMANDS.includes(command as Command)) {
    throw new Error(USAGE);
  }
  if (flagIfMissing && command !== 'pull') {
    throw new Error(`--if-missing は pull でのみ使用できます\n${USAGE}`);
  }

  // CI はビルドコマンドから pnpm build 内の pull へフラグを渡せない (pnpm が引数を末尾のコマンドに
  // 付けてしまう) ので、環境変数でも指定できる。push/both では意味を持たないため無視する。
  const options: SyncOptions = {
    dryRun,
    ifMissing: flagIfMissing || (command === 'pull' && process.env.R2_SYNC_IF_MISSING === '1'),
  };

  if (command === 'clean') {
    await cleanDistImages();
    return { done: '[r2-sync] dist/img を整理しました' };
  }

  const config = resolveSyncConfig();
  if (command === 'pull' || command === 'both') {
    await pullWithFallback(config, options);
  }
  if (command === 'push' || command === 'both') {
    // push の失敗は黙らない (git に無いデータを失うリスクが最大のため)
    await runDirection('push', config, options);
  }
  return undefined;
}

await runMain(main);
