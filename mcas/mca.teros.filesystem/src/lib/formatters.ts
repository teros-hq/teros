import { LIMITS } from './limits';

export function formatCatN(content: string, startLine: number): string {
  const lines = content.split('\n');
  return lines
    .map((line, idx) => {
      const n = startLine + idx;
      const lineNum = String(n).padStart(5, '0');
      const truncated =
        line.length > LIMITS.MAX_LINE_CHARS
          ? `${line.slice(0, LIMITS.MAX_LINE_CHARS)}… [truncated]`
          : line;
      return `${lineNum}| ${truncated}`;
    })
    .join('\n');
}

export function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function detectFileKind(filename: string): 'text' | 'binary' | 'image' | 'unknown' {
  const lower = filename.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/.test(lower)) return 'image';
  if (/\.(pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin|wasm|mp[34]|mov|avi|woff2?|ttf|eot)$/.test(lower)) {
    return 'binary';
  }
  if (
    /\.(txt|md|ts|tsx|js|jsx|json|yml|yaml|toml|ini|env|sh|zsh|bash|rs|go|py|rb|java|kt|c|cc|cpp|h|hpp|css|scss|html?|xml|sql|lock|editorconfig|gitignore|gitattributes)$/.test(
      lower,
    )
  ) {
    return 'text';
  }
  return 'unknown';
}
