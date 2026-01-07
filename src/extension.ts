import {
  ExtensionContext,
  languages,
  commands,
  Disposable,
  workspace,
  window,
} from "vscode";
import { CodelensProvider } from "./CodelensProvider";

let disposables: Disposable[] = [];
let codelensProvider: CodelensProvider;

export function activate(_context: ExtensionContext) {
  codelensProvider = new CodelensProvider();

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
      (args: { pkg: string; newVersion: string }) => {
        window.showInformationMessage(
          `Updating ${args.pkg} to version ${args.newVersion}...`
        );
        const terminal = window.activeTerminal || window.createTerminal();
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
  disposables = [];
}
