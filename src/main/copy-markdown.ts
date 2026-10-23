export async function copyMarkdown(
  source: string | null,
  writeText: (text: string) => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  if (!source) return

  try {
    await writeText(source)
  } catch (error) {
    onError(error)
  }
}
