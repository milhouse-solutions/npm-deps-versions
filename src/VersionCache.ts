import * as vscode from "vscode";

export interface VersionInfo {
  latestMajor: string;
  latestMinor: string;
  latestPatch: string;
}

interface CacheEntry {
  data: VersionInfo;
  timestamp: number;
}

export class VersionCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly ttl: number = 5 * 60 * 1000; // 5 minutes in milliseconds
  private documentHashes: WeakMap<vscode.TextDocument, string> = new WeakMap();

  /**
   * Generates a cache key from document URI, package name, and current version
   */
  private getCacheKey(
    documentUri: string,
    packageName: string,
    currentVersion: string
  ): string {
    return `${documentUri}@${packageName}@${currentVersion}`;
  }

  /**
   * Gets cached version info if available and not expired
   */
  get(
    documentUri: string,
    packageName: string,
    currentVersion: string
  ): VersionInfo | undefined {
    const key = this.getCacheKey(documentUri, packageName, currentVersion);
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if entry has expired
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data;
  }

  /**
   * Stores version info in cache
   */
  set(
    documentUri: string,
    packageName: string,
    currentVersion: string,
    data: VersionInfo
  ): void {
    const key = this.getCacheKey(documentUri, packageName, currentVersion);
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidates cache for a specific document
   */
  invalidateDocument(documentUri: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${documentUri}@`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Clears all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Cleans up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Gets the hash of a document's content for change detection
   */
  getDocumentHash(document: vscode.TextDocument): string {
    const existing = this.documentHashes.get(document);
    if (existing) {
      return existing;
    }

    // Simple hash based on content length and modification time
    const hash = `${document.version}-${document.getText().length}`;
    this.documentHashes.set(document, hash);
    return hash;
  }

  /**
   * Checks if document has changed since last cache
   */
  hasDocumentChanged(document: vscode.TextDocument): boolean {
    const currentHash = `${document.version}-${document.getText().length}`;
    const cachedHash = this.documentHashes.get(document);
    return cachedHash !== currentHash;
  }

  /**
   * Updates document hash after change
   */
  updateDocumentHash(document: vscode.TextDocument): void {
    const hash = `${document.version}-${document.getText().length}`;
    this.documentHashes.set(document, hash);
  }
}
