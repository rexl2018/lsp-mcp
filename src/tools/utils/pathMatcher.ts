/**
 * Path matcher utility for glob pattern matching
 * Similar to .gitignore pattern matching
 */

export class PathMatcher {
  private patterns: string[] = [];

  constructor(patterns: string[] = []) {
    this.patterns = patterns;
  }

  /**
   * Check if a path matches any of the patterns
   */
  matches(path: string): boolean {
    if (!path || this.patterns.length === 0) {
      return false;
    }

    // Normalize path (use forward slashes)
    const normalizedPath = path.replace(/\\/g, '/');

    for (const pattern of this.patterns) {
      if (this.matchPattern(normalizedPath, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a path matches a specific pattern
   */
  private matchPattern(path: string, pattern: string): boolean {
    // Normalize pattern (use forward slashes)
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Convert glob pattern to regex
    let regexPattern = normalizedPattern
      // Escape regex special chars except * and ?
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Convert ** to match any path segment
      .replace(/\*\*/g, '.*')
      // Convert * to match any character except /
      .replace(/\*/g, '[^/]*')
      // Convert ? to match any single character except /
      .replace(/\?/g, '[^/]');

    // Ensure pattern matches the whole path
    if (!regexPattern.startsWith('^')) {
      regexPattern = `.*${regexPattern}`;
    }
    if (!regexPattern.endsWith('$')) {
      regexPattern = `${regexPattern}.*`;
    }

    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(path);
  }
}

/**
 * Create a new path matcher
 */
export function createPathMatcher(patterns: string[] = []): PathMatcher {
  return new PathMatcher(patterns);
}

/**
 * Check if a path matches any of the patterns
 */
export function matchesAnyPattern(path: string, patterns: string[] = []): boolean {
  return createPathMatcher(patterns).matches(path);
}