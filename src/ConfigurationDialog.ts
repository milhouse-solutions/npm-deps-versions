import * as vscode from "vscode";

export class ConfigurationDialog {
  private static readonly LAST_KNOWN_VERSION_KEY = "npm-deps-versions.lastKnownVersion";

  /**
   * Checks if configuration dialog should be shown and shows it if needed
   * @param context Extension context for global state
   * @param currentVersion Current extension version from package.json
   * @returns true if dialog was shown, false otherwise
   */
  static async checkAndShowDialog(
    context: vscode.ExtensionContext,
    currentVersion: string
  ): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("npm-deps-versions");
    const versionGetMethod = config.get<string | undefined>("versionGetMethod");

    // Check if method is not selected (null or undefined)
    if (!versionGetMethod || versionGetMethod === null) {
      return await this.showDialog(context, currentVersion);
    }

    // Check if version has changed (upgrade detection)
    const lastKnownVersion = context.globalState.get<string>(
      this.LAST_KNOWN_VERSION_KEY
    );
    if (lastKnownVersion !== currentVersion) {
      // Show dialog on upgrade (version will be updated in showDialog)
      return await this.showDialog(context, currentVersion);
    }

    return false;
  }

  /**
   * Shows the configuration dialog to let user select their preferred method
   * @param context Extension context for global state
   * @param currentVersion Current extension version
   * @returns true if user made a selection, false if dismissed
   */
  private static async showDialog(
    context: vscode.ExtensionContext,
    currentVersion: string
  ): Promise<boolean> {
    const message =
      "NPM Deps Versions: Please select how to fetch package versions";
    const useCliAction = "Use npm CLI";
    const useHttpAction = "Use HTTP";

    const selection = await vscode.window.showInformationMessage(
      message,
      useCliAction,
      useHttpAction
    );

    if (selection === useCliAction) {
      await vscode.workspace
        .getConfiguration("npm-deps-versions")
        .update("versionGetMethod", "cli", true);
      await context.globalState.update(
        this.LAST_KNOWN_VERSION_KEY,
        currentVersion
      );
      return true;
    } else if (selection === useHttpAction) {
      await vscode.workspace
        .getConfiguration("npm-deps-versions")
        .update("versionGetMethod", "http", true);
      await context.globalState.update(
        this.LAST_KNOWN_VERSION_KEY,
        currentVersion
      );
      return true;
    }

    // User dismissed the dialog - store version anyway to prevent repeated prompts
    // but don't set a method, so it will show again next time
    await context.globalState.update(
      this.LAST_KNOWN_VERSION_KEY,
      currentVersion
    );
    return false;
  }
}

