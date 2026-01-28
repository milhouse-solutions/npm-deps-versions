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
  outputChannel = window.createOutputChannel("Deps Versions");
  outputChannel.appendLine("Deps Versions extension activated");

  // Check if configuration dialog should be shown
  const packageJsonPath = path.join(context.extensionPath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };
  const currentVersion = packageJson.version;
  // Check for npm configuration (existing behavior)
  await ConfigurationDialog.checkAndShowDialog(context, currentVersion, "npm");
  
  // Check for Python configuration if pyproject.toml exists in workspace
  const pythonFiles = await workspace.findFiles("**/pyproject.toml", null, 1);
  if (pythonFiles.length > 0) {
    await ConfigurationDialog.checkAndShowDialog(context, currentVersion, "python");
  }

  codelensProvider = new CodelensProvider(outputChannel);

  disposables.push(
    languages.registerCodeLensProvider(
      { pattern: "**/package.json" },
      codelensProvider
    ),
    languages.registerCodeLensProvider(
      { pattern: "**/pyproject.toml" },
      codelensProvider
    ),
    commands.registerCommand("deps-versions.enableCodeLens", () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }
      const isPython = editor.document.fileName.endsWith("pyproject.toml");
      const configKey = isPython ? "deps-versions.python.enableCodeLens" : "deps-versions.npm.enableCodeLens";
      workspace.getConfiguration(isPython ? "deps-versions.python" : "deps-versions.npm")
        .update("enableCodeLens", true, true);
    }),
    commands.registerCommand("deps-versions.disableCodeLens", () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }
      const isPython = editor.document.fileName.endsWith("pyproject.toml");
      workspace.getConfiguration(isPython ? "deps-versions.python" : "deps-versions.npm")
        .update("enableCodeLens", false, true);
    }),
    commands.registerCommand(
      "deps-versions.codelensAction",
      (args: { pkg: string; newVersion: string; filePath?: string; ecosystem?: "npm" | "python" }) => {
        window.showInformationMessage(
          `Updating ${args.pkg} to version ${args.newVersion}...`
        );

        let terminal = window.activeTerminal;
        if (args.filePath) {
          const fileDir = path.dirname(args.filePath);
          terminal = window.createTerminal({ cwd: fileDir });
        } else {
          terminal = terminal || window.createTerminal();
        }

        if (args.ecosystem === "python") {
          terminal.sendText(`pip install ${args.pkg}==${args.newVersion}`);
        } else {
          terminal.sendText(`npm install ${args.pkg}@${args.newVersion}`);
        }
      }
    ),
    commands.registerCommand("deps-versions.refreshCache", () => {
      const editor = window.activeTextEditor;
      if (editor && (editor.document.fileName.endsWith("package.json") || editor.document.fileName.endsWith("pyproject.toml"))) {
        codelensProvider.invalidateCache(editor.document.uri.toString());
        window.showInformationMessage(
          "Cache refreshed. CodeLens will update shortly."
        );
      } else {
        window.showWarningMessage(
          "Please open a package.json or pyproject.toml file to refresh the cache."
        );
      }
    }),
    workspace.onDidSaveTextDocument((document) => {
      // Handle selective cache invalidation when package.json or pyproject.toml is saved
      if (document.fileName.endsWith("package.json") || document.fileName.endsWith("pyproject.toml")) {
        codelensProvider.handleDocumentSave(document);
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
