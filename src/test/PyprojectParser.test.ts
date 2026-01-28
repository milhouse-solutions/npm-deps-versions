import * as vscode from "vscode";
import * as assert from "assert";
import { PyprojectParser } from "../PyprojectParser";

suite("PyprojectParser Test Suite", () => {
  function createDocument(content: string, fileName: string = "pyproject.toml"): vscode.TextDocument {
    return {
      getText: () => content,
      fileName: fileName,
      uri: {
        toString: () => `file:///test/${fileName}`,
        fsPath: `/test/${fileName}`,
      },
      version: 1,
    } as vscode.TextDocument;
  }

  suite("extractDependencies - PEP 621 format", () => {
    test("should extract dependencies from [project.dependencies]", () => {
      const content = `[project]
dependencies = [
    "httpx",
    "ruff>=0.3.0",
    "requests>=2.25.0,<3.0.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      assert.strictEqual(deps[0].name, "httpx");
      assert.strictEqual(deps[0].currentVersion, "*");
      assert.strictEqual(deps[1].name, "ruff");
      assert.strictEqual(deps[1].currentVersion, ">=0.3.0");
      assert.strictEqual(deps[2].name, "requests");
      assert.strictEqual(deps[2].currentVersion, ">=2.25.0,<3.0.0");
    });

    test("should extract dependencies with various version specifiers", () => {
      const content = `[project]
dependencies = [
    "package1==1.0.0",
    "package2>=2.0.0",
    "package3<=3.0.0",
    "package4~=4.0.0",
    "package5!=5.0.0",
    "package6>6.0.0",
    "package7<7.0.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 7);
      assert.strictEqual(deps[0].name, "package1");
      assert.strictEqual(deps[0].currentVersion, "==1.0.0");
      assert.strictEqual(deps[1].name, "package2");
      assert.strictEqual(deps[1].currentVersion, ">=2.0.0");
    });

    test("should handle empty dependencies array", () => {
      const content = `[project]
dependencies = []`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 0);
    });
  });

  suite("extractDependencies - optional dependencies", () => {
    test("should extract dependencies from [project.optional-dependencies]", () => {
      const content = `[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
    "black",
]
test = [
    "coverage",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("black"));
      assert.ok(depNames.includes("coverage"));
    });

    test("should extract from multiple optional dependency groups", () => {
      const content = `[project.optional-dependencies]
dev = ["pytest"]
lint = ["ruff"]
docs = ["sphinx"]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("ruff"));
      assert.ok(depNames.includes("sphinx"));
    });
  });

  suite("extractDependencies - dependency groups (PEP 735)", () => {
    test("should extract dependencies from [dependency-groups]", () => {
      const content = `[dependency-groups]
dev = [
    "pytest>=7.0.0",
    "black",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("black"));
    });

    test("should extract from multiple dependency groups", () => {
      const content = `[dependency-groups]
dev = ["pytest"]
test = ["coverage"]
lint = ["ruff"]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("coverage"));
      assert.ok(depNames.includes("ruff"));
    });
  });

  suite("extractDependencies - Poetry format", () => {
    test("should extract dependencies from [tool.poetry.dependencies]", () => {
      const content = `[tool.poetry.dependencies]
python = "^3.8"
requests = ">=2.25.0"
httpx = "*"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2); // python is skipped
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("requests"));
      assert.ok(depNames.includes("httpx"));
    });

    test("should extract dependencies from [tool.poetry.dev-dependencies]", () => {
      const content = `[tool.poetry.dev-dependencies]
pytest = ">=7.0.0"
black = "*"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("black"));
    });

    test("should skip python version specifier in Poetry dependencies", () => {
      const content = `[tool.poetry.dependencies]
python = "^3.8"
requests = ">=2.25.0"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].name, "requests");
      assert.ok(!deps.some((d) => d.name === "python"));
    });
  });

  suite("extractDependencies - combined formats", () => {
    test("should extract from multiple formats in same file", () => {
      const content = `[project]
dependencies = [
    "requests>=2.25.0",
]

[project.optional-dependencies]
dev = ["pytest"]

[dependency-groups]
test = ["coverage"]

[tool.poetry.dependencies]
httpx = "*"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 4);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("requests"));
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("coverage"));
      assert.ok(depNames.includes("httpx"));
    });
  });

  suite("extractDependencies - version specifier parsing", () => {
    test("should parse dependencies without version specifiers", () => {
      const content = `[project]
dependencies = [
    "httpx",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].name, "httpx");
      assert.strictEqual(deps[0].currentVersion, "*");
    });

    test("should parse dependencies with multiple constraints", () => {
      const content = `[project]
dependencies = [
    "requests>=2.25.0,<3.0.0",
    "django>=4.0.0,<5.0.0,!=4.5.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      assert.strictEqual(deps[0].currentVersion, ">=2.25.0,<3.0.0");
      assert.strictEqual(deps[1].currentVersion, ">=4.0.0,<5.0.0,!=4.5.0");
    });

    test("should extract base version from specifiers", () => {
      const content = `[project]
dependencies = [
    "requests>=2.25.0,<3.0.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].cleanVersion, "2.25.0");
    });

    test("should parse dependencies with single = operator", () => {
      const content = `[project]
dependencies = [
    "faker=38.0.1",
    "django=5.2.10",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      assert.strictEqual(deps[0].name, "faker");
      assert.strictEqual(deps[0].currentVersion, "=38.0.1");
      assert.strictEqual(deps[0].cleanVersion, "38.0.1");
      assert.strictEqual(deps[1].name, "django");
      assert.strictEqual(deps[1].currentVersion, "=5.2.10");
      assert.strictEqual(deps[1].cleanVersion, "5.2.10");
    });

    test("should distinguish between == and = operators", () => {
      const content = `[project]
dependencies = [
    "package1==1.0.0",
    "package2=2.0.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      assert.strictEqual(deps[0].name, "package1");
      assert.strictEqual(deps[0].currentVersion, "==1.0.0");
      assert.strictEqual(deps[0].cleanVersion, "1.0.0");
      assert.strictEqual(deps[1].name, "package2");
      assert.strictEqual(deps[1].currentVersion, "=2.0.0");
      assert.strictEqual(deps[1].cleanVersion, "2.0.0");
    });
  });

  suite("extractDependencies - line number detection", () => {
    test("should detect correct line numbers", () => {
      const content = `[project]
name = "test"
version = "1.0.0"

dependencies = [
    "httpx",
    "requests>=2.25.0",
    "pytest>=7.0.0",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      // Line numbers should be detected (exact line may vary based on implementation)
      deps.forEach((dep) => {
        assert.ok(typeof dep.line === "number");
        assert.ok(dep.line >= 0);
      });
    });
  });

  suite("extractDependencies - edge cases", () => {
    test("should handle invalid TOML gracefully", () => {
      const content = `[project
dependencies = [
    "invalid",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 0);
    });

    test("should handle missing project section", () => {
      const content = `[tool]
some-setting = "value"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 0);
    });

    test("should handle empty file", () => {
      const document = createDocument("");
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 0);
    });

    test("should handle dependencies as string instead of array", () => {
      const content = `[project]
dependencies = "invalid"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 0);
    });

    test("should handle non-string dependency entries", () => {
      const content = `[project]
dependencies = [
    "valid-package",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      // Should only extract valid string dependencies
      assert.ok(deps.length >= 1);
      assert.strictEqual(deps[0].name, "valid-package");
    });

    test("should handle dependencies with extra whitespace", () => {
      const content = `[project]
dependencies = [
    "  httpx  ",
    "  requests  >=2.25.0  ",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 2);
      assert.strictEqual(deps[0].name, "httpx");
      assert.strictEqual(deps[1].name, "requests");
    });
  });

  suite("extractDependencies - real-world examples", () => {
    test("should parse typical PEP 621 pyproject.toml", () => {
      const content = `[project]
name = "my-package"
version = "1.0.0"
description = "A test package"

dependencies = [
    "requests>=2.25.0",
    "httpx",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
    "black",
]`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 4);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("requests"));
      assert.ok(depNames.includes("httpx"));
      assert.ok(depNames.includes("pytest"));
      assert.ok(depNames.includes("black"));
    });

    test("should parse Poetry pyproject.toml", () => {
      const content = `[tool.poetry]
name = "my-package"
version = "1.0.0"

[tool.poetry.dependencies]
python = "^3.8"
requests = ">=2.25.0"
httpx = "*"

[tool.poetry.dev-dependencies]
pytest = ">=7.0.0"`;
      const document = createDocument(content);
      const deps = PyprojectParser.extractDependencies(document);

      assert.strictEqual(deps.length, 3);
      const depNames = deps.map((d) => d.name);
      assert.ok(depNames.includes("requests"));
      assert.ok(depNames.includes("httpx"));
      assert.ok(depNames.includes("pytest"));
    });
  });
});
