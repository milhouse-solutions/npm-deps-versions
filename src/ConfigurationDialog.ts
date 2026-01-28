import * as vscode from "vscode";

export class ConfigurationDialog {
  private static readonly LAST_KNOWN_VERSION_KEY_NPM = "deps-versions.npm.lastKnownVersion";
  private static readonly LAST_KNOWN_VERSION_KEY_PYTHON = "deps-versions.python.lastKnownVersion";

  /**
   * Checks if configuration dialog should be shown and shows it if needed
   * @param context Extension context for global state
   * @param currentVersion Current extension version from package.json
   * @param ecosystem "npm" or "python"
   * @returns true if dialog was shown, false otherwise
   */
  static async checkAndShowDialog(
    context: vscode.ExtensionContext,
    currentVersion: string,
    ecosystem: "npm" | "python" = "npm"
  ): Promise<boolean> {
    const configNamespace = ecosystem === "python" ? "deps-versions.python" : "deps-versions.npm";
    const config = vscode.workspace.getConfiguration(configNamespace);
    const versionGetMethod = config.get<string | undefined>("versionGetMethod");
    const lastKnownVersionKey = ecosystem === "python" 
      ? this.LAST_KNOWN_VERSION_KEY_PYTHON 
      : this.LAST_KNOWN_VERSION_KEY_NPM;

    // Check if method is not selected (null or undefined)
    if (!versionGetMethod || versionGetMethod === null) {
      return await this.showDialog(context, currentVersion, ecosystem);
    }

    // Check if version has changed (upgrade detection)
    const lastKnownVersion = context.globalState.get<string>(
      lastKnownVersionKey
    );
    if (lastKnownVersion !== currentVersion) {
      // Show dialog on upgrade (version will be updated in showDialog)
      return await this.showDialog(context, currentVersion, ecosystem);
    }

    return false;
  }

  /**
   * Shows the configuration dialog to let user select their preferred method
   * @param context Extension context for global state
   * @param currentVersion Current extension version
   * @param ecosystem "npm" or "python"
   * @returns true if user made a selection, false if dismissed
   */
  private static async showDialog(
    context: vscode.ExtensionContext,
    currentVersion: string,
    ecosystem: "npm" | "python"
  ): Promise<boolean> {
    const configNamespace = ecosystem === "python" ? "deps-versions.python" : "deps-versions.npm";
    const lastKnownVersionKey = ecosystem === "python" 
      ? this.LAST_KNOWN_VERSION_KEY_PYTHON 
      : this.LAST_KNOWN_VERSION_KEY_NPM;
    
    const ecosystemName = ecosystem === "python" ? "Python" : "npm";
    const cliTool = ecosystem === "python" ? "pip/uv CLI" : "npm CLI";
    const message = `Deps Versions: Please select how to fetch ${ecosystemName} package versions`;
    const useCliAction = `Use ${cliTool}`;
    const useHttpAction = "Use HTTP";

    const selection = await vscode.window.showInformationMessage(
      message,
      useCliAction,
      useHttpAction
    );

    if (selection === useCliAction) {
      await vscode.workspace
        .getConfiguration(configNamespace)
        .update("versionGetMethod", "cli", true);
      await context.globalState.update(
        lastKnownVersionKey,
        currentVersion
      );
      return true;
    } else if (selection === useHttpAction) {
      await vscode.workspace
        .getConfiguration(configNamespace)
        .update("versionGetMethod", "http", true);
      await context.globalState.update(
        lastKnownVersionKey,
        currentVersion
      );
      return true;
    }

    // User dismissed the dialog - store version anyway to prevent repeated prompts
    // but don't set a method, so it will show again next time
    await context.globalState.update(
      lastKnownVersionKey,
      currentVersion
    );
    return false;
  }
}

