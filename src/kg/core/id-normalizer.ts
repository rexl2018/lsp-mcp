export function normalizeFileId(filePath: string): string {
  return `file://${filePath}`;
}

export function makeSymbolId(kind: string, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}