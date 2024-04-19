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

export function activate(_context: ExtensionContext) {
  disposables.push(
    languages.registerCodeLensProvider(
      { pattern: "**/package.json" },
      new CodelensProvider()
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
    )
  );
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach((item) => item.dispose());
  }
  disposables = [];
}
