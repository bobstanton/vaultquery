export class PathExclusions {
  private patterns: string[] = [];
  private compiled: RegExp[] = [];

  public matches(path: string, patterns: readonly string[]): boolean {
    if (patterns.length !== this.patterns.length || patterns.some((pattern, index) => pattern !== this.patterns[index])) {
      const compiled = patterns.map(pattern => new RegExp(pattern));
      this.patterns = [...patterns];
      this.compiled = compiled;
    }

    return this.compiled.some(pattern => pattern.test(path));
  }
}
