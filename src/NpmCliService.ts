import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as util from "util";
import * as fs from "fs";
import semver from "semver";
import { VersionInfo } from "./VersionCache";

const exec = util.promisify(cp.exec);

export class NpmCliService {
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
   * Formats error details for comprehensive logging
   */
  private formatErrorDetails(error: any, context: string, cwd?: string): string {
    const parts = [`[${context}] Caught error:`];
    
    if (error.message) {
      parts.push(`  Message: ${error.message}`);
    }
    
    if (error.code !== undefined) {
      parts.push(`  Exit code: ${error.code}`);
    }
    
    if (error.signal) {
      parts.push(`  Signal: ${error.signal}`);
    }
    
    if (cwd) {
      parts.push(`  Working directory (cwd): ${cwd}`);
    }
    
    if (error.stderr) {
      const stderr = error.stderr.toString().trim();
      if (stderr) {
        parts.push(`  stderr: ${stderr.substring(0, 500)}${stderr.length > 500 ? '...' : ''}`);
      }
    }
    
    if (error.stdout) {
      const stdout = error.stdout.toString().trim();
      if (stdout) {
        parts.push(`  stdout: ${stdout.substring(0, 500)}${stdout.length > 500 ? '...' : ''}`);
      }
    }
    
    return parts.join('\n');
  }

  /**
   * Validates that the directory and package.json exist before running npm commands
   */
  private validateDirectory(packageDir: string, packageJsonPath: string): void {
    this.log(
      `[npm-deps-versions:CLI:validateDirectory] Validating directory: ${packageDir}`
    );
    this.log(
      `[npm-deps-versions:CLI:validateDirectory] Expected package.json path: ${packageJsonPath}`
    );

    if (!fs.existsSync(packageDir)) {
      this.log(
        `[npm-deps-versions:CLI:validateDirectory] ERROR: Directory does not exist: ${packageDir}`
      );
      throw new Error(
        `Package directory does not exist: ${packageDir}`
      );
    }

    if (!fs.existsSync(packageJsonPath)) {
      this.log(
        `[npm-deps-versions:CLI:validateDirectory] ERROR: package.json not found at: ${packageJsonPath}`
      );
      throw new Error(
        `package.json not found at: ${packageJsonPath}`
      );
    }

    const nodeModulesPath = path.join(packageDir, "node_modules");
    const hasNodeModules = fs.existsSync(nodeModulesPath);
    this.log(
      `[npm-deps-versions:CLI:validateDirectory] Directory exists: ${packageDir}`
    );
    this.log(
      `[npm-deps-versions:CLI:validateDirectory] package.json exists: ${packageJsonPath}`
    );
    this.log(
      `[npm-deps-versions:CLI:validateDirectory] node_modules exists: ${hasNodeModules}`
    );

    if (!hasNodeModules) {
      this.log(
        `[npm-deps-versions:CLI:validateDirectory] WARNING: node_modules directory not found at: ${nodeModulesPath}. npm outdated may fail.`
      );
    }
  }

  /**
   * Gets the directory where package.json is located
   */
  private getPackageJsonDirectory(packageJsonPath: string): string {
    return path.dirname(packageJsonPath);
  }

