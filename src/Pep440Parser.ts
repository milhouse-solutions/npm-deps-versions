/**
 * PEP 440 version parser and comparator
 * Python uses PEP 440 versioning (not semver), which supports formats like:
 * - 1.2.3
 * - 1.2.3.post1
 * - 1.2.3a1 (alpha)
 * - 1.2.3b1 (beta)
 * - 1.2.3rc1 (release candidate)
 * - 1.2.3.dev1 (development)
 */

export interface Pep440Version {
  epoch?: number;
  release: number[];
  pre?: { type: "a" | "b" | "rc"; number: number };
  post?: number;
  dev?: number;
  local?: string;
}

/**
 * Parses a PEP 440 version string into components
 * Simplified parser - handles common cases
 */
export function parsePep440(version: string): Pep440Version | null {
  // Remove whitespace
  version = version.trim();

  // Strip leading single = if version doesn't start with a digit (fallback for edge cases)
  if (version.startsWith("=") && !version.startsWith("==") && !/^\d/.test(version)) {
    version = version.substring(1).trim();
  }

  // Handle epoch (e.g., "1!2.3.4")
  let epoch: number | undefined;
  let versionPart = version;
  if (version.includes("!")) {
    const parts = version.split("!");
    epoch = parseInt(parts[0], 10);
    if (isNaN(epoch)) {
      return null;
    }
    versionPart = parts[1];
  }

  // Handle local version (e.g., "1.2.3+local")
  let local: string | undefined;
  if (versionPart.includes("+")) {
    const parts = versionPart.split("+");
    versionPart = parts[0];
    local = parts.slice(1).join("+");
  }

  // Extract release segment (e.g., "1.2.3")
  const releaseMatch = versionPart.match(/^(\d+(?:\.\d+)*)/);
  if (!releaseMatch) {
    return null;
  }

  const release = releaseMatch[1].split(".").map((n) => parseInt(n, 10));
  let remaining = versionPart.substring(releaseMatch[0].length);

  // Extract pre-release (a, b, rc)
  let pre: { type: "a" | "b" | "rc"; number: number } | undefined;
  const preMatch = remaining.match(/^([ab]|rc)(\d+)/i);
  if (preMatch) {
    const type = preMatch[1].toLowerCase() as "a" | "b" | "rc";
    const number = parseInt(preMatch[2], 10);
    if (type === "a") {
      pre = { type: "a", number };
    } else if (type === "b") {
      pre = { type: "b", number };
    } else {
      pre = { type: "rc", number };
    }
    remaining = remaining.substring(preMatch[0].length);
  }

  // Extract post-release (postN)
  let post: number | undefined;
  const postMatch = remaining.match(/^\.?post(\d+)/i);
  if (postMatch) {
    post = parseInt(postMatch[1], 10);
    remaining = remaining.substring(postMatch[0].length);
  }

  // Extract dev (devN)
  let dev: number | undefined;
  const devMatch = remaining.match(/^\.?dev(\d+)/i);
  if (devMatch) {
    dev = parseInt(devMatch[1], 10);
    remaining = remaining.substring(devMatch[0].length);
  }

  return {
    epoch,
    release,
    pre,
    post,
    dev,
    local,
  };
}

