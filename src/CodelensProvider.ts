import * as vscode from "vscode";

export class CodelensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((_) => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    if (
      vscode.workspace
        .getConfiguration("npm-deps-versions")
        .get("enableCodeLens", true)
    ) {
      const packageJson = JSON.parse(document.getText());
      const allDependencies = Object.entries({
        ...((packageJson.dependencies as { [key: string]: string }) || {}),
        ...((packageJson.devDependencies as { [key: string]: string }) || {}),
      });

      for (const [name, currentVersion] of allDependencies) {
        const cleanCurrentVersion = currentVersion.replace(/\^|~/, "");
        const npmVersions = await this.fetchNpmVersions(
          name,
          cleanCurrentVersion
        );
        const line = document
          .getText()
          .split("\n")
          .findIndex((line) => line.includes(`"${name}": "${currentVersion}"`));
        console.log(document.getText());
        console.log(line);

        let commands: vscode.Command[] = [];
        if (cleanCurrentVersion === npmVersions.latestMajor) {
          commands.push({
            command: "",
            title: "Up to date ✔︎",
            arguments: [],
          });
        } else {
          const [currentMajor, currentMinor, currentPatch] = cleanCurrentVersion
            .split(".")
            .map(Number);

          if (!npmVersions.latestMajor.startsWith(`${currentMajor}.`)) {
            commands.push({
              command: "npm-deps-versions.codelensAction",
              title: `Major upgrade available: ${npmVersions.latestMajor}`,
              tooltip: `Upgrades ${name} from ${cleanCurrentVersion} to ${npmVersions.latestMajor}`,
              arguments: [{ pkg: name, newVersion: npmVersions.latestMajor }],
            });
          }

          if (
            !npmVersions.latestMinor.startsWith(
              `${currentMajor}.${currentMinor}.`
            )
          ) {
            commands.push({
              command: "npm-deps-versions.codelensAction",
              title: `Minor upgrade available: ${npmVersions.latestMinor}`,
              tooltip: `Upgrades ${name} from ${cleanCurrentVersion} to ${npmVersions.latestMinor}`,
              arguments: [{ pkg: name, newVersion: npmVersions.latestMinor }],
            });
          }
          if (
            !npmVersions.latestPatch.startsWith(
              `${currentMajor}.${currentMinor}.${currentPatch}`
            )
          ) {
            commands.push({
              command: "npm-deps-versions.codelensAction",
              title: `Patch upgrade available: ${npmVersions.latestPatch}`,
              tooltip: `Upgrades ${name} from ${cleanCurrentVersion} to ${npmVersions.latestPatch}`,
              arguments: [{ pkg: name, newVersion: npmVersions.latestPatch }],
            });
          }
        }
        commands.forEach((command) => {
          codeLenses.push(
            new vscode.CodeLens(new vscode.Range(line, 0, line, 0), command)
          );
        });
      }
    }
    return codeLenses;
  }

  async fetchNpmVersions(packageName: string, currentVersion: string) {
    const [currentMajor, currentMinor, currentPatch] = currentVersion
      .split(".")
      .map(Number);

    const response = await fetch(`https://registry.npmjs.org/${packageName}`);
    const data = (await response.json()) as {
      "dist-tags": { latest: string };
      versions: { [key: string]: any };
    };
    const latestMajor = data["dist-tags"].latest;
    const versions = Object.keys(data.versions).filter((version) => {
      if (
        !vscode.workspace
          .getConfiguration("npm-deps-versions")
          .get("enableReleaseCandidateUpgrades", false) &&
        version.includes("rc")
      ) {
        return false;
      }
      if (
        !vscode.workspace
          .getConfiguration("npm-deps-versions")
          .get("enableBetaUpgrades", false) &&
        version.includes("beta")
      ) {
        return false;
      }
      if (
        !vscode.workspace
          .getConfiguration("npm-deps-versions")
          .get("enableAlphaUpgrades", false) &&
        version.includes("alpha")
      ) {
        return false;
      }
      if (
        !vscode.workspace
          .getConfiguration("npm-deps-versions")
          .get("enableDevUpgrades", false) &&
        version.includes("dev")
      ) {
        return false;
      }
      // filter out any else version that contains a dash
      if (version.includes("-")) {
        return false;
      }

      const [major, minor, patch] = version.split(".").map(Number);

      if (major < currentMajor) {
        return false;
      }
      if (major === currentMajor && minor < currentMinor) {
        return false;
      }
      if (
        major === currentMajor &&
        minor === currentMinor &&
        patch < currentPatch
      ) {
        return false;
      }
      return true;
    });

    const latestMinor = versions
      .filter((version) => version.startsWith(`${currentMajor}.`))
      .sort((a, b) => {
        const [_aMajor, aMinor, aPatch] = a.split(".").map(Number);
        const [_bMajor, bMinor, bPatch] = b.split(".").map(Number);
        if (aMinor === bMinor) {
          return bPatch - aPatch;
        }
        return bMinor - aMinor;
      })[0];

    const latestPatch = versions
      .filter((version) =>
        version.startsWith(`${currentMajor}.${currentMinor}.`)
      )
      .sort((a, b) => {
        const [_aMajor, _aMinor, aPatch] = a.split(".").map(Number);
        const [_bMajor, _bMinor, bPatch] = b.split(".").map(Number);
        return bPatch - aPatch;
      })[0];

    return { latestMajor, latestMinor, latestPatch };
  }
}
