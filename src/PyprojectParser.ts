import * as vscode from "vscode";
import * as toml from "@iarna/toml";
import { extractBaseVersion } from "./Pep440Parser";

export interface DependencyInfo {
  name: string;
  currentVersion: string;
  cleanVersion: string;
  line: number;
}

export class PyprojectParser {
  /**
   * Parses pyproject.toml and extracts dependencies
   */
  static extractDependencies(
    document: vscode.TextDocument
  ): DependencyInfo[] {
    const dependencies: DependencyInfo[] = [];
    const text = document.getText();
    const lines = text.split("\n");

    try {
      const pyproject = toml.parse(text);

      // Extract from [project.dependencies] (PEP 621, array format)
      if (
        pyproject &&
        typeof pyproject === "object" &&
        !Array.isArray(pyproject) &&
        !(pyproject instanceof Date) &&
        "project" in pyproject &&
        pyproject.project &&
        typeof pyproject.project === "object" &&
        !Array.isArray(pyproject.project) &&
        !(pyproject.project instanceof Date) &&
        "dependencies" in pyproject.project
      ) {
        const deps = (pyproject.project as Record<string, unknown>).dependencies;
        if (Array.isArray(deps)) {
          for (const dep of deps) {
            const depInfo = this.parseDependencyString(dep, lines);
            if (depInfo) {
              dependencies.push(depInfo);
            }
          }
        }
      }

      // Extract from [project.optional-dependencies.*] (PEP 621 extras, array format)
      if (
        pyproject &&
        typeof pyproject === "object" &&
        !Array.isArray(pyproject) &&
        !(pyproject instanceof Date) &&
        "project" in pyproject &&
        pyproject.project &&
        typeof pyproject.project === "object" &&
        !Array.isArray(pyproject.project) &&
        !(pyproject.project instanceof Date) &&
        "optional-dependencies" in pyproject.project
      ) {
        const optionalDeps = (pyproject.project as Record<string, unknown>)[
          "optional-dependencies"
        ];
        if (typeof optionalDeps === "object" && optionalDeps !== null && !Array.isArray(optionalDeps) && !(optionalDeps instanceof Date)) {
          for (const groupName in optionalDeps) {
            const groupDeps = (optionalDeps as Record<string, unknown>)[groupName];
            if (Array.isArray(groupDeps)) {
              for (const dep of groupDeps) {
                const depInfo = this.parseDependencyString(dep, lines);
                if (depInfo) {
                  dependencies.push(depInfo);
                }
              }
            }
          }
        }
      }

      // Extract from [dependency-groups.*] (PEP 735, uv development dependencies)
      if (
        pyproject &&
        typeof pyproject === "object" &&
        !Array.isArray(pyproject) &&
        !(pyproject instanceof Date) &&
        "dependency-groups" in pyproject
      ) {
        const depGroups = (pyproject as Record<string, unknown>)[
          "dependency-groups"
        ];
        if (
          typeof depGroups === "object" &&
          depGroups !== null &&
          !Array.isArray(depGroups) &&
          !(depGroups instanceof Date)
        ) {
          for (const groupName in depGroups) {
            const groupDeps = (depGroups as Record<string, unknown>)[groupName];
            if (Array.isArray(groupDeps)) {
              for (const dep of groupDeps) {
                const depInfo = this.parseDependencyString(dep, lines);
                if (depInfo) {
                  dependencies.push(depInfo);
                }
              }
            }
          }
        }
      }

      // Extract from [tool.poetry.dependencies] (Poetry format, backward compatibility)
      if (
        pyproject &&
        typeof pyproject === "object" &&
        !Array.isArray(pyproject) &&
        !(pyproject instanceof Date) &&
        "tool" in pyproject &&
        pyproject.tool &&
        typeof pyproject.tool === "object" &&
        !Array.isArray(pyproject.tool) &&
        !(pyproject.tool instanceof Date) &&
        "poetry" in pyproject.tool &&
        pyproject.tool.poetry &&
        typeof pyproject.tool.poetry === "object" &&
        !Array.isArray(pyproject.tool.poetry) &&
        !(pyproject.tool.poetry instanceof Date) &&
        "dependencies" in pyproject.tool.poetry
      ) {
        const poetryDeps = (pyproject.tool.poetry as Record<string, unknown>)
          .dependencies;
        if (
          typeof poetryDeps === "object" &&
          poetryDeps !== null &&
          !Array.isArray(poetryDeps) &&
          !(poetryDeps instanceof Date)
        ) {
          for (const depName in poetryDeps) {
            // Skip python version specifier
            if (depName === "python") {
              continue;
            }
            const depVersion = (poetryDeps as Record<string, unknown>)[depName];
            if (typeof depVersion === "string") {
              // Format dependency string correctly
              // If version is "*" or empty, just use the name
              // Otherwise, concatenate name + version (version already has operator or is "*")
              let depString: string;
              if (depVersion === "*" || depVersion === "") {
                depString = depName;
              } else {
                depString = `${depName}${depVersion}`;
              }
              const depInfo = this.parseDependencyString(depString, lines);
              if (depInfo) {
                dependencies.push(depInfo);
              }
            }
          }
        }
      }

      // Extract from [tool.poetry.dev-dependencies] (Poetry dev, backward compatibility)
      if (
        pyproject &&
        typeof pyproject === "object" &&
        !Array.isArray(pyproject) &&
        !(pyproject instanceof Date) &&
        "tool" in pyproject &&
        pyproject.tool &&
        typeof pyproject.tool === "object" &&
        !Array.isArray(pyproject.tool) &&
        !(pyproject.tool instanceof Date) &&
        "poetry" in pyproject.tool &&
        pyproject.tool.poetry &&
        typeof pyproject.tool.poetry === "object" &&
        !Array.isArray(pyproject.tool.poetry) &&
        !(pyproject.tool.poetry instanceof Date) &&
        "dev-dependencies" in pyproject.tool.poetry
      ) {
        const poetryDevDeps = (pyproject.tool.poetry as Record<string, unknown>)[
          "dev-dependencies"
        ];
        if (
          typeof poetryDevDeps === "object" &&
          poetryDevDeps !== null &&
          !Array.isArray(poetryDevDeps) &&
          !(poetryDevDeps instanceof Date)
        ) {
          for (const depName in poetryDevDeps) {
            const depVersion = (poetryDevDeps as Record<string, unknown>)[
              depName
            ];
            if (typeof depVersion === "string") {
              // Format dependency string correctly
              // If version is "*" or empty, just use the name
              // Otherwise, concatenate name + version (version already has operator or is "*")
              let depString: string;
              if (depVersion === "*" || depVersion === "") {
                depString = depName;
              } else {
                depString = `${depName}${depVersion}`;
              }
              const depInfo = this.parseDependencyString(depString, lines);
              if (depInfo) {
                dependencies.push(depInfo);
              }
            }
          }
        }
      }
    } catch (error) {
      // Invalid TOML - return empty array
      console.error("Failed to parse pyproject.toml:", error);
      return [];
    }

    return dependencies;
  }

