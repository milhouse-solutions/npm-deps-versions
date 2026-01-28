import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as util from "util";
import * as fs from "fs";
import { VersionInfo } from "./VersionCache";
import { comparePep440, gtPep440, gtePep440, getVersionParts } from "./Pep440Parser";

const exec = util.promisify(cp.exec);

export class PythonCliService {
  private outputChannel: vscode.OutputChannel | undefined;

  constructor(outputChannel?: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  private log(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    }
  }

  /**
   * Detects which pip tool to use (pip or uv)
   * Checks for uv.lock file and user configuration
   */
  async detectPipTool(
    pyprojectPath: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<"pip" | "uv"> {
    const pipTool = config.get<string>("pipTool", "auto");

    if (pipTool === "pip") {
      return "pip";
    }
    if (pipTool === "uv") {
      return "uv";
    }

    // Auto-detect: check for uv.lock file
    const pyprojectDir = path.dirname(pyprojectPath);
    let currentDir = pyprojectDir;

    // Search up directory tree for uv.lock (monorepo support)
    while (currentDir !== path.dirname(currentDir)) {
      const uvLockPath = path.join(currentDir, "uv.lock");
      if (fs.existsSync(uvLockPath)) {
        this.log(`[deps-versions:Python:CLI] Found uv.lock at ${uvLockPath}, using uv`);
        return "uv";
      }
      currentDir = path.dirname(currentDir);
    }

    // Check if uv command is available
    try {
      await exec("uv --version", { timeout: 5000 });
      this.log(`[deps-versions:Python:CLI] uv command available, using uv`);
      return "uv";
    } catch {
      this.log(`[deps-versions:Python:CLI] uv not available, using pip`);
      return "pip";
    }
  }

  /**
   * Gets outdated packages by running pip list --outdated or uv pip list --outdated
   * Returns a Set of package names that are outdated
   */
  async getOutdatedPackages(
    pyprojectPath: string,
    dependencies: string[],
    config: vscode.WorkspaceConfiguration
  ): Promise<Set<string>> {
    const pyprojectDir = path.dirname(pyprojectPath);
    const tool = await this.detectPipTool(pyprojectPath, config);

    this.log(
      `[deps-versions:Python:CLI:getOutdatedPackages] Starting, pyprojectDir: ${pyprojectDir}, tool: ${tool}, checking ${dependencies.length} dependencies`
    );

    try {
      const command =
        tool === "uv"
          ? "uv pip list --outdated --format=json"
          : "pip list --outdated --format=json";

      this.log(
        `[deps-versions:Python:CLI:getOutdatedPackages] Executing: ${command} in ${pyprojectDir}`
      );

      const { stdout, stderr } = await exec(command, {
        cwd: pyprojectDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 30000, // 30 seconds timeout
      });

      this.log(
        `[deps-versions:Python:CLI:getOutdatedPackages] Command completed, stdout length: ${
          stdout?.length || 0
        }`
      );

      // Parse JSON output
      let outdatedData: Array<{ name: string; version: string; latest_version: string }> = [];
      try {
        outdatedData = JSON.parse(stdout || "[]");
        if (!Array.isArray(outdatedData)) {
          outdatedData = [];
        }
        this.log(
          `[deps-versions:Python:CLI:getOutdatedPackages] Parsed ${outdatedData.length} outdated packages`
        );
      } catch (parseError) {
        this.log(
          `[deps-versions:Python:CLI:getOutdatedPackages] Failed to parse JSON, trying text parsing: ${parseError}`
        );
        // Fallback: parse text output if JSON not available
        return this.parseTextOutdatedOutput(stdout || stderr || "", dependencies);
      }

      // Filter to only include direct dependencies
      const outdatedSet = new Set<string>();
      for (const item of outdatedData) {
        if (dependencies.includes(item.name)) {
          outdatedSet.add(item.name);
        }
      }

      this.log(
        `[deps-versions:Python:CLI:getOutdatedPackages] Returning ${
          outdatedSet.size
        } outdated packages: ${Array.from(outdatedSet).join(", ")}`
      );
      return outdatedSet;
    } catch (error: any) {
      this.log(
        `[deps-versions:Python:CLI:getOutdatedPackages] Error: ${error.message || error}`
      );

      if (error.code === "ENOENT") {
        throw new Error(
          `${tool} command not found. Please ensure ${tool} is installed and in your PATH.`
        );
      }

      if (error.killed && error.signal === "SIGTERM") {
        throw new Error(
          `${tool} list --outdated command timed out after 30 seconds.`
        );
      }

      throw new Error(
        `Failed to run ${tool} list --outdated: ${error.message || error}`
      );
    }
  }

  /**
   * Parses text output from pip list --outdated (fallback when JSON not available)
   */
  private parseTextOutdatedOutput(
    output: string,
    dependencies: string[]
  ): Set<string> {
    const outdatedSet = new Set<string>();
    const lines = output.split("\n");

    for (const line of lines) {
      // Format: Package (Current) [Latest]
      const match = line.match(/^(\S+)\s+\([^)]+\)\s+\[([^\]]+)\]/);
      if (match) {
        const packageName = match[1].toLowerCase();
        if (dependencies.includes(packageName)) {
          outdatedSet.add(packageName);
        }
      }
    }

