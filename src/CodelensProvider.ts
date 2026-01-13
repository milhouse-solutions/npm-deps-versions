import * as vscode from "vscode";
import * as path from "path";
import semver from "semver";
import { VersionCache, VersionInfo } from "./VersionCache";
import { HttpService } from "./HttpService";
import { NpmCliService } from "./NpmCliService";

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

  constructor(outputChannel?: vscode.OutputChannel) {
    this.outputChannel =
      outputChannel || vscode.window.createOutputChannel("NPM Deps Versions");
    this.cache = new VersionCache();
    this.httpService = new HttpService();
    this.npmCliService = new NpmCliService(this.outputChannel);

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
    // Check if CodeLens is enabled
    if (
      !vscode.workspace
        .getConfiguration("npm-deps-versions")
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

    // Check for existing in-progress request
    const existingRequest = this.activeRequests.get(documentUri);
    if (existingRequest && !documentChanged) {
      // Request already in progress and document hasn't changed
      const existingCodeLenses = this.currentCodeLenses.get(documentUri);
      if (existingCodeLenses) {
        return existingCodeLenses;
      }
    }

    // Only cancel existing requests if document actually changed
    if (documentChanged) {
      this.cancelDocumentRequests(documentUri);
      this.cache.invalidateDocument(documentUri);
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

  private async loadVersionsAsync(
    document: vscode.TextDocument,
    dependencies: DependencyInfo[],
    token: vscode.CancellationToken
  ): Promise<void> {
    const documentUri = document.uri.toString();
    const config = vscode.workspace.getConfiguration("npm-deps-versions");
    const versionGetMethod = config.get<string | undefined>("versionGetMethod");
    const useNpmCli = versionGetMethod === "cli";
    const packageJsonPath = document.uri.fsPath;
    const packageJsonDir = packageJsonPath
      ? path.dirname(packageJsonPath)
      : undefined;

    this.log(
      `[npm-deps-versions:loadVersionsAsync] Starting for ${
        dependencies.length
      } dependencies, method: ${
        versionGetMethod || "not set"
      }, useNpmCli: ${useNpmCli}, packageJsonPath: ${packageJsonPath}, packageJsonDir: ${
        packageJsonDir || "undefined"
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
      let npmCliAvailable = useNpmCli && packageJsonDir;

      // If using npm CLI, first get outdated packages
      if (npmCliAvailable) {
        try {
          this.log(
            `[npm-deps-versions:loadVersionsAsync] Calling getOutdatedPackages for ${dependencies.length} packages`
          );
          const dependencyNames = dependencies.map((dep) => dep.name);
          outdatedPackages = await this.npmCliService.getOutdatedPackages(
            packageJsonPath,
            dependencyNames
          );
          this.log(
            `[npm-deps-versions:loadVersionsAsync] getOutdatedPackages completed, found ${
              outdatedPackages.size
            } outdated packages: ${Array.from(outdatedPackages).join(", ")}`
          );
        } catch (error) {
          // If npm CLI fails, disable it for this session and fall back to HTTP
          this.log(
            `[npm-deps-versions:loadVersionsAsync] npm CLI getOutdatedPackages failed, disabling npm CLI and falling back to HTTP for all packages: ${error}`
          );
          npmCliAvailable = false;
          outdatedPackages = undefined;
        }
      } else {
        this.log(
          `[npm-deps-versions:loadVersionsAsync] Skipping getOutdatedPackages (useNpmCli: ${useNpmCli}, packageJsonDir: ${
            packageJsonDir || "undefined"
          })`
        );
      }

      // Load all versions in parallel (via queue)
      this.log(
        `[npm-deps-versions:loadVersionsAsync] Creating ${dependencies.length} version promises, npmCliAvailable: ${npmCliAvailable}`
      );
      const versionPromises = dependencies.map((dep, index) => {
        // If using npm CLI and package is not outdated, skip it
        if (
          npmCliAvailable &&
          outdatedPackages &&
          !outdatedPackages.has(dep.name)
        ) {
          this.log(
            `[npm-deps-versions:loadVersionsAsync] Package ${dep.name} is up to date, skipping version fetch`
          );
          // Package is up to date, show "Up to date" immediately
          this.updateCodeLens(document, dep, index, {
            latestMajor: dep.cleanVersion,
            latestMinor: undefined,
            latestPatch: undefined,
          });
          return Promise.resolve();
        }

        this.log(
          `[npm-deps-versions:loadVersionsAsync] Starting loadVersionForDependency for ${dep.name} (index ${index}), npmCliAvailable: ${npmCliAvailable}`
        );
        return this.loadVersionForDependency(
          document,
          dep,
          index,
          abortController.signal,
          !!npmCliAvailable,
          packageJsonPath,
          packageJsonDir
        ).then(
          () => {
            this.log(
              `[npm-deps-versions:loadVersionsAsync] Completed loadVersionForDependency for ${dep.name} (index ${index})`
            );
          },
          (error) => {
            this.log(
              `[npm-deps-versions:loadVersionsAsync] Failed loadVersionForDependency for ${dep.name} (index ${index}): ${error}`
            );
          }
        );
      });

      this.log(
        `[npm-deps-versions:loadVersionsAsync] Waiting for all version promises to settle`
      );
      await Promise.allSettled(versionPromises);
      this.log(
        `[npm-deps-versions:loadVersionsAsync] All version promises settled`
      );
    } catch (error) {
      this.log(
        `[npm-deps-versions:loadVersionsAsync] Error in loadVersionsAsync: ${error}`
      );
      throw error;
    } finally {
      this.log(
        `[npm-deps-versions:loadVersionsAsync] Finally block: cleaning up`
      );
      if (cancellationListener) {
        cancellationListener.dispose();
      }
      this.activeRequests.delete(documentUri);

      // Mark load as completed and no longer loading
      this.completedLoads.set(documentUri, true);
      this.loadingDocuments.set(documentUri, false);

      // Fire final update event now that loading is complete
      this.log(
        `[npm-deps-versions:loadVersionsAsync] Load complete, firing final onDidChangeCodeLenses event`
      );
      this._onDidChangeCodeLenses.fire();

      this.log(`[npm-deps-versions:loadVersionsAsync] Cleanup complete`);
    }
  }

  private async loadVersionForDependency(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    signal: AbortSignal,
    useNpmCli: boolean,
    packageJsonPath?: string,
    packageJsonDir?: string
  ): Promise<void> {
    const documentUri = document.uri.toString();
    const config = vscode.workspace.getConfiguration("npm-deps-versions");

    this.log(
      `[npm-deps-versions:loadVersionForDependency] Starting for ${
        dependency.name
      }@${
        dependency.cleanVersion
      } (index ${codeLensIndex}), useNpmCli: ${useNpmCli}, packageJsonPath: ${
        packageJsonPath || "undefined"
      }, packageJsonDir: ${packageJsonDir || "undefined"}`
    );

    // Check cache first
    const cached = this.cache.get(
      documentUri,
      dependency.name,
      dependency.cleanVersion
    );

    if (cached) {
      this.log(
        `[npm-deps-versions:loadVersionForDependency] Found cached version for ${dependency.name}, updating CodeLens`
      );
      this.updateCodeLens(document, dependency, codeLensIndex, cached);
      return;
    }

    this.log(
      `[npm-deps-versions:loadVersionForDependency] No cache found for ${dependency.name}, fetching version`
    );

    // Check if aborted
    if (signal.aborted) {
      this.log(
        `[npm-deps-versions:loadVersionForDependency] Signal already aborted for ${dependency.name}`
      );
      // Don't just return - check if we have cached data that we can use
      // This can happen if cache was populated after initial check but before fetch
      const cachedAfterAbort = this.cache.get(
        documentUri,
        dependency.name,
        dependency.cleanVersion
      );
      if (cachedAfterAbort) {
        this.log(
          `[npm-deps-versions:loadVersionForDependency] Found cached version after abort check for ${dependency.name}, updating CodeLens`
        );
        this.updateCodeLens(
          document,
          dependency,
          codeLensIndex,
          cachedAfterAbort
        );
      }
      return;
    }

    try {
      let versionInfo: VersionInfo;

      if (useNpmCli && packageJsonPath && packageJsonDir) {
        try {
          this.log(
            `[npm-deps-versions:loadVersionForDependency] Calling npm CLI getPackageVersions for ${dependency.name}`
          );
          // Use npm CLI service
          versionInfo = await this.npmCliService.getPackageVersions(
            dependency.name,
            packageJsonPath,
            dependency.cleanVersion,
            config
          );
          this.log(
            `[npm-deps-versions:loadVersionForDependency] npm CLI getPackageVersions succeeded for ${
              dependency.name
            }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
              versionInfo.latestMinor || "undefined"
            }, latestPatch=${versionInfo.latestPatch || "undefined"}`
          );
        } catch (error: any) {
          // Fallback to HTTP if npm CLI fails
          this.log(
            `[npm-deps-versions:loadVersionForDependency] npm CLI failed for ${dependency.name}, falling back to HTTP: ${error}`
          );
          versionInfo = await this.httpService.fetchNpmVersions(
            dependency.name,
            dependency.cleanVersion,
            config,
            signal
          );
          this.log(
            `[npm-deps-versions:loadVersionForDependency] HTTP fallback succeeded for ${
              dependency.name
            }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
              versionInfo.latestMinor || "undefined"
            }, latestPatch=${versionInfo.latestPatch || "undefined"}`
          );
        }
      } else {
        this.log(
          `[npm-deps-versions:loadVersionForDependency] Using HTTP service for ${dependency.name}`
        );
        // Use HTTP service
        versionInfo = await this.httpService.fetchNpmVersions(
          dependency.name,
          dependency.cleanVersion,
          config,
          signal
        );
        this.log(
          `[npm-deps-versions:loadVersionForDependency] HTTP service succeeded for ${
            dependency.name
          }: latestMajor=${versionInfo.latestMajor}, latestMinor=${
            versionInfo.latestMinor || "undefined"
          }, latestPatch=${versionInfo.latestPatch || "undefined"}`
        );
      }

      if (signal.aborted) {
        this.log(
          `[npm-deps-versions:loadVersionForDependency] Signal aborted after version fetch for ${dependency.name}`
        );
        return;
      }

      // Store in cache
      this.log(
        `[npm-deps-versions:loadVersionForDependency] Storing version info in cache for ${dependency.name}`
      );
      this.cache.set(
        documentUri,
        dependency.name,
        dependency.cleanVersion,
        versionInfo
      );

      // Update CodeLens
      this.log(
        `[npm-deps-versions:loadVersionForDependency] Calling updateCodeLens for ${dependency.name}`
      );
      this.updateCodeLens(document, dependency, codeLensIndex, versionInfo);
      this.log(
        `[npm-deps-versions:loadVersionForDependency] updateCodeLens completed for ${dependency.name}`
      );
    } catch (error: any) {
      if (signal.aborted) {
        this.log(
          `[npm-deps-versions:loadVersionForDependency] Signal aborted in error handler for ${dependency.name}`
        );
        return;
      }

      this.log(
        `[npm-deps-versions:loadVersionForDependency] Error loading version for ${dependency.name}: ${error}`
      );
      this.log(
        `[npm-deps-versions:loadVersionForDependency] Error message: ${
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

  private updateCodeLens(
    document: vscode.TextDocument,
    dependency: DependencyInfo,
    codeLensIndex: number,
    versionInfo: VersionInfo
  ): void {
    this.log(
      `[npm-deps-versions:updateCodeLens] Starting for ${dependency.name} (index ${codeLensIndex})`
    );
    const documentUri = document.uri.toString();
    const codeLenses = this.currentCodeLenses.get(documentUri);
    if (!codeLenses || !codeLenses[codeLensIndex]) {
      this.log(
        `[npm-deps-versions:updateCodeLens] No codeLenses found or invalid index for ${
          dependency.name
        }, codeLenses exists: ${!!codeLenses}, index valid: ${
          codeLenses ? !!codeLenses[codeLensIndex] : false
        }`
      );
      return;
    }

    const packageJsonPath = document.uri.fsPath;
    const commands: vscode.Command[] = this.buildCommands(
      dependency,
      versionInfo,
      packageJsonPath
    );

    this.log(
      `[npm-deps-versions:updateCodeLens] Built ${commands.length} commands for ${dependency.name}`
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
      this.log(
        `[npm-deps-versions:updateCodeLens] Updated CodeLens with ${commands.length} upgrade option(s) for ${dependency.name}`
      );
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
      this.log(
        `[npm-deps-versions:updateCodeLens] Updated CodeLens to "Up to date" for ${dependency.name}`
      );
    }

    // Debounced update
    this.log(
      `[npm-deps-versions:updateCodeLens] Calling scheduleCodeLensUpdate for ${dependency.name}`
    );
    this.scheduleCodeLensUpdate(documentUri);
    this.log(
      `[npm-deps-versions:updateCodeLens] scheduleCodeLensUpdate called for ${dependency.name}`
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
        command: isTimeout ? "npm-deps-versions.refreshCache" : "",
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
    packageJsonPath?: string
  ): vscode.Command[] {
    const commands: vscode.Command[] = [];

    if (!versionInfo.latestMajor) {
      return commands;
    }

    const current = semver.valid(dependency.cleanVersion);
    if (!current) {
      return commands;
    }

    const latestMajor = semver.valid(versionInfo.latestMajor);
    if (!latestMajor) {
      return commands;
    }

    // Check if up to date (no upgrades available at all)
    if (semver.gte(current, latestMajor)) {
      return commands; // Will show "Up to date" in updateCodeLens
    }

    const currentMajor = semver.major(current);
    const currentMinor = semver.minor(current);
    const currentPatch = semver.patch(current);

    // Major upgrade - only if actually greater than current
    if (
      semver.gt(latestMajor, current) &&
      semver.major(latestMajor) > currentMajor
    ) {
      commands.push({
        command: "npm-deps-versions.codelensAction",
        title: `Major upgrade available: ${versionInfo.latestMajor}`,
        tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMajor}`,
        arguments: [
          {
            pkg: dependency.name,
            newVersion: versionInfo.latestMajor,
            packageJsonPath: packageJsonPath,
          },
        ],
      });
    }

    // Minor upgrade - only if latestMinor is defined and greater than current
    if (versionInfo.latestMinor) {
      const latestMinor = semver.valid(versionInfo.latestMinor);
      if (
        latestMinor &&
        semver.major(latestMinor) === currentMajor &&
        semver.minor(latestMinor) > currentMinor
      ) {
        commands.push({
          command: "npm-deps-versions.codelensAction",
          title: `Minor upgrade available: ${versionInfo.latestMinor}`,
          tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestMinor}`,
          arguments: [
            {
              pkg: dependency.name,
              newVersion: versionInfo.latestMinor,
              packageJsonPath: packageJsonPath,
            },
          ],
        });
      }
    }

    // Patch upgrade - only if latestPatch is defined and greater than current
    if (versionInfo.latestPatch) {
      const latestPatch = semver.valid(versionInfo.latestPatch);
      if (
        latestPatch &&
        semver.major(latestPatch) === currentMajor &&
        semver.minor(latestPatch) === currentMinor &&
        semver.patch(latestPatch) > currentPatch
      ) {
        commands.push({
          command: "npm-deps-versions.codelensAction",
          title: `Patch upgrade available: ${versionInfo.latestPatch}`,
          tooltip: `Upgrades ${dependency.name} from ${dependency.cleanVersion} to ${versionInfo.latestPatch}`,
          arguments: [
            {
              pkg: dependency.name,
              newVersion: versionInfo.latestPatch,
              packageJsonPath: packageJsonPath,
            },
          ],
        });
      }
    }

    return commands;
  }

  private scheduleCodeLensUpdate(documentUri: string): void {
    // Debounce updates - max every 200ms
    if (this.updateDebounceTimer) {
      this.log(
        `[npm-deps-versions:scheduleCodeLensUpdate] Clearing existing debounce timer`
      );
      clearTimeout(this.updateDebounceTimer);
    }

    this.log(
      `[npm-deps-versions:scheduleCodeLensUpdate] Setting new debounce timer (200ms)`
    );
    this.updateDebounceTimer = setTimeout(() => {
      // Only fire if we're not actively loading
      const isLoading = this.loadingDocuments.get(documentUri);
      if (!isLoading) {
        this.log(
          `[npm-deps-versions:scheduleCodeLensUpdate] Firing onDidChangeCodeLenses event`
        );
        this._onDidChangeCodeLenses.fire();
        this.log(
          `[npm-deps-versions:scheduleCodeLensUpdate] onDidChangeCodeLenses event fired`
        );
      } else {
        this.log(
          `[npm-deps-versions:scheduleCodeLensUpdate] Skipping event fire - document is still loading`
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
   */
  invalidateCache(documentUri: string): void {
    this.cache.invalidateDocument(documentUri);
    // Clear completion state so next provideCodeLenses will reload
    this.completedLoads.delete(documentUri);
    this.loadingDocuments.delete(documentUri);
    this._onDidChangeCodeLenses.fire();
  }
}
