/**
 * スクリプト共通の CLI ユーティリティ (blog-hishaku の scripts/cli.ts から runMain のみ移植)。
 */

/**
 * 時間計測付きでメイン処理を実行する。
 *
 * 戻り値の `done` を `in <elapsed>s` 付きで出力し、`after` はその後に実行する。
 * 例外は捕捉して exitCode=1 を立てる。
 */
export async function runMain(
  run: () => Promise<{ done: string; after?: () => void | Promise<void> } | undefined>,
): Promise<void> {
  const startTime = Date.now();
  try {
    const result = await run();
    if (result) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n${result.done} in ${elapsed}s`);
      await result.after?.();
    }
  } catch (error) {
    console.error('\nError:', error);
    process.exitCode = 1;
  }
}
