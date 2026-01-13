import * as vscode from "vscode";
import semver from "semver";
import { VersionInfo } from "./VersionCache";

export class HttpService {
  async fetchNpmVersions(
    packageName: string,
    currentVersion: string,
    config: vscode.WorkspaceConfiguration,
    signal?: AbortSignal
  ): Promise<VersionInfo> {
    // Get timeout from config (default 30 seconds to match npm CLI)
    const timeoutMs = config.get<number>("httpTimeout", 30000);

    // Create timeout abort controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    // Combine parent signal with timeout signal
    let combinedSignal: AbortSignal;
    if (signal) {
      // If parent signal exists, listen to both signals
      const abortHandler = () => {
        clearTimeout(timeoutId);
        timeoutController.abort();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      timeoutController.signal.addEventListener("abort", () => {
        signal.removeEventListener("abort", abortHandler);
      }, { once: true });
      combinedSignal = signal.aborted ? signal : timeoutController.signal;
    } else {
      combinedSignal = timeoutController.signal;
    }

    try {
      const response = await fetch(
        `https://registry.npmjs.org/${packageName}?fields=versions,dist-tags`,
        {
          headers: {
            Accept: "application/vnd.npm.install-v1+json",
          },
          signal: combinedSignal,
        }
      );

      clearTimeout(timeoutId);

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
    for (const version of Object.keys(data.versions)) {
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

      return {
        latestMajor: latestMajor || currentVersion,
        latestMinor,
        latestPatch,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Check if this is a timeout error
      if (error.name === "AbortError") {
        if (timeoutController.signal.aborted) {
          throw new Error(
            `Request timeout after ${timeoutMs}ms fetching versions for ${packageName}`
          );
        }
        // Parent signal aborted
        throw new Error(`Request aborted for ${packageName}`);
      }

      // Re-throw other errors
      throw error;
    }
  }
}


