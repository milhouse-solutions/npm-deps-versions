import * as vscode from "vscode";
import * as path from "path";
import semver from "semver";
import { VersionCache, VersionInfo } from "./VersionCache";
import { HttpService } from "./HttpService";
import { NpmCliService } from "./NpmCliService";
import { PythonCliService } from "./PythonCliService";
import { PythonHttpService } from "./PythonHttpService";
import { PyprojectParser } from "./PyprojectParser";
import { gtPep440, gtePep440, getVersionParts } from "./Pep440Parser";

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
  private readonly httpService: HttpService;
  private readonly npmCliService: NpmCliService;
  private readonly pythonCliService: PythonCliService;
  private readonly pythonHttpService: PythonHttpService;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly activeRequests: Map<
    string,
    { abortController: AbortController; document: vscode.TextDocument }
  > = new Map();
  private updateDebounceTimer: NodeJS.Timeout | undefined;
  private pendingUpdates: PendingUpdate[] = [];
  private currentCodeLenses: Map<string, vscode.CodeLens[]> = new Map();
  private loadingDocuments: Map<string, boolean> = new Map();
  private completedLoads: Map<string, boolean> = new Map();
  private previousDependencies: Map<string, Map<string, string>> = new Map();

  constructor(outputChannel?: vscode.OutputChannel) {
    this.outputChannel =
      outputChannel || vscode.window.createOutputChannel("Deps Versions");
    this.cache = new VersionCache();
    this.httpService = new HttpService();
    this.npmCliService = new NpmCliService(this.outputChannel);
    this.pythonCliService = new PythonCliService(this.outputChannel);
    this.pythonHttpService = new PythonHttpService();

    vscode.workspace.onDidChangeConfiguration(() => {
      this._onDidChangeCodeLenses.fire();
    });

    // Cleanup expired cache entries periodically
    setInterval(() => {
      this.cache.cleanup();
    }, 60000); // Every minute
  }

  private log(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    }
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    // Detect file type
    const isPython = document.fileName.endsWith("pyproject.toml");
    const isNpm = document.fileName.endsWith("package.json");
    
    if (!isPython && !isNpm) {
      return [];
    }

    // Check if CodeLens is enabled for this ecosystem
    const configNamespace = isPython ? "deps-versions.python" : "deps-versions.npm";
    if (
      !vscode.workspace
        .getConfiguration(configNamespace)
        .get("enableCodeLens", true)
    ) {
      return [];
    }

    const documentUri = document.uri.toString();

    // Check if document has changed
    const documentChanged = this.cache.hasDocumentChanged(document);

    // Check if currently loading - return existing CodeLenses to avoid re-triggering
    if (this.loadingDocuments.get(documentUri)) {
      const existingCodeLenses = this.currentCodeLenses.get(documentUri);
      if (existingCodeLenses) {
        return existingCodeLenses;
      }
    }

    // Check if load completed and document hasn't changed - return cached CodeLenses
    if (this.completedLoads.get(documentUri) && !documentChanged) {
      const existingCodeLenses = this.currentCodeLenses.get(documentUri);
      if (existingCodeLenses) {
        return existingCodeLenses;
      }
    }

    // If document changed but we have completed loads, just update hash and return cached CodeLenses
    if (documentChanged && this.completedLoads.get(documentUri)) {
      this.cancelDocumentRequests(documentUri);
      this.cache.updateDocumentHash(document);
      const existingCodeLenses = this.currentCodeLenses.get(documentUri);
      if (existingCodeLenses) {
        return existingCodeLenses;
      }
    }

    // Check for existing in-progress request
    const existingRequest = this.activeRequests.get(documentUri);
    if (existingRequest && !documentChanged) {
      // Request already in progress and document hasn't changed
      const existingCodeLenses = this.currentCodeLenses.get(documentUri);
      if (existingCodeLenses) {
        return existingCodeLenses;
      }
    }

    // Only cancel existing requests if document actually changed (and no completed loads)
    if (documentChanged) {
      this.cancelDocumentRequests(documentUri);
      this.cache.updateDocumentHash(document);
    }

    // Parse file based on type
    let allDependencies: DependencyInfo[];
    if (isPython) {
      // Parse pyproject.toml
      allDependencies = PyprojectParser.extractDependencies(document);
    } else {
      // Parse package.json
      let packageJson: any;
      try {
        packageJson = JSON.parse(document.getText());
      } catch (error) {
        // Invalid JSON - return empty array
        return [];
      }
      allDependencies = this.extractDependencies(packageJson, document);
    }
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
    this.loadVersionsAsync(document, allDependencies, token, isPython).catch((error) => {
      // Log error but don't show to user unless critical
      this.log(`Error loading versions: ${error}`);
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

  /**
   * Compares current dependencies with previous state and returns changed dependencies
   */
  private getChangedDependencies(
    documentUri: string,
    currentDeps: DependencyInfo[]
  ): DependencyInfo[] {
    const previous = this.previousDependencies.get(documentUri);
    
    // If no previous state exists, all dependencies are considered "new"
    if (!previous) {
      return currentDeps;
    }

    const changed: DependencyInfo[] = [];

    for (const currentDep of currentDeps) {
      const previousVersion = previous.get(currentDep.name);
      
      // New dependency or version changed
      if (!previousVersion || previousVersion !== currentDep.cleanVersion) {
        changed.push(currentDep);
      }
    }

    return changed;
  }

  private async loadVersionsAsync(
    document: vscode.TextDocument,
    dependencies: DependencyInfo[],
    token: vscode.CancellationToken,
    isPython: boolean = false,
    isPartialUpdate: boolean = false
  ): Promise<void> {
    const documentUri = document.uri.toString();
    const configNamespace = isPython ? "deps-versions.python" : "deps-versions.npm";
    const config = vscode.workspace.getConfiguration(configNamespace);
    const versionGetMethod = config.get<string | undefined>("versionGetMethod");
    const useCli = versionGetMethod === "cli";
    const filePath = document.uri.fsPath;
    const fileDir = filePath ? path.dirname(filePath) : undefined;

    this.log(
      `[npm-deps-versions:loadVersionsAsync] Starting for ${
        dependencies.length
      } dependencies, method: ${
        versionGetMethod || "not set"
      }, useCli: ${useCli}, filePath: ${filePath}, fileDir: ${
        fileDir || "undefined"
      }`
    );

    // Mark document as loading
    this.loadingDocuments.set(documentUri, true);

    // Create abort controller for this document
    const abortController = new AbortController();
    this.activeRequests.set(documentUri, {
      abortController,
      document,
    });

    // Cancel if token is already cancelled
    if (token.isCancellationRequested) {
      this.log(
        `[npm-deps-versions:loadVersionsAsync] Token already cancelled, aborting`
      );
      abortController.abort();
      return;
    }

    // Listen for cancellation (if method exists)
    let cancellationListener: vscode.Disposable | undefined;
    if (token.onCancellationRequested) {
      cancellationListener = token.onCancellationRequested(() => {
        this.log(
          `[npm-deps-versions:loadVersionsAsync] Cancellation requested, aborting`
        );
        abortController.abort();
        this.activeRequests.delete(documentUri);
      });
    }

    try {
      let outdatedPackages: Set<string> | undefined;
      let cliAvailable = useCli && fileDir;

      // If using CLI, first get outdated packages
      if (cliAvailable) {
        try {
          this.log(
            `[deps-versions:loadVersionsAsync] Calling getOutdatedPackages for ${dependencies.length} packages (${isPython ? "Python" : "npm"})`
          );
          const dependencyNames = dependencies.map((dep) => dep.name);
          if (isPython) {
            outdatedPackages = await this.pythonCliService.getOutdatedPackages(
              filePath,
              dependencyNames,
              config
            );
          } else {
            outdatedPackages = await this.npmCliService.getOutdatedPackages(
              filePath,
              dependencyNames
            );
          }
          this.log(
            `[deps-versions:loadVersionsAsync] getOutdatedPackages completed, found ${
              outdatedPackages.size
            } outdated packages: ${Array.from(outdatedPackages).join(", ")}`
          );
        } catch (error) {
          // If CLI fails, disable it for this session and fall back to HTTP
          this.log(
            `[deps-versions:loadVersionsAsync] CLI getOutdatedPackages failed, disabling CLI and falling back to HTTP for all packages: ${error}`
          );
          cliAvailable = false;
          outdatedPackages = undefined;
        }
      } else {
        this.log(
          `[deps-versions:loadVersionsAsync] Skipping getOutdatedPackages (useCli: ${useCli}, fileDir: ${
            fileDir || "undefined"
          })`
        );
      }

      // Load all versions in parallel (via queue)
      this.log(
        `[deps-versions:loadVersionsAsync] Creating ${dependencies.length} version promises, cliAvailable: ${cliAvailable}`
      );
      const versionPromises = dependencies.map((dep, index) => {
        // If using CLI and package is not outdated, skip it
        if (
          cliAvailable &&
          outdatedPackages &&
          !outdatedPackages.has(dep.name)
        ) {
          this.log(
            `[deps-versions:loadVersionsAsync] Package ${dep.name} is up to date, skipping version fetch`
          );
          // Package is up to date, show "Up to date" immediately
          this.updateCodeLens(document, dep, index, {
            latestMajor: dep.cleanVersion,
            latestMinor: undefined,
            latestPatch: undefined,
          }, isPython, filePath);
          return Promise.resolve();
        }

        this.log(
          `[deps-versions:loadVersionsAsync] Starting loadVersionForDependency for ${dep.name} (index ${index}), cliAvailable: ${cliAvailable}`
        );
        return this.loadVersionForDependency(
          document,
          dep,
          index,
          abortController.signal,
          !!cliAvailable,
          filePath,
          fileDir,
          isPython,
          config
        ).then(
          () => {
            this.log(
              `[deps-versions:loadVersionsAsync] Completed loadVersionForDependency for ${dep.name} (index ${index})`
            );
          },
          (error) => {
            this.log(
              `[deps-versions:loadVersionsAsync] Failed loadVersionForDependency for ${dep.name} (index ${index}): ${error}`
            );
          }
        );
      });

      this.log(
        `[deps-versions:loadVersionsAsync] Waiting for all version promises to settle`
      );
      await Promise.allSettled(versionPromises);
      this.log(
        `[deps-versions:loadVersionsAsync] All version promises settled`
      );
    } catch (error) {
      this.log(
        `[deps-versions:loadVersionsAsync] Error in loadVersionsAsync: ${error}`
      );
      throw error;
    } finally {
      this.log(
        `[deps-versions:loadVersionsAsync] Finally block: cleaning up`
      );
      if (cancellationListener) {
        cancellationListener.dispose();
      }
      this.activeRequests.delete(documentUri);

      // Mark load as completed and no longer loading
      this.completedLoads.set(documentUri, true);
      this.loadingDocuments.set(documentUri, false);

      // Fire final update event now that loading is complete
      // Update previous dependencies state after successful load
      if (!isPartialUpdate) {
        // Full load - update all dependencies
        const currentState = new Map<string, string>();
        for (const dep of dependencies) {
          currentState.set(dep.name, dep.cleanVersion);
        }
        this.previousDependencies.set(documentUri, currentState);
        this.log(
          `[deps-versions:loadVersionsAsync] Updated previousDependencies state for ${dependencies.length} dependencies`
        );
      } else {
        // Partial update - merge changed dependencies into existing state
        const existingState = this.previousDependencies.get(documentUri) || new Map<string, string>();
        for (const dep of dependencies) {
          existingState.set(dep.name, dep.cleanVersion);
        }
        this.previousDependencies.set(documentUri, existingState);
        this.log(
          `[deps-versions:loadVersionsAsync] Updated previousDependencies state for ${dependencies.length} changed dependencies`
        );
      }

      // Fire final update event now that loading is complete
      this.log(
        `[deps-versions:loadVersionsAsync] Load complete, firing final onDidChangeCodeLenses event`
      );
      this._onDidChangeCodeLenses.fire();

      this.log(`[deps-versions:loadVersionsAsync] Cleanup complete`);
    }
  }

  private async loadVersionForDependency(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    signal: AbortSignal,
    useCli: boolean,
    filePath?: string,
    fileDir?: string,
    isPython: boolean = false,
    config?: vscode.WorkspaceConfiguration
  ): Promise<void> {
    const documentUri = document.uri.toString();
    const configNamespace = isPython ? "deps-versions.python" : "deps-versions.npm";
    const ecosystemConfig = config || vscode.workspace.getConfiguration(configNamespace);
    const ecosystem = isPython ? "python" : "npm";
    const cacheKey = `${ecosystem}:${documentUri}@${dependency.name}@${dependency.cleanVersion}`;

    this.log(
      `[deps-versions:loadVersionForDependency] Starting for ${
        dependency.name
      }@${
        dependency.cleanVersion
      } (index ${codeLensIndex}), ecosystem: ${ecosystem}, useCli: ${useCli}, filePath: ${
        filePath || "undefined"
      }, fileDir: ${fileDir || "undefined"}`
    );

    // Check cache first (with ecosystem prefix)
    const cached = this.cache.get(
      `${ecosystem}:${documentUri}`,
      dependency.name,
      dependency.cleanVersion
    );

    if (cached) {
      this.log(
        `[deps-versions:loadVersionForDependency] Found cached version for ${dependency.name}, updating CodeLens`
      );
      this.updateCodeLens(document, dependency, codeLensIndex, cached, isPython, filePath);
      return;
    }

    this.log(
      `[deps-versions:loadVersionForDependency] No cache found for ${dependency.name}, fetching version`
    );

    // Check if aborted
    if (signal.aborted) {
      this.log(
        `[deps-versions:loadVersionForDependency] Signal already aborted for ${dependency.name}`
      );
      // Don't just return - check if we have cached data that we can use
      // This can happen if cache was populated after initial check but before fetch
      const cachedAfterAbort = this.cache.get(
        `${ecosystem}:${documentUri}`,
        dependency.name,
        dependency.cleanVersion
      );
      if (cachedAfterAbort) {
        this.log(
          `[deps-versions:loadVersionForDependency] Found cached version after abort check for ${dependency.name}, updating CodeLens`
        );
        this.updateCodeLens(
          document,
          dependency,
          codeLensIndex,
          cachedAfterAbort,
          isPython,
          filePath
        );
      }
      return;
    }

    try {
      let versionInfo: VersionInfo;

      if (useCli && filePath && fileDir) {
        try {
          this.log(
            `[deps-versions:loadVersionForDependency] Calling ${ecosystem} CLI getPackageVersions for ${dependency.name}`
          );
          // Use appropriate CLI service
          if (isPython) {
            versionInfo = await this.pythonCliService.getPackageVersions(
              dependency.name,
              dependency.cleanVersion,
              filePath,
              ecosystemConfig
            );
          } else {
            versionInfo = await this.npmCliService.getPackageVersions(
              dependency.name,
              filePath,
              dependency.cleanVersion,
              ecosystemConfig
            );
          }
          this.log(
            `[deps-versions:loadVersionForDependency] ${ecosystem} CLI getPackageVersions succeeded for ${
              dependency.name
            }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
              versionInfo.latestMinor || "undefined"
            }, latestPatch=${versionInfo.latestPatch || "undefined"}`
          );
        } catch (error: any) {
          // Fallback to HTTP if CLI fails
          this.log(
            `[deps-versions:loadVersionForDependency] ${ecosystem} CLI failed for ${dependency.name}, falling back to HTTP: ${error}`
          );
          if (isPython) {
            versionInfo = await this.pythonHttpService.fetchPyPIVersions(
              dependency.name,
              dependency.cleanVersion,
              ecosystemConfig,
              signal
            );
          } else {
            versionInfo = await this.httpService.fetchNpmVersions(
              dependency.name,
              dependency.cleanVersion,
              ecosystemConfig,
              signal
            );
          }
          this.log(
            `[deps-versions:loadVersionForDependency] HTTP fallback succeeded for ${
              dependency.name
            }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
              versionInfo.latestMinor || "undefined"
            }, latestPatch=${versionInfo.latestPatch || "undefined"}`
          );
        }
      } else {
        this.log(
          `[deps-versions:loadVersionForDependency] Using HTTP service for ${dependency.name}`
        );
        // Use HTTP service
        if (isPython) {
          versionInfo = await this.pythonHttpService.fetchPyPIVersions(
            dependency.name,
            dependency.cleanVersion,
            ecosystemConfig,
            signal
          );
        } else {
          versionInfo = await this.httpService.fetchNpmVersions(
            dependency.name,
            dependency.cleanVersion,
            ecosystemConfig,
            signal
          );
        }
        this.log(
          `[deps-versions:loadVersionForDependency] HTTP service succeeded for ${
            dependency.name
          }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
            versionInfo.latestMinor || "undefined"
          }, latestPatch=${versionInfo.latestPatch || "undefined"}`
        );
      }

      if (signal.aborted) {
        this.log(
          `[deps-versions:loadVersionForDependency] Signal aborted after version fetch for ${dependency.name}`
        );
        return;
      }

      // Store in cache (with ecosystem prefix)
      this.log(
        `[deps-versions:loadVersionForDependency] Storing version info in cache for ${dependency.name}`
      );
      this.cache.set(
        `${ecosystem}:${documentUri}`,
        dependency.name,
        dependency.cleanVersion,
        versionInfo
      );

      // Update CodeLens
      this.log(
        `[deps-versions:loadVersionForDependency] Calling updateCodeLens for ${dependency.name}`
      );
      this.updateCodeLens(document, dependency, codeLensIndex, versionInfo, isPython, filePath);
      this.log(
        `[deps-versions:loadVersionForDependency] updateCodeLens completed for ${dependency.name}`
      );
    } catch (error: any) {
      if (signal.aborted) {
        this.log(
          `[deps-versions:loadVersionForDependency] Signal aborted in error handler for ${dependency.name}`
        );
        return;
      }

      this.log(
        `[deps-versions:loadVersionForDependency] Error loading version for ${dependency.name}: ${error}`
      );
      this.log(
        `[deps-versions:loadVersionForDependency] Error message: ${
          error.message || error
        }`
      );

      // Check if this is a timeout error
      const isTimeout = error.message && error.message.includes("timeout");

      // Show error in CodeLens
      this.updateCodeLensWithError(
        document,
        dependency,
        codeLensIndex,
        error,
        isTimeout
      );
    }
  }

  /**
   * Removes all CodeLenses for a dependency starting from the base index.
   * Returns the number of CodeLenses that were removed.
   */
  private removeCodeLensesForDependency(
    documentUri: string,
    baseIndex: number,
    lineNumber: number
  ): number {
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || baseIndex >= codeLenses.length) {
      return 0;
    }

    // Count how many consecutive CodeLenses belong to this dependency
    // (they're all on the same line)
    let count = 0;
    for (let i = baseIndex; i < codeLenses.length; i++) {
      const codeLens = codeLenses[i];
      if (codeLens && codeLens.range.start.line === lineNumber) {
        count++;
      } else {
        // Stop when we hit a CodeLens on a different line
        break;
      }
    }

    // Remove all CodeLenses for this dependency
    if (count > 0) {
      codeLenses.splice(baseIndex, count);
      this.log(
        `[deps-versions:removeCodeLensesForDependency] Removed ${count} CodeLens(es) starting at index ${baseIndex}`
      );
    }

    return count;
  }

  private updateCodeLens(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    versionInfo: VersionInfo,
    isPython: boolean = false,
    filePath?: string
  ): void {
      this.log(
        `[deps-versions:updateCodeLens] Starting for ${dependency.name} (index ${codeLensIndex})`
      );
    const documentUri = document.uri.toString();
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || !codeLenses[codeLensIndex]) {
      this.log(
        `[deps-versions:updateCodeLens] No codeLenses found or invalid index for ${
          dependency.name
        }, codeLenses exists: ${!!codeLenses}, index valid: ${
          codeLenses ? !!codeLenses[codeLensIndex] : false
        }`
      );
      return;
    }

    const filePathToUse = filePath || document.uri.fsPath;
    const commands: vscode.Command[] = this.buildCommands(
      dependency,
      versionInfo,
      filePathToUse,
      isPython
    );

    this.log(
      `[deps-versions:updateCodeLens] Built ${commands.length} commands for ${dependency.name}`
    );

    // Remove all existing CodeLenses for this dependency before adding new ones
    // This prevents duplicates when versions are updated
    const removedCount = this.removeCodeLensesForDependency(
      documentUri,
      codeLensIndex,
      dependency.line
    );
    if (removedCount > 0) {
      this.log(
        `[deps-versions:updateCodeLens] Removed ${removedCount} existing CodeLens(es) for ${dependency.name}`
      );
    }

    // Get the updated codeLenses array (it may have been modified by removeCodeLensesForDependency)
    const updatedCodeLenses = this.currentCodeLenses.get(documentUri);
    if (!updatedCodeLenses) {
      this.log(
        `[deps-versions:updateCodeLens] CodeLenses array was removed, cannot update`
      );
      return;
    }

    // Insert new CodeLenses at the same index (after removal, indices shift correctly)
    if (commands.length > 0) {
      // Insert all commands starting at codeLensIndex
      for (let i = 0; i < commands.length; i++) {
        updatedCodeLenses.splice(
          codeLensIndex + i,
          0,
          new vscode.CodeLens(
            new vscode.Range(dependency.line, 0, dependency.line, 0),
            commands[i]
          )
        );
      }
      this.log(
        `[deps-versions:updateCodeLens] Updated CodeLens with ${commands.length} upgrade option(s) for ${dependency.name}`
      );
    } else {
      // No upgrades available
      updatedCodeLenses.splice(
        codeLensIndex,
        0,
        new vscode.CodeLens(
          new vscode.Range(dependency.line, 0, dependency.line, 0),
          {
            command: "",
            title: "Up to date ✔︎",
            arguments: [],
          }
        )
      );
      this.log(
        `[deps-versions:updateCodeLens] Updated CodeLens to "Up to date" for ${dependency.name}`
      );
    }

    // Debounced update
    this.log(
      `[deps-versions:updateCodeLens] Calling scheduleCodeLensUpdate for ${dependency.name}`
    );
    this.scheduleCodeLensUpdate(documentUri);
    this.log(
      `[deps-versions:updateCodeLens] scheduleCodeLensUpdate called for ${dependency.name}`
    );
  }

  private updateCodeLensWithError(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    error: Error,
    isTimeout: boolean = false
  ): void {
    const documentUri = document.uri.toString();
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || !codeLenses[codeLensIndex]) {
      return;
    }

    const title = isTimeout
      ? "⏱ Timeout - Click to retry"
      : "❌ Error loading version";

    codeLenses[codeLensIndex] = new vscode.CodeLens(
      new vscode.Range(dependency.line, 0, dependency.line, 0),
      {
        command: isTimeout ? "deps-versions.refreshCache" : "",
        title: title,
        tooltip: error.message,
        arguments: [],
      }
    );

    this.scheduleCodeLensUpdate(documentUri);
  }

  private buildCommands(
    dependency: DependencyInfo,
    versionInfo: VersionInfo,
    filePath?: string,
    isPython: boolean = false
  ): vscode.Command[] {
    const commands: vscode.Command[] = [];

    if (!versionInfo.latestMajor) {
      return commands;
    }

    if (isPython) {
      // Use PEP 440 comparison for Python
      const current = dependency.cleanVersion;
      const latestMajor = versionInfo.latestMajor;

      // Check if up to date
      if (gtePep440(current, latestMajor)) {
        return commands;
      }

      const currentParts = getVersionParts(current);
      const currentMajor = currentParts.major;
      const currentMinor = currentParts.minor;
      const currentPatch = currentParts.patch;

      // Major upgrade
      const latestMajorParts = getVersionParts(latestMajor);
      if (
        gtPep440(latestMajor, current) &&
        latestMajorParts.major > currentMajor
      ) {
        commands.push({
          command: "deps-versions.codelensAction",
          title: `Major upgrade available: ${versionInfo.latestMajor}`,
          tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMajor}`,
          arguments: [
            {
              pkg: dependency.name,
              newVersion: versionInfo.latestMajor,
              filePath: filePath,
              ecosystem: "python" as const,
            },
          ],
        });
      }

      // Minor upgrade
      if (versionInfo.latestMinor) {
        const latestMinorParts = getVersionParts(versionInfo.latestMinor);
        if (
          gtPep440(versionInfo.latestMinor, current) &&
          latestMinorParts.major === currentMajor &&
          latestMinorParts.minor > currentMinor
        ) {
          commands.push({
            command: "deps-versions.codelensAction",
            title: `Minor upgrade available: ${versionInfo.latestMinor}`,
            tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMinor}`,
            arguments: [
              {
                pkg: dependency.name,
                newVersion: versionInfo.latestMinor,
                filePath: filePath,
                ecosystem: "python" as const,
              },
            ],
          });
        }
      }

      // Patch upgrade
      if (versionInfo.latestPatch) {
        const latestPatchParts = getVersionParts(versionInfo.latestPatch);
        if (
          gtPep440(versionInfo.latestPatch, current) &&
          latestPatchParts.major === currentMajor &&
          latestPatchParts.minor === currentMinor &&
          latestPatchParts.patch > currentPatch
        ) {
          commands.push({
            command: "deps-versions.codelensAction",
            title: `Patch upgrade available: ${versionInfo.latestPatch}`,
            tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestPatch}`,
            arguments: [
              {
                pkg: dependency.name,
                newVersion: versionInfo.latestPatch,
                filePath: filePath,
                ecosystem: "python" as const,
              },
            ],
          });
        }
      }
    } else {
      // Use semver for npm
      const current = semver.valid(dependency.cleanVersion);
      if (!current) {
        return commands;
      }

      const latestMajor = semver.valid(versionInfo.latestMajor);
      if (!latestMajor) {
        return commands;
      }

      // Check if up to date
      if (semver.gte(current, latestMajor)) {
        return commands;
      }

      const currentMajor = semver.major(current);
      const currentMinor = semver.minor(current);
      const currentPatch = semver.patch(current);

      // Major upgrade
      if (
        semver.gt(latestMajor, current) &&
        semver.major(latestMajor) > currentMajor
      ) {
        commands.push({
          command: "deps-versions.codelensAction",
          title: `Major upgrade available: ${versionInfo.latestMajor}`,
          tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMajor}`,
          arguments: [
            {
              pkg: dependency.name,
              newVersion: versionInfo.latestMajor,
              filePath: filePath,
              ecosystem: "npm" as const,
            },
          ],
        });
      }

      // Minor upgrade
      if (versionInfo.latestMinor) {
        const latestMinor = semver.valid(versionInfo.latestMinor);
        if (
          latestMinor &&
          semver.major(latestMinor) === currentMajor &&
          semver.minor(latestMinor) > currentMinor
        ) {
          commands.push({
            command: "deps-versions.codelensAction",
            title: `Minor upgrade available: ${versionInfo.latestMinor}`,
            tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMinor}`,
            arguments: [
              {
                pkg: dependency.name,
                newVersion: versionInfo.latestMinor,
                filePath: filePath,
                ecosystem: "npm" as const,
              },
            ],
          });
        }
      }

      // Patch upgrade
      if (versionInfo.latestPatch) {
        const latestPatch = semver.valid(versionInfo.latestPatch);
        if (
          latestPatch &&
          semver.major(latestPatch) === currentMajor &&
          semver.minor(latestPatch) === currentMinor &&
          semver.patch(latestPatch) > currentPatch
        ) {
          commands.push({
            command: "deps-versions.codelensAction",
            title: `Patch upgrade available: ${versionInfo.latestPatch}`,
            tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestPatch}`,
            arguments: [
              {
                pkg: dependency.name,
                newVersion: versionInfo.latestPatch,
                filePath: filePath,
                ecosystem: "npm" as const,
              },
            ],
          });
        }
      }
    }

    return commands;
  }

  private scheduleCodeLensUpdate(documentUri: string): void {
    // Debounce updates - max every 200ms
    if (this.updateDebounceTimer) {
      this.log(
        `[deps-versions:scheduleCodeLensUpdate] Clearing existing debounce timer`
      );
      clearTimeout(this.updateDebounceTimer);
    }

    this.log(
      `[deps-versions:scheduleCodeLensUpdate] Setting new debounce timer (200ms)`
    );
    this.updateDebounceTimer = setTimeout(() => {
      // Only fire if we're not actively loading
      const isLoading = this.loadingDocuments.get(documentUri);
      if (!isLoading) {
        this.log(
          `[deps-versions:scheduleCodeLensUpdate] Firing onDidChangeCodeLenses event`
        );
        this._onDidChangeCodeLenses.fire();
        this.log(
          `[deps-versions:scheduleCodeLensUpdate] onDidChangeCodeLenses event fired`
        );
      } else {
        this.log(
          `[deps-versions:scheduleCodeLensUpdate] Skipping event fire - document is still loading`
        );
      }
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

  /**
   * Invalidates cache for a specific document (used by refresh command)
   * Optionally invalidates only specific packages
   */
  invalidateCache(documentUri: string, packageNames?: string[]): void {
    // Invalidate for both ecosystems (cache keys are prefixed)
    const npmUri = `npm:${documentUri}`;
    const pythonUri = `python:${documentUri}`;
    
    if (packageNames && packageNames.length > 0) {
      this.cache.invalidateDependencies(npmUri, packageNames);
      this.cache.invalidateDependencies(pythonUri, packageNames);
    } else {
      this.cache.invalidateDocument(npmUri);
      this.cache.invalidateDocument(pythonUri);
      // Clear completion state so next provideCodeLenses will reload
      this.completedLoads.delete(documentUri);
      this.loadingDocuments.delete(documentUri);
      // Clear previous dependencies state for full invalidation
      this.previousDependencies.delete(documentUri);
    }
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Handles save event: compares current dependencies with previous state
   * and invalidates cache only for changed dependencies
   */
  handleDocumentSave(document: vscode.TextDocument): void {
    const documentUri = document.uri.toString();
    const isPython = document.fileName.endsWith("pyproject.toml");
    const isNpm = document.fileName.endsWith("package.json");

    if (!isPython && !isNpm) {
      return;
    }

    // Parse file to extract current dependencies
    let currentDependencies: DependencyInfo[];
    if (isPython) {
      currentDependencies = PyprojectParser.extractDependencies(document);
    } else {
      let packageJson: any;
      try {
        packageJson = JSON.parse(document.getText());
      } catch (error) {
        // Invalid JSON - invalidate all as fallback
        this.invalidateCache(documentUri);
        return;
      }
      currentDependencies = this.extractDependencies(packageJson, document);
    }
    const changedDeps = this.getChangedDependencies(documentUri, currentDependencies);

    if (changedDeps.length === 0) {
      // No changes, nothing to do
      this.log(
        `[deps-versions:handleDocumentSave] No dependency changes detected`
      );
      return;
    }

    this.log(
      `[deps-versions:handleDocumentSave] Found ${changedDeps.length} changed dependencies: ${changedDeps.map(d => d.name).join(", ")}`
    );

    this.invalidateChangedDependencies(document, changedDeps);
  }

  /**
   * Invalidates cache and updates CodeLenses only for changed dependencies
   */
  private invalidateChangedDependencies(
    document: vscode.TextDocument,
    changedDeps: DependencyInfo[]
  ): void {
    const documentUri = document.uri.toString();
    
    if (changedDeps.length === 0) {
      return;
    }

    const packageNames = changedDeps.map((dep) => dep.name);
    const isPython = document.fileName.endsWith("pyproject.toml");
    const ecosystem = isPython ? "python" : "npm";
    const ecosystemUri = `${ecosystem}:${documentUri}`;
    
    // Invalidate cache for changed dependencies (with ecosystem prefix)
    this.cache.invalidateDependencies(ecosystemUri, packageNames);

    // Get current CodeLenses
    const existingCodeLenses = this.currentCodeLenses.get(documentUri);
    if (!existingCodeLenses) {
      // No existing CodeLenses, trigger full reload
      this.completedLoads.delete(documentUri);
      this._onDidChangeCodeLenses.fire();
      return;
    }

    // Parse file to get all dependencies to find correct indices
    let allDependencies: DependencyInfo[];
    if (isPython) {
      allDependencies = PyprojectParser.extractDependencies(document);
    } else {
      let packageJson: any;
      try {
        packageJson = JSON.parse(document.getText());
      } catch (error) {
        return;
      }
      allDependencies = this.extractDependencies(packageJson, document);
    }
    
    // Create a map of dependency name to CodeLens index for quick lookup
    const depIndexMap = new Map<string, number>();
    allDependencies.forEach((dep, index) => {
      depIndexMap.set(dep.name, index);
    });

    // Create array of changed dependencies with their correct CodeLens indices
    // Process in reverse index order to avoid index shifting issues
    const changedDepsWithIndices: Array<{ dep: DependencyInfo; index: number }> = [];
    for (const changedDep of changedDeps) {
      const codeLensIndex = depIndexMap.get(changedDep.name);
      if (codeLensIndex !== undefined) {
        changedDepsWithIndices.push({ dep: changedDep, index: codeLensIndex });
      }
    }

    // Sort by index in descending order to process from last to first
    changedDepsWithIndices.sort((a, b) => b.index - a.index);

    // Remove all existing CodeLenses for changed dependencies and insert loading state
    for (const { dep: changedDep, index: codeLensIndex } of changedDepsWithIndices) {
      // Remove all existing CodeLenses for this dependency
      const removedCount = this.removeCodeLensesForDependency(
        documentUri,
        codeLensIndex,
        changedDep.line
      );
      if (removedCount > 0) {
        this.log(
          `[deps-versions:invalidateChangedDependencies] Removed ${removedCount} CodeLens(es) for ${changedDep.name}`
        );
      }

      // Get updated CodeLenses array after removal
      const updatedCodeLenses = this.currentCodeLenses.get(documentUri);
      if (updatedCodeLenses) {
        // Insert loading CodeLens at the same index
        updatedCodeLenses.splice(
          codeLensIndex,
          0,
          new vscode.CodeLens(
            new vscode.Range(changedDep.line, 0, changedDep.line, 0),
            {
              command: "",
              title: "Loading version...",
              arguments: [],
            }
          )
        );
      }
    }

    if (changedDepsWithIndices.length === 0) {
      return;
    }

    // Trigger async loading for changed dependencies only
    // Use a cancellation token that won't cancel immediately
    const token = new vscode.CancellationTokenSource().token;
    this.loadVersionsAsyncPartial(document, changedDepsWithIndices, token).catch((error) => {
      this.log(`Error loading changed versions: ${error}`);
    });

    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Loads versions for a subset of dependencies (used for partial updates on save)
   */
  private async loadVersionsAsyncPartial(
    document: vscode.TextDocument,
    dependenciesWithIndices: Array<{ dep: DependencyInfo; index: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const documentUri = document.uri.toString();
    const isPython = document.fileName.endsWith("pyproject.toml");
    const configNamespace = isPython ? "deps-versions.python" : "deps-versions.npm";
    const config = vscode.workspace.getConfiguration(configNamespace);
    const versionGetMethod = config.get<string | undefined>("versionGetMethod");
    const useCli = versionGetMethod === "cli";
    const filePath = document.uri.fsPath;
    const fileDir = filePath ? path.dirname(filePath) : undefined;

    this.log(
      `[npm-deps-versions:loadVersionsAsyncPartial] Starting for ${
        dependenciesWithIndices.length
      } changed dependencies`
    );

    try {
      let outdatedPackages: Set<string> | undefined;
      let npmCliAvailable = useCli && fileDir;

      // If using CLI, first get outdated packages
      if (npmCliAvailable) {
        try {
          const dependencyNames = dependenciesWithIndices.map((item) => item.dep.name);
          if (isPython) {
            outdatedPackages = await this.pythonCliService.getOutdatedPackages(
              filePath,
              dependencyNames,
              config
            );
          } else {
            outdatedPackages = await this.npmCliService.getOutdatedPackages(
              filePath,
              dependencyNames
            );
          }
        } catch (error) {
          npmCliAvailable = false;
          outdatedPackages = undefined;
        }
      }

      // Load versions in parallel
      const versionPromises = dependenciesWithIndices.map(({ dep, index }) => {
        // If using CLI and package is not outdated, skip it
        if (
          npmCliAvailable &&
          outdatedPackages &&
          !outdatedPackages.has(dep.name)
        ) {
          this.updateCodeLens(document, dep, index, {
            latestMajor: dep.cleanVersion,
            latestMinor: undefined,
            latestPatch: undefined,
          }, isPython, filePath);
          return Promise.resolve();
        }

        const abortController = new AbortController();
        return this.loadVersionForDependency(
          document,
          dep,
          index,
          abortController.signal,
          !!npmCliAvailable,
          filePath,
          fileDir,
          isPython,
          config
        );
      });

      await Promise.allSettled(versionPromises);

      // Update previous dependencies state with changed dependencies
      const existingState = this.previousDependencies.get(documentUri) || new Map<string, string>();
      for (const { dep } of dependenciesWithIndices) {
        existingState.set(dep.name, dep.cleanVersion);
      }
      this.previousDependencies.set(documentUri, existingState);
      this.log(
        `[deps-versions:loadVersionsAsyncPartial] Updated previousDependencies state for ${dependenciesWithIndices.length} changed dependencies`
      );

      this._onDidChangeCodeLenses.fire();
    } catch (error) {
      this.log(
        `[deps-versions:loadVersionsAsyncPartial] Error: ${error}`
      );
    }
  }
}
