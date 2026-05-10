// utils/atomicWrite.ts — Atomic file write via temp + rename
// Why: No half-written JSON configs that crash the server on restart.

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = filePath + ".tmp";
  await Bun.write(tempPath, content);
  await Bun.rename(tempPath, filePath);
}
