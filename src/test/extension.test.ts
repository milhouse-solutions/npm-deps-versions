import * as vscode from "vscode";
import { CodelensProvider } from "../CodelensProvider";
import * as assert from "assert";

suite("CodeLensProvider Test Suite", () => {
  let provider: CodelensProvider;

  setup(() => {
    provider = new CodelensProvider();
  });

  test("provideCodeLenses should return an array of CodeLens with loading state", async () => {
    const document = {
      getText: () =>
        JSON.stringify(
          {
            dependencies: { "dummy-package-one": "1.0.0" },
            devDependencies: {},
          },
          null,
          2
        ),
      fileName: "package.json",
      uri: {
        toString: () => "file:///test/package.json",
      },
      version: 1,
    } as vscode.TextDocument;

    const codeLenses = await provider.provideCodeLenses(document, {
      isCancellationRequested: false,
    } as vscode.CancellationToken);
    assert.ok(Array.isArray(codeLenses));
    assert.ok(codeLenses.length > 0);
    // Initial CodeLenses should show "Loading..." state
    assert.ok(
      codeLenses[0].command?.title === "Loading version..." ||
        codeLenses[0].command?.title === "Up to date ✔︎" ||
        codeLenses[0].command?.title?.includes("upgrade available")
    );
  });

  test("provideCodeLenses should handle invalid JSON gracefully", async () => {
    const document = {
      getText: () => "invalid json {",
      fileName: "package.json",
      uri: {
        toString: () => "file:///test/package.json",
      },
      version: 1,
    } as vscode.TextDocument;

    const codeLenses = await provider.provideCodeLenses(document, {
      isCancellationRequested: false,
    } as vscode.CancellationToken);
    // Should return empty array for invalid JSON
    assert.ok(Array.isArray(codeLenses));
  });

  test("provideCodeLenses should return empty array when CodeLens is disabled", async () => {
    // Mock workspace configuration to return false for enableCodeLens
    const originalGet = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () =>
      ({
        get: (key: string) => {
          if (key === "enableCodeLens") {
            return false;
          }
          return originalGet().get(key);
        },
      } as any);

    const document = {
      getText: () =>
        JSON.stringify({
          dependencies: { "dummy-package-one": "1.0.0" },
        }),
      fileName: "package.json",
      uri: {
        toString: () => "file:///test/package.json",
      },
      version: 1,
    } as vscode.TextDocument;

    const codeLenses = await provider.provideCodeLenses(document, {
      isCancellationRequested: false,
    } as vscode.CancellationToken);

    // Restore original
    vscode.workspace.getConfiguration = originalGet;

    assert.ok(Array.isArray(codeLenses));
    assert.strictEqual(codeLenses.length, 0);
  });
});