    return outdatedSet;
  }

  /**
   * Gets package versions using pip index versions or uv pip index versions
   */
  async getPackageVersions(
    packageName: string,
    currentVersion: string,
    pyprojectPath: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<VersionInfo> {
    const pyprojectDir = path.dirname(pyprojectPath);
    const tool = await this.detectPipTool(pyprojectPath, config);

    this.log(
      `[deps-versions:Python:CLI:getPackageVersions] Starting for ${packageName}@${currentVersion}, tool: ${tool}, pyprojectDir: ${pyprojectDir}`
    );

    try {
      // Use pip index versions or uv pip index versions
      const command =
        tool === "uv"
          ? `uv pip index versions ${packageName}`
          : `pip index versions ${packageName}`;

      this.log(
        `[deps-versions:Python:CLI:getPackageVersions] Executing: ${command}`
      );

      const { stdout } = await exec(command, {
        cwd: pyprojectDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      });

      // Parse versions from output
      // Format: "Package versions: 1.0.0, 1.1.0, 2.0.0"
      const versions: string[] = [];
      const versionMatches = stdout.matchAll(/(\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]*)?)/g);
      for (const match of versionMatches) {
        versions.push(match[1]);
      }

      if (versions.length === 0) {
        // Fallback: try PyPI API
        this.log(
          `[deps-versions:Python:CLI:getPackageVersions] No versions found, will fallback to HTTP`
        );
        throw new Error("No versions found via CLI");
      }

      // Sort versions using PEP 440 comparison
      versions.sort((a, b) => comparePep440(a, b));

      const latestMajor = versions[versions.length - 1];

      // Get current version parts - skip minor/patch detection if currentVersion is invalid
      const currentParts = getVersionParts(currentVersion);
      const currentMajor = currentParts.major;
      const currentMinor = currentParts.minor;
      const currentPatch = currentParts.patch;

      // If currentVersion is "latest", "*", or invalid (all parts are 0), skip minor/patch detection
      const isValidCurrentVersion =
        currentVersion !== "latest" &&
        currentVersion !== "*" &&
        !(currentMajor === 0 && currentMinor === 0 && currentPatch === 0);

      // Find best minor and patch versions
      let bestMinor: string | undefined;
      let bestPatch: string | undefined;

      // Only search for minor/patch upgrades if we have a valid current version
      if (isValidCurrentVersion) {
        for (const version of versions) {
          // Skip if version is less than current
          if (!gtePep440(version, currentVersion)) {
            continue;
          }

          const versionParts = getVersionParts(version);
          const versionMajor = versionParts.major;
          const versionMinor = versionParts.minor;
          const versionPatch = versionParts.patch;

          // Track best minor version (same major, greater minor)
          // Find the highest version in the current major series
          if (
            versionMajor === currentMajor &&
            versionMinor > currentMinor &&
            (!bestMinor || gtPep440(version, bestMinor))
          ) {
            bestMinor = version;
          }

          // Track best patch version (same major.minor, greater patch)
          // Find the highest version in the current major.minor series
          if (
            versionMajor === currentMajor &&
            versionMinor === currentMinor &&
            versionPatch > currentPatch &&
            (!bestPatch || gtPep440(version, bestPatch))
          ) {
            bestPatch = version;
          }
        }
      }

      const result = {
        latestMajor: latestMajor || currentVersion,
        latestMinor: bestMinor && gtPep440(bestMinor, currentVersion) ? bestMinor : undefined,
        latestPatch: bestPatch && gtPep440(bestPatch, currentVersion) ? bestPatch : undefined,
      };

      this.log(
        `[deps-versions:Python:CLI:getPackageVersions] Returning version info for ${packageName}: latestMajor=${
          result.latestMajor
        }, latestMinor=${result.latestMinor || "undefined"}, latestPatch=${
          result.latestPatch || "undefined"
        }`
      );

      return result;
    } catch (error: any) {
      this.log(
        `[deps-versions:Python:CLI:getPackageVersions] Error: ${error.message || error}`
      );

      if (error.code === "ENOENT") {
        throw new Error(
          `${tool} command not found. Please ensure ${tool} is installed and in your PATH.`
        );
      }

      if (error.killed && error.signal === "SIGTERM") {
        throw new Error(
          `${tool} index versions command timed out after 30 seconds.`
        );
      }

      // Re-throw to allow HTTP fallback
      throw error;
    }
  }
}
