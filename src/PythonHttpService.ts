import * as vscode from "vscode";
import { VersionInfo } from "./VersionCache";
import {
  comparePep440,
  gtPep440,
  gtePep440,
  getVersionParts,
} from "./Pep440Parser";

export class PythonHttpService {
  async fetchPyPIVersions(
    packageName: string,
    currentVersion: string,
    config: vscode.WorkspaceConfiguration,
    signal?: AbortSignal
  ): Promise<VersionInfo> {
    // Get timeout from config (default 30 seconds)
    const timeoutMs = config.get<number>("httpTimeout", 30000);

    // Create timeout abort controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    // Combine parent signal with timeout signal
    let combinedSignal: AbortSignal;
    if (signal) {
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
        `https://pypi.org/pypi/${packageName}/json`,
        {
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
        releases: { [key: string]: any[] };
      };

      // Extract all version strings from releases object
      const versions = Object.keys(data.releases || {});

      if (versions.length === 0) {
        throw new Error(`No versions found for ${packageName}`);
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

      // Filter versions based on config (similar to npm)
      const enableRc = config.get("enableReleaseCandidateUpgrades", false);
      const enableBeta = config.get("enableBetaUpgrades", false);
      const enableAlpha = config.get("enableAlphaUpgrades", false);
      const enableDev = config.get("enableDevUpgrades", false);

      // Find best minor and patch versions
      let bestMinor: string | undefined;
      let bestPatch: string | undefined;

      // Only search for minor/patch upgrades if we have a valid current version
      if (isValidCurrentVersion) {
        for (const version of versions) {
          // Filter pre-release versions based on config
          if (!enableRc && /rc/i.test(version)) {
            continue;
          }
          if (!enableBeta && /b/i.test(version)) {
            continue;
          }
          if (!enableAlpha && /a/i.test(version)) {
            continue;
          }
          if (!enableDev && /dev/i.test(version)) {
            continue;
          }

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

      // Only return versions that are actually greater than currentVersion
      const latestMinor =
        bestMinor && gtPep440(bestMinor, currentVersion)
          ? bestMinor
          : undefined;

      const latestPatch =
        bestPatch && gtPep440(bestPatch, currentVersion)
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
