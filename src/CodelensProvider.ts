import * as vscode from "vscode";
import semver from "semver";
import { VersionCache, VersionInfo } from "./VersionCache";
import { RequestQueue } from "./RequestQueue";

interface DependencyInfo {
  name: string;
  currentVersion: string;
  cleanVersion: string;
  line: number;
}

interface PendingUpdate {
  dependency: DependencyInfo;
  codeLensIndex: number;
}

export class CodelensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  private readonly cache: VersionCache;
  private readonly requestQueue: RequestQueue;
  private readonly activeRequests: Map<
    string,
    { abortController: AbortController; document: vscode.TextDocument }
  > = new Map();
  private updateDebounceTimer: NodeJS.Timeout | undefined;
  private pendingUpdates: PendingUpdate[] = [];
  private currentCodeLenses: Map<string, vscode.CodeLens[]> = new Map();

  constructor() {
    this.cache = new VersionCache();
    this.requestQueue = new RequestQueue(5, 3, 1000); // max 5 concurrent, 3 retries, 1s base delay

    vscode.workspace.onDidChangeConfiguration(() => {
      this._onDidChangeCodeLenses.fire();
    });

    // Cleanup expired cache entries periodically
    setInterval(() => {
      this.cache.cleanup();
    }, 60000); // Every minute
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    // Check if CodeLens is enabled
    if (
      !vscode.workspace
        .getConfiguration("npm-deps-versions")
        .get("enableCodeLens", true)
    ) {
      return [];
    }

    // Cancel any existing requests for this document
    this.cancelDocumentRequests(document.uri.toString());

    // Check if document has changed
    if (this.cache.hasDocumentChanged(document)) {
      this.cache.invalidateDocument(document.uri.toString());
      this.cache.updateDocumentHash(document);
    }

    // Parse package.json with error handling
    let packageJson: any;
    try {
      packageJson = JSON.parse(document.getText());
    } catch (error) {
      // Invalid JSON - return empty array
      return [];
    }

    const allDependencies = this.extractDependencies(packageJson, document);
    const documentUri = document.uri.toString();
    const codeLenses: vscode.CodeLens[] = [];

    // Create initial CodeLenses with "Loading..." state
    for (const dep of allDependencies) {
      const loadingCodeLens = new vscode.CodeLens(
        new vscode.Range(dep.line, 0, dep.line, 0),
        {
          command: "",
          title: "Loading version...",
          arguments: [],
        }
      );
      codeLenses.push(loadingCodeLens);
    }

    // Store code lenses for this document
    this.currentCodeLenses.set(documentUri, codeLenses);

    // Start async loading of versions
    this.loadVersionsAsync(document, allDependencies, token).catch((error) => {
      // Log error but don't show to user unless critical
      console.error("Error loading versions:", error);
    });

    return codeLenses;
  }

  private extractDependencies(
    packageJson: any,
    document: vscode.TextDocument
  ): DependencyInfo[] {
    const dependencies: DependencyInfo[] = [];
    const allDeps = Object.entries({
      ...((packageJson.dependencies as { [key: string]: string }) || {}),
      ...((packageJson.devDependencies as { [key: string]: string }) || {}),
    });

    const text = document.getText();
    const lines = text.split("\n");

    for (const [name, currentVersion] of allDeps) {
      if (!name || !currentVersion) {
        continue;
      }

      // Find line number efficiently
      const line = this.findDependencyLine(lines, name, currentVersion);
      if (line === -1) {
        continue;
      }

      // Clean version (remove ^, ~, etc.)
      const cleanVersion = currentVersion.replace(/^[\^~]/, "");

      dependencies.push({
        name,
        currentVersion,
        cleanVersion,
        line,
      });
    }

    return dependencies;
  }

  private findDependencyLine(
    lines: string[],
    name: string,
    version: string
  ): number {
    const searchPattern = `"${name}": "${version}"`;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(searchPattern)) {
        return i;
      }
    }
    return -1;
  }

  private async loadVersionsAsync(
    document: vscode.TextDocument,
    dependencies: DependencyInfo[],
    token: vscode.CancellationToken
  ): Promise<void> {
    const documentUri = document.uri.toString();

    // Create abort controller for this document
    const abortController = new AbortController();
    this.activeRequests.set(documentUri, {
      abortController,
      document,
    });

    // Cancel if token is already cancelled
    if (token.isCancellationRequested) {
      abortController.abort();
      return;
    }

    // Listen for cancellation (if method exists)
    let cancellationListener: vscode.Disposable | undefined;
    if (token.onCancellationRequested) {
      cancellationListener = token.onCancellationRequested(() => {
        abortController.abort();
        this.activeRequests.delete(documentUri);
      });
    }

    try {
      // Load all versions in parallel (via queue)
      const versionPromises = dependencies.map((dep, index) =>
        this.loadVersionForDependency(
          document,
          dep,
          index,
          abortController.signal
        )
      );

      await Promise.allSettled(versionPromises);
    } finally {
      if (cancellationListener) {
        cancellationListener.dispose();
      }
      this.activeRequests.delete(documentUri);
    }
  }

  private async loadVersionForDependency(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    signal: AbortSignal
  ): Promise<void> {
    const documentUri = document.uri.toString();

    // Check cache first
    const cached = this.cache.get(
      documentUri,
      dependency.name,
      dependency.cleanVersion
    );

    if (cached) {
      this.updateCodeLens(document, dependency, codeLensIndex, cached);
      return;
    }

    // Check if aborted
    if (signal.aborted) {
      return;
    }

    try {
      // Fetch from npm registry via queue
      const versionInfo = await this.requestQueue.enqueue(
        () => this.fetchNpmVersions(dependency.name, dependency.cleanVersion),
        signal.aborted ? new AbortController() : undefined
      );

      if (signal.aborted) {
        return;
      }

      // Store in cache
      this.cache.set(
        documentUri,
        dependency.name,
        dependency.cleanVersion,
        versionInfo
      );

      // Update CodeLens
      this.updateCodeLens(document, dependency, codeLensIndex, versionInfo);
    } catch (error: any) {
      if (signal.aborted) {
        return;
      }

      // Show error in CodeLens
      this.updateCodeLensWithError(document, dependency, codeLensIndex, error);
    }
  }

  private updateCodeLens(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    versionInfo: VersionInfo
  ): void {
    const documentUri = document.uri.toString();
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || !codeLenses[codeLensIndex]) {
      return;
    }

    const commands: vscode.Command[] = this.buildCommands(
      dependency,
      versionInfo
    );

    // Replace loading CodeLens with actual commands
    if (commands.length > 0) {
      codeLenses[codeLensIndex] = new vscode.CodeLens(
        new vscode.Range(dependency.line, 0, dependency.line, 0),
        commands[0]
      );

      // Add additional CodeLenses if needed (for multiple upgrade options)
      for (let i = 1; i < commands.length; i++) {
        codeLenses.splice(
          codeLensIndex + i,
          0,
          new vscode.CodeLens(
            new vscode.Range(dependency.line, 0, dependency.line, 0),
            commands[i]
          )
        );
      }
    } else {
      // No upgrades available
      codeLenses[codeLensIndex] = new vscode.CodeLens(
        new vscode.Range(dependency.line, 0, dependency.line, 0),
        {
          command: "",
          title: "Up to date ✔︎",
          arguments: [],
        }
      );
    }

    // Debounced update
    this.scheduleCodeLensUpdate();
  }

  private updateCodeLensWithError(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    error: Error
  ): void {
    const documentUri = document.uri.toString();
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || !codeLenses[codeLensIndex]) {
      return;
    }

    codeLenses[codeLensIndex] = new vscode.CodeLens(
      new vscode.Range(dependency.line, 0, dependency.line, 0),
      {
        command: "",
        title: "Error loading version",
        tooltip: error.message,
        arguments: [],
      }
    );

    this.scheduleCodeLensUpdate();
  }

  private buildCommands(
    dependency: DependencyInfo,
    versionInfo: VersionInfo
  ): vscode.Command[] {
    const commands: vscode.Command[] = [];

    if (
      !versionInfo.latestMajor ||
      !versionInfo.latestMinor ||
      !versionInfo.latestPatch
    ) {
      return commands;
    }

    const current = semver.valid(dependency.cleanVersion);
    if (!current) {
      return commands;
    }

    const latestMajor = semver.valid(versionInfo.latestMajor);
    const latestMinor = semver.valid(versionInfo.latestMinor);
    const latestPatch = semver.valid(versionInfo.latestPatch);

    if (!latestMajor || !latestMinor || !latestPatch) {
      return commands;
    }

    // Check if up to date
    if (semver.gte(current, latestMajor)) {
      return commands; // Will show "Up to date" in updateCodeLens
    }

    const currentMajor = semver.major(current);
    const currentMinor = semver.minor(current);
    const currentPatch = semver.patch(current);

    // Major upgrade
    if (semver.major(latestMajor) > currentMajor) {
      commands.push({
        command: "npm-deps-versions.codelensAction",
        title: `Major upgrade available: ${versionInfo.latestMajor}`,
        tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMajor}`,
        arguments: [
          { pkg: dependency.name, newVersion: versionInfo.latestMajor },
        ],
      });
    }

    // Minor upgrade
    if (
      semver.major(latestMinor) === currentMajor &&
      semver.minor(latestMinor) > currentMinor
    ) {
      commands.push({
        command: "npm-deps-versions.codelensAction",
        title: `Minor upgrade available: ${versionInfo.latestMinor}`,
        tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMinor}`,
        arguments: [
          { pkg: dependency.name, newVersion: versionInfo.latestMinor },
        ],
      });
    }

    // Patch upgrade
    if (
      semver.major(latestPatch) === currentMajor &&
      semver.minor(latestPatch) === currentMinor &&
      semver.patch(latestPatch) > currentPatch
    ) {
      commands.push({
        command: "npm-deps-versions.codelensAction",
        title: `Patch upgrade available: ${versionInfo.latestPatch}`,
        tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestPatch}`,
        arguments: [
          { pkg: dependency.name, newVersion: versionInfo.latestPatch },
        ],
      });
    }

    return commands;
  }

  private scheduleCodeLensUpdate(): void {
    // Debounce updates - max every 200ms
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }

    this.updateDebounceTimer = setTimeout(() => {
      this._onDidChangeCodeLenses.fire();
      this.updateDebounceTimer = undefined;
    }, 200);
  }

  private cancelDocumentRequests(documentUri: string): void {
    const request = this.activeRequests.get(documentUri);
    if (request) {
      request.abortController.abort();
      this.activeRequests.delete(documentUri);
    }
  }

  async fetchNpmVersions(
    packageName: string,
    currentVersion: string
  ): Promise<VersionInfo> {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch versions for ${packageName}: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      "dist-tags": { latest: string };
      versions: { [key: string]: any };
    };

    const latestMajor = data["dist-tags"].latest;
    const config = vscode.workspace.getConfiguration("npm-deps-versions");

    const versions = Object.keys(data.versions).filter((version) => {
      // Check pre-release flags
      if (
        !config.get("enableReleaseCandidateUpgrades", false) &&
        version.includes("rc")
      ) {
        return false;
      }
      if (
        !config.get("enableBetaUpgrades", false) &&
        version.includes("beta")
      ) {
        return false;
      }
      if (
        !config.get("enableAlphaUpgrades", false) &&
        version.includes("alpha")
      ) {
        return false;
      }
      if (!config.get("enableDevUpgrades", false) && version.includes("dev")) {
        return false;
      }

      // Filter out versions with dashes (pre-releases) unless enabled
      if (version.includes("-")) {
        return false;
      }

      // Use semver to compare versions
      const current = semver.valid(currentVersion);
      if (!current) {
        return false;
      }

      const versionValid = semver.valid(version);
      if (!versionValid) {
        return false;
      }

      // Only include versions >= current
      return semver.gte(versionValid, current);
    });

    // Find latest minor (same major)
    const currentMajor = semver.major(currentVersion) || 0;
    const latestMinor = versions
      .filter((v) => {
        const valid = semver.valid(v);
        return valid && semver.major(valid) === currentMajor;
      })
      .sort((a, b) => {
        const aValid = semver.valid(a);
        const bValid = semver.valid(b);
        if (!aValid || !bValid) {
          return 0;
        }
        return semver.rcompare(aValid, bValid);
      })[0];

    // Find latest patch (same major.minor)
    const currentMinor = semver.minor(currentVersion) || 0;
    const latestPatch = versions
      .filter((v) => {
        const valid = semver.valid(v);
        return (
          valid &&
          semver.major(valid) === currentMajor &&
          semver.minor(valid) === currentMinor
        );
      })
      .sort((a, b) => {
        const aValid = semver.valid(a);
        const bValid = semver.valid(b);
        if (!aValid || !bValid) {
          return 0;
        }
        return semver.rcompare(aValid, bValid);
      })[0];

    return {
      latestMajor: latestMajor || currentVersion,
      latestMinor: latestMinor || currentVersion,
      latestPatch: latestPatch || currentVersion,
    };
  }

  /**
   * Invalidates cache for a specific document (used by refresh command)
   */
  invalidateCache(documentUri: string): void {
    this.cache.invalidateDocument(documentUri);
    this._onDidChangeCodeLenses.fire();
  }
}