  /**
   * Parses a dependency string and extracts name, version, and line number
   * Examples:
   * - "httpx"
   * - "ruff>=0.3.0"
   * - "requests>=2.25.0,<3.0.0"
   */
  private static parseDependencyString(
    dep: string,
    lines: string[]
  ): DependencyInfo | null {
    if (typeof dep !== "string") {
      return null;
    }

    // Extract package name and version specifier
    // Pattern: package_name[version_specifier]
    // Examples: "httpx", "ruff>=0.3.0", "requests>=2.25.0,<3.0.0"
    const trimmedDep = dep.trim();

    // Find the first version operator or end of package name
    // Note: "==" must come before "=" to avoid false matches
    const versionOperators = [">=", "<=", "==", "!=", "~=", ">", "<", "="];
    let nameEnd = trimmedDep.length;
    let versionStart = trimmedDep.length;

    for (const op of versionOperators) {
      const index = trimmedDep.indexOf(op);
      if (index !== -1 && index < nameEnd) {
        nameEnd = index;
        versionStart = index;
      }
    }

    const name = trimmedDep.substring(0, nameEnd).trim();
    const versionSpec = trimmedDep.substring(versionStart).trim();

    if (!name) {
      return null;
    }

    // Extract base version from specifier
    const cleanVersion = versionSpec
      ? extractBaseVersion(versionSpec)
      : "latest";

    // Find line number
    const line = this.findDependencyLine(lines, name, versionSpec || "");

    return {
      name,
      currentVersion: versionSpec || "*",
      cleanVersion,
      line: line !== -1 ? line : 0,
    };
  }

  /**
   * Finds the line number where a dependency is declared
   */
  private static findDependencyLine(
    lines: string[],
    name: string,
    version: string
  ): number {
    // Try to find the dependency by name
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Check if line contains the package name (could be in quotes)
      if (
        line.includes(`"${name}"`) ||
        line.includes(`'${name}'`) ||
        line.includes(name)
      ) {
        // If version is specified, check if it's on the same line
        if (!version || line.includes(version)) {
          return i;
        }
      }
    }
    return -1;
  }
}
