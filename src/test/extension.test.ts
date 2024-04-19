import * as vscode from "vscode";
import { CodelensProvider } from "../CodelensProvider";
import * as assert from "assert";

suite("CodeLensProvider Test Suite", () => {
  let provider: CodelensProvider;

  setup(() => {
    provider = new CodelensProvider();
  });

  test("provideCodeLenses should return an array of CodeLens", async () => {
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
    };

    const codeLenses = await provider.provideCodeLenses(
      document as vscode.TextDocument,
      {} as vscode.CancellationToken
    );
    assert.ok(Array.isArray(codeLenses));
  });

  test("fetchNpmVersions should return the latest versions", async () => {
    const versions = await provider.fetchNpmVersions(
      "dummy-package-one",
      "1.0.0"
    );
    assert.ok(versions.latestMajor);
    assert.ok(versions.latestMinor);
    assert.ok(versions.latestPatch);
  });
});
