import {
  ExtensionContext,
  languages,
  commands,
  Disposable,
  workspace,
  window,
  OutputChannel,
} from "vscode";
import * as path from "path";
import * as fs from "fs";
import { CodelensProvider } from "./CodelensProvider";
import { ConfigurationDialog } from "./ConfigurationDialog";

let disposables: Disposable[] = [];
let codelensProvider: CodelensProvider;
let outputChannel: OutputChannel;

export async function activate(context: ExtensionContext) {
  // Create output channel for logging
  outputChannel = window.createOutputChannel("NPM Deps Versions");
  outputChannel.appendLine("NPM Deps Versions extension activated");

  // Check if configuration dialog should be shown
  const packageJsonPath = path.join(context.extensionPath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };
  const currentVersion = packageJson.version;
  await ConfigurationDialog.checkAndShowDialog(context, currentVersion);

  codelensProvider = new CodelensProvider(outputChannel);

  disposables.push(
    languages.registerCodeLensProvider(
      { pattern: "**/package.json" },
      codelensProvider
    ),
    commands.registerCommand("npm-deps-versions.enableCodeLens", () => {
      workspace
        .getConfiguration("npm-deps-versions")
        .update("enableCodeLens", true, true);
    }),
    commands.registerCommand("npm-deps-versions.disableCodeLens", () => {
      workspace
        .getConfiguration("npm-deps-versions")
        .update("enableCodeLens", false, true);
    }),
    commands.registerCommand(
      "npm-deps-versions.codelensAction",
      (args: { pkg: string; newVersion: string; packageJsonPath?: string }) => {
        window.showInformationMessage(
          `Updating ${args.pkg} to version ${args.newVersion}...`
        );

        let terminal = window.activeTerminal;
        if (args.packageJsonPath) {
          // Get directory from package.json path
          const packageJsonDir = path.dirname(args.packageJsonPath);
          // Create terminal with cwd in the correct directory for Mono-Repo support
          terminal = window.createTerminal({ cwd: packageJsonDir });
        } else {
          // Fallback to existing behavior
          terminal = terminal || window.createTerminal();
        }

        terminal.sendText(`npm install ${args.pkg}@${args.newVersion}`);
      }
    ),
    commands.registerCommand("npm-deps-versions.refreshCache", () => {
      const editor = window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith("package.json")) {
        codelensProvider.invalidateCache(editor.document.uri.toString());
        window.showInformationMessage(
          "Cache refreshed. CodeLens will update shortly."
        );
      } else {
        window.showWarningMessage(
          "Please open a package.json file to refresh the cache."
        );
      }
    }),
    workspace.onDidChangeTextDocument((event) => {
      // Invalidate cache when package.json is modified
      if (event.document.fileName.endsWith("package.json")) {
        codelensProvider.invalidateCache(event.document.uri.toString());
      }
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach((item) => item.dispose());
  }
  if (outputChannel) {
    outputChannel.dispose();
  }
  disposables = [];
}