/**
 * Compares two PEP 440 versions
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function comparePep440(v1: string, v2: string): number {
  const parsed1 = parsePep440(v1);
  const parsed2 = parsePep440(v2);

  if (!parsed1 || !parsed2) {
    // Fallback to string comparison if parsing fails
    return v1.localeCompare(v2);
  }

  // Compare epoch
  const epoch1 = parsed1.epoch ?? 0;
  const epoch2 = parsed2.epoch ?? 0;
  if (epoch1 !== epoch2) {
    return epoch1 < epoch2 ? -1 : 1;
  }

  // Compare release segments
  const release1 = parsed1.release;
  const release2 = parsed2.release;
  const maxLen = Math.max(release1.length, release2.length);
  for (let i = 0; i < maxLen; i++) {
    const r1 = release1[i] ?? 0;
    const r2 = release2[i] ?? 0;
    if (r1 !== r2) {
      return r1 < r2 ? -1 : 1;
    }
  }

  // Pre-release versions are less than final versions
  if (parsed1.pre && !parsed2.pre) {
    return -1;
  }
  if (!parsed1.pre && parsed2.pre) {
    return 1;
  }
  if (parsed1.pre && parsed2.pre) {
    // Compare pre-release types: a < b < rc
    const preOrder = { a: 0, b: 1, rc: 2 };
    if (parsed1.pre.type !== parsed2.pre.type) {
      return preOrder[parsed1.pre.type] < preOrder[parsed2.pre.type] ? -1 : 1;
    }
    if (parsed1.pre.number !== parsed2.pre.number) {
      return parsed1.pre.number < parsed2.pre.number ? -1 : 1;
    }
  }

  // Post-release versions are greater than non-post versions
  if (parsed1.post && !parsed2.post) {
    return 1;
  }
  if (!parsed1.post && parsed2.post) {
    return -1;
  }
  if (parsed1.post && parsed2.post) {
    if (parsed1.post !== parsed2.post) {
      return parsed1.post < parsed2.post ? -1 : 1;
    }
  }

  // Dev versions are less than non-dev versions
  if (parsed1.dev && !parsed2.dev) {
    return -1;
  }
  if (!parsed1.dev && parsed2.dev) {
    return 1;
  }
  if (parsed1.dev && parsed2.dev) {
    if (parsed1.dev !== parsed2.dev) {
      return parsed1.dev < parsed2.dev ? -1 : 1;
    }
  }

  // Local versions are compared as strings
  if (parsed1.local && parsed2.local) {
    const localCmp = parsed1.local.localeCompare(parsed2.local);
    if (localCmp !== 0) {
      return localCmp;
    }
  }

  return 0;
}

/**
 * Checks if v1 >= v2
 */
export function gtePep440(v1: string, v2: string): boolean {
  return comparePep440(v1, v2) >= 0;
}

/**
 * Checks if v1 > v2
 */
export function gtPep440(v1: string, v2: string): boolean {
  return comparePep440(v1, v2) > 0;
}

/**
 * Extracts base version from a version specifier
 * Examples:
 * - "requests>=2.25.0,<3.0.0" -> "2.25.0"
 * - "django==4.2.0" -> "4.2.0"
 * - "numpy~=1.20.0" -> "1.20.0"
 */
export function extractBaseVersion(specifier: string): string {
  // Remove whitespace
  specifier = specifier.trim();

  // Handle single = at the start (e.g., "=38.0.1")
  if (specifier.startsWith("=") && !specifier.startsWith("==")) {
    const version = specifier.substring(1).trim();
    // Remove trailing comma and extra constraints
    const cleanVersion = version.split(",")[0].trim();
    return cleanVersion;
  }

  // Try to extract version from operator + version pattern
  // Match: (operator)(whitespace)(version)
  // Operators: >=, <=, ==, ~=, !=, >, <
  const operatorMatch = specifier.match(/^(>=|<=|==|~=|!=|>|<)\s*(.+)$/);
  if (operatorMatch) {
    const version = operatorMatch[2].trim();
    // Remove trailing comma and extra constraints
    const cleanVersion = version.split(",")[0].trim();
    return cleanVersion;
  }

  // No operator found - return the version as-is (might already be clean)
  // Remove trailing comma and extra constraints
  const cleanVersion = specifier.split(",")[0].trim();
  return cleanVersion;
}

/**
 * Gets major, minor, patch from a PEP 440 version
 */
export function getVersionParts(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const parsed = parsePep440(version);
  if (!parsed || parsed.release.length === 0) {
    return { major: 0, minor: 0, patch: 0 };
  }

  return {
    major: parsed.release[0] ?? 0,
    minor: parsed.release[1] ?? 0,
    patch: parsed.release[2] ?? 0,
  };
}