  /**
   * Gets outdated packages by running npm outdated
   * Returns a Set of package names that are outdated
   */
  async getOutdatedPackages(
    packageJsonPath: string,
    dependencies: string[]
  ): Promise<Set<string>> {
    const packageDir = this.getPackageJsonDirectory(packageJsonPath);
    this.log(
      `[npm-deps-versions:CLI:getOutdatedPackages] Starting, packageDir: ${packageDir}, checking ${dependencies.length} dependencies`
    );

    // Validate directory and package.json exist
    try {
      this.validateDirectory(packageDir, packageJsonPath);
    } catch (validationError: any) {
      this.log(
        `[npm-deps-versions:CLI:getOutdatedPackages] Validation failed: ${validationError.message}`
      );
      throw validationError;
    }

    try {
      this.log(
        `[npm-deps-versions:CLI:getOutdatedPackages] Executing: npm outdated --json in ${packageDir}`
      );
      const { stdout, stderr } = await exec("npm outdated --json", {
        cwd: packageDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 30000, // 30 seconds timeout
      });
      this.log(
        `[npm-deps-versions:CLI:getOutdatedPackages] npm outdated command completed, stdout length: ${
          stdout?.length || 0
        }, stderr length: ${stderr?.length || 0}`
      );

      // npm outdated returns empty object {} if nothing is outdated
      // or exits with code 1 if there are outdated packages
      // We need to parse the output even if there's an error
      let outdatedData: { [key: string]: any } = {};
      try {
        outdatedData = JSON.parse(stdout || "{}");
        this.log(
          `[npm-deps-versions:CLI:getOutdatedPackages] Successfully parsed stdout JSON, found ${
            Object.keys(outdatedData).length
          } outdated packages`
        );
      } catch (parseError) {
        this.log(
          `[npm-deps-versions:CLI:getOutdatedPackages] Failed to parse stdout, trying stderr. Parse error: ${parseError}`
        );
        // If stdout is empty or invalid JSON, try stderr
        if (stderr) {
          try {
            outdatedData = JSON.parse(stderr);
            this.log(
              `[npm-deps-versions:CLI:getOutdatedPackages] Successfully parsed stderr JSON, found ${
                Object.keys(outdatedData).length
              } outdated packages`
            );
          } catch {
            this.log(
              `[npm-deps-versions:CLI:getOutdatedPackages] Failed to parse both stdout and stderr, returning empty set`
            );
            // If both fail, return empty set
            return new Set<string>();
          }
        } else {
          this.log(
            `[npm-deps-versions:CLI:getOutdatedPackages] No stderr available, returning empty set`
          );
          return new Set<string>();
        }
      }

      // Filter to only include direct dependencies/devDependencies
      const outdatedSet = new Set<string>();
      for (const depName of dependencies) {
        if (outdatedData[depName]) {
          outdatedSet.add(depName);
        }
      }

      this.log(
        `[npm-deps-versions:CLI:getOutdatedPackages] Returning ${
          outdatedSet.size
        } outdated packages: ${Array.from(outdatedSet).join(", ")}`
      );
      return outdatedSet;
    } catch (error: any) {
      this.log(
        this.formatErrorDetails(error, 'npm-deps-versions:CLI:getOutdatedPackages', packageDir)
      );
      
      // npm outdated exits with code 1 when there are outdated packages
      // This is expected behavior, so we try to parse the output anyway
      if (error.stdout) {
        this.log(
          `[npm-deps-versions:CLI:getOutdatedPackages] Error has stdout, attempting to parse: ${error.stdout.substring(
            0,
            200
          )}...`
        );
        try {
          const outdatedData = JSON.parse(error.stdout);
          const outdatedSet = new Set<string>();
          for (const depName of dependencies) {
            if (outdatedData[depName]) {
              outdatedSet.add(depName);
            }
          }
          this.log(
            `[npm-deps-versions:CLI:getOutdatedPackages] Successfully parsed error.stdout, returning ${outdatedSet.size} outdated packages`
          );
          return outdatedSet;
        } catch (parseError) {
          this.log(
            `[npm-deps-versions:CLI:getOutdatedPackages] Failed to parse error.stdout: ${parseError}`
          );
          // If parsing fails, throw the original error with detailed message
          throw new Error(
            `Failed to run npm outdated: ${error.message || error}. Exit code: ${error.code}`
          );
        }
      }

      // If npm is not found or other critical error
      if (error.code === "ENOENT") {
        this.log(
          `[npm-deps-versions:CLI:getOutdatedPackages] npm command not found (ENOENT)`
        );
        throw new Error(
          "npm command not found. Please ensure npm is installed and in your PATH."
        );
      }

      // Check for timeout error
      if (error.killed && error.signal === "SIGTERM") {
        this.log(
          `[npm-deps-versions:CLI:getOutdatedPackages] npm outdated command timed out after 30 seconds`
        );
        throw new Error(
          "npm outdated command timed out after 30 seconds. This may indicate a problem with npm or network connectivity."
        );
      }

      this.log(
        `[npm-deps-versions:CLI:getOutdatedPackages] Throwing error with exit code ${error.code}`
      );
      throw new Error(`Failed to run npm outdated: ${error.message || error}. Exit code: ${error.code}`);
    }
  }

