export type ConfigReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly text: string }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'unreadable'; readonly safeCode: string };

export interface ConfigReadCall {
  readonly operation: 'readUtf8Capped';
  readonly path: string;
  readonly maximumBytes: number;
}

export class FakeConfigReader {
  readonly calls: ConfigReadCall[] = [];
  private readonly documents = new Map<string, ConfigReadResult>();
  private readonly forbiddenPrefixes = new Set<string>();

  set(path: string, result: ConfigReadResult): void {
    this.documents.set(path, result);
  }

  forbidPrefix(pathPrefix: string): void {
    this.forbiddenPrefixes.add(pathPrefix);
  }

  async readUtf8Capped(path: string, maximumBytes: number): Promise<ConfigReadResult> {
    this.calls.push({ operation: 'readUtf8Capped', path, maximumBytes });
    for (const prefix of this.forbiddenPrefixes) {
      if (path.startsWith(prefix)) {
        throw new Error(`Forbidden synthetic config path access: ${prefix}`);
      }
    }
    return this.documents.get(path) ?? { kind: 'absent' };
  }
}
