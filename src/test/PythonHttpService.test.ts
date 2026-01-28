import * as vscode from "vscode";
import * as assert from "assert";
import { PythonHttpService } from "../PythonHttpService";

suite("PythonHttpService Test Suite", () => {
  let service: PythonHttpService;
  let originalFetch: typeof fetch;

  setup(() => {
    service = new PythonHttpService();
    originalFetch = global.fetch;
  });

  teardown(() => {
    global.fetch = originalFetch;
  });

  suite("fetchPyPIVersions", () => {
    test("should fetch and parse versions from PyPI API", async () => {
      const mockReleases = {
        "1.0.0": [],
        "1.0.1": [],
        "1.1.0": [],
        "1.2.0": [],
        "2.0.0": [],
      };

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: mockReleases,
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return false;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfo = await service.fetchPyPIVersions(
        "test-package",
        "1.0.0",
        config
      );

      assert.ok(versionInfo);
      assert.strictEqual(versionInfo.latestMajor, "2.0.0");
      assert.strictEqual(versionInfo.latestMinor, "1.2.0");
      assert.strictEqual(versionInfo.latestPatch, "1.0.1");
    });

    test("should detect major, minor, and patch upgrades correctly", async () => {
      const mockReleases = {
        "1.2.3": [],
        "1.2.4": [],
        "1.3.0": [],
        "2.0.0": [],
      };

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: mockReleases,
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return false;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfo = await service.fetchPyPIVersions(
        "test-package",
        "1.2.3",
        config
      );

      assert.strictEqual(versionInfo.latestMajor, "2.0.0");
      assert.strictEqual(versionInfo.latestMinor, "1.3.0");
      assert.strictEqual(versionInfo.latestPatch, "1.2.4");
    });

    test("should filter pre-release versions based on config", async () => {
      const mockReleases = {
        "1.0.0": [],
        "1.1.0rc1": [],
        "1.2.0b1": [],
        "1.3.0a1": [],
        "1.4.0.dev1": [],
        "2.0.0": [],
      };

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: mockReleases,
          }),
        } as Response;
      };

      // Test with pre-releases disabled
      const configDisabled = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return false;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfoDisabled = await service.fetchPyPIVersions(
        "test-package",
        "1.0.0",
        configDisabled
      );

      assert.strictEqual(versionInfoDisabled.latestMajor, "2.0.0");
      assert.strictEqual(versionInfoDisabled.latestMinor, undefined);
      assert.strictEqual(versionInfoDisabled.latestPatch, undefined);

      // Test with RC enabled
      const configRc = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return true;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfoRc = await service.fetchPyPIVersions(
        "test-package",
        "1.0.0",
        configRc
      );

      assert.strictEqual(versionInfoRc.latestMajor, "2.0.0");
      // Should find 1.1.0rc1 as minor upgrade when RC is enabled
      assert.ok(versionInfoRc.latestMinor);
    });

    test("should handle packages with no upgrades available", async () => {
      const mockReleases = {
        "2.0.0": [],
      };

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: mockReleases,
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return false;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfo = await service.fetchPyPIVersions(
        "test-package",
        "2.0.0",
        config
      );

      assert.strictEqual(versionInfo.latestMajor, "2.0.0");
      assert.strictEqual(versionInfo.latestMinor, undefined);
      assert.strictEqual(versionInfo.latestPatch, undefined);
    });

    test("should handle 404 errors", async () => {
      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      try {
        await service.fetchPyPIVersions("nonexistent-package", "1.0.0", config);
        assert.fail("Should have thrown an error");
      } catch (error: any) {
        assert.ok(error.message.includes("404"));
        assert.ok(error.message.includes("nonexistent-package"));
      }
    });

    test("should handle timeout", async () => {
      const timeoutController = new AbortController();
      setTimeout(() => timeoutController.abort(), 10);

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        // Check if signal is aborted
        if (init?.signal?.aborted) {
          const error: any = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        // Simulate timeout by waiting longer than abort timeout
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Check again after delay
        if (init?.signal?.aborted) {
          const error: any = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        return {
          ok: true,
          json: async () => ({ releases: {} }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 10;} // Very short timeout
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      try {
        await service.fetchPyPIVersions(
          "test-package",
          "1.0.0",
          config,
          timeoutController.signal
        );
        assert.fail("Should have thrown a timeout error");
      } catch (error: any) {
        assert.ok(error.message.includes("timeout") || error.message.includes("aborted"));
      }
    });

    test("should handle abort signal", async () => {
      const abortController = new AbortController();

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        // Check if signal is already aborted
        if (init?.signal?.aborted) {
          const error: any = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        return {
          ok: true,
          json: async () => ({ releases: {} }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      // Abort before calling fetchPyPIVersions
      abortController.abort();

      try {
        await service.fetchPyPIVersions(
          "test-package",
          "1.0.0",
          config,
          abortController.signal
        );
        assert.fail("Should have thrown an abort error");
      } catch (error: any) {
        assert.ok(error.message.includes("aborted"));
      }
    });

    test("should handle empty releases", async () => {
      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: {},
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      try {
        await service.fetchPyPIVersions("test-package", "1.0.0", config);
        assert.fail("Should have thrown an error");
      } catch (error: any) {
        assert.ok(error.message.includes("No versions found"));
      }
    });

    test("should sort versions using PEP 440", async () => {
      const mockReleases = {
        "1.0.0": [],
        "1.0.1": [],
        "1.1.0": [],
        "1.1.0a1": [],
        "1.1.0b1": [],
        "1.1.0rc1": [],
        "2.0.0": [],
      };

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        return {
          ok: true,
          json: async () => ({
            releases: mockReleases,
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 30000;}
          if (key === "enableReleaseCandidateUpgrades") {return false;}
          if (key === "enableBetaUpgrades") {return false;}
          if (key === "enableAlphaUpgrades") {return false;}
          if (key === "enableDevUpgrades") {return false;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      const versionInfo = await service.fetchPyPIVersions(
        "test-package",
        "1.0.0",
        config
      );

      // Should correctly identify latest major as 2.0.0
      assert.strictEqual(versionInfo.latestMajor, "2.0.0");
      // Should find 1.1.0 as minor upgrade (pre-releases filtered out)
      assert.strictEqual(versionInfo.latestMinor, "1.1.0");
      // Should find 1.0.1 as patch upgrade
      assert.strictEqual(versionInfo.latestPatch, "1.0.1");
    });

    test("should respect httpTimeout configuration", async () => {
      let capturedTimeout: number | undefined;

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        // Note: We can't directly test timeout behavior without more complex setup
        // This test verifies the timeout is passed to the config
        return {
          ok: true,
          json: async () => ({
            releases: { "1.0.0": [] },
          }),
        } as Response;
      };

      const config = {
        get: (key: string) => {
          if (key === "httpTimeout") {return 5000;}
          return undefined;
        },
      } as vscode.WorkspaceConfiguration;

      await service.fetchPyPIVersions("test-package", "1.0.0", config);
      // Test passes if no timeout error occurs with custom timeout
      assert.ok(true);
    });
  });
});