  /**
   * Gets package versions using npm view
   */
  async getPackageVersions(
    packageName: string,
    packageJsonPath: string,
    currentVersion: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<VersionInfo> {
    const packageDir = this.getPackageJsonDirectory(packageJsonPath);
    this.log(
      `[npm-deps-versions:CLI:getPackageVersions] Starting for ${packageName}@${currentVersion}, packageDir: ${packageDir}`
    );

    // Validate directory and package.json exist
    try {
      this.validateDirectory(packageDir, packageJsonPath);
    } catch (validationError: any) {
      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] Validation failed: ${validationError.message}`
      );
      throw validationError;
    }

    try {
      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] Executing: npm view ${packageName} versions --json in ${packageDir}`
      );
      const { stdout } = await exec(`npm view ${packageName} versions --json`, {
        cwd: packageDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 30000, // 30 seconds timeout
      });
      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] npm view versions command completed, stdout length: ${
          stdout?.length || 0
        }`
      );

      const versions = JSON.parse(stdout) as string[];
      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] Parsed versions array, found ${versions.length} versions`
      );

      if (!Array.isArray(versions) || versions.length === 0) {
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] No versions found for ${packageName}`
        );
        throw new Error(`No versions found for ${packageName}`);
      }

      // Get latest version from dist-tags
      let latestMajor: string;
      try {
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] Executing: npm view ${packageName} dist-tags.latest --json`
        );
        const { stdout: distTagsOutput } = await exec(
          `npm view ${packageName} dist-tags.latest --json`,
          {
            cwd: packageDir,
            timeout: 30000, // 30 seconds timeout
          }
        );
        latestMajor = JSON.parse(distTagsOutput);
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] Got latest from dist-tags: ${latestMajor}`
        );
      } catch (distTagsError: any) {
        this.log(
          this.formatErrorDetails(distTagsError, `npm-deps-versions:CLI:getPackageVersions:distTags:${packageName}`, packageDir)
        );
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] Failed to get dist-tags.latest, using fallback to last version in array`
        );
        // Fallback to last version in array
        latestMajor = versions[versions.length - 1];
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] Using fallback latestMajor: ${latestMajor}`
        );
      }

      // Parse current version once
      const current = semver.valid(currentVersion);
      if (!current) {
        return {
          latestMajor: latestMajor || currentVersion,
          latestMinor: undefined,
          latestPatch: undefined,
        };
      }

      const currentMajor = semver.major(current);
      const currentMinor = semver.minor(current);
      const currentPatch = semver.patch(current);

      // Pre-compile regex patterns for early filtering
      const hasRc = /rc/i;
      const hasBeta = /beta/i;
      const hasAlpha = /alpha/i;
      const hasDev = /dev/i;
      const hasDash = /-/;
      const enableRc = config.get("enableReleaseCandidateUpgrades", false);
      const enableBeta = config.get("enableBetaUpgrades", false);
      const enableAlpha = config.get("enableAlphaUpgrades", false);
      const enableDev = config.get("enableDevUpgrades", false);

      // Single-pass algorithm: track best candidates during iteration
      let bestMinor: string | undefined;
      let bestPatch: string | undefined;
      let bestMinorValid: string | undefined;
      let bestPatchValid: string | undefined;

      // Single pass through all versions
      for (const version of versions) {
        // Early regex-based filtering before expensive semver operations
        if (!enableRc && hasRc.test(version)) {
          continue;
        }
        if (!enableBeta && hasBeta.test(version)) {
          continue;
        }
        if (!enableAlpha && hasAlpha.test(version)) {
          continue;
        }
        if (!enableDev && hasDev.test(version)) {
          continue;
        }
        if (hasDash.test(version)) {
          continue;
        }

        // Now validate with semver (only for versions that passed regex filter)
        const versionValid = semver.valid(version);
        if (!versionValid) {
          continue;
        }

        // Only consider versions >= current
        if (!semver.gte(versionValid, current)) {
          continue;
        }

        const versionMajor = semver.major(versionValid);
        const versionMinor = semver.minor(versionValid);
        const versionPatch = semver.patch(versionValid);

        // Track best minor version (same major, greater minor)
        if (
          versionMajor === currentMajor &&
          versionMinor > currentMinor &&
          (!bestMinorValid || semver.gt(versionValid, bestMinorValid))
        ) {
          bestMinor = version;
          bestMinorValid = versionValid;
        }

        // Track best patch version (same major.minor, greater patch)
        if (
          versionMajor === currentMajor &&
          versionMinor === currentMinor &&
          versionPatch > currentPatch &&
          (!bestPatchValid || semver.gt(versionValid, bestPatchValid))
        ) {
          bestPatch = version;
          bestPatchValid = versionValid;
        }
      }

      // Only return versions that are actually greater than currentVersion
      const latestMinor =
        bestMinorValid && semver.gt(bestMinorValid, current)
          ? bestMinor
          : undefined;

      const latestPatch =
        bestPatchValid && semver.gt(bestPatchValid, current)
          ? bestPatch
          : undefined;

      const result = {
        latestMajor: latestMajor || currentVersion,
        latestMinor,
        latestPatch,
      };
      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] Returning version info for ${packageName}: latestMajor=${
          result.latestMajor
        }, latestMinor=${result.latestMinor || "undefined"}, latestPatch=${
          result.latestPatch || "undefined"
        }`
      );
      return result;
    } catch (error: any) {
      this.log(
        this.formatErrorDetails(error, `npm-deps-versions:CLI:getPackageVersions:${packageName}`, packageDir)
      );
      
      // If npm is not found or other critical error
      if (error.code === "ENOENT") {
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] npm command not found (ENOENT) for ${packageName}`
        );
        throw new Error(
          "npm command not found. Please ensure npm is installed and in your PATH."
        );
      }

      // Check for timeout error
      if (error.killed && error.signal === "SIGTERM") {
        this.log(
          `[npm-deps-versions:CLI:getPackageVersions] npm view command timed out after 30 seconds for ${packageName}`
        );
        throw new Error(
          `npm view command timed out after 30 seconds for ${packageName}. This may indicate a problem with npm or network connectivity.`
        );
      }

      this.log(
        `[npm-deps-versions:CLI:getPackageVersions] Throwing error for ${packageName} with exit code ${error.code}`
      );
      throw new Error(
        `Failed to fetch versions for ${packageName}: ${error.message || error}. Exit code: ${error.code}`
      );
    }
  }
}
