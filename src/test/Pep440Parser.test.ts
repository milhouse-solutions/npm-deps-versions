import * as assert from "assert";
import {
  parsePep440,
  comparePep440,
  extractBaseVersion,
  getVersionParts,
  gtePep440,
  gtPep440,
  Pep440Version,
} from "../Pep440Parser";

suite("Pep440Parser Test Suite", () => {
  suite("parsePep440", () => {
    test("should parse standard versions", () => {
      const result = parsePep440("1.2.3");
      assert.ok(result);
      assert.deepStrictEqual(result.release, [1, 2, 3]);
      assert.strictEqual(result.pre, undefined);
      assert.strictEqual(result.post, undefined);
      assert.strictEqual(result.dev, undefined);
    });

    test("should parse versions with more than 3 parts", () => {
      const result = parsePep440("1.2.3.4");
      assert.ok(result);
      assert.deepStrictEqual(result.release, [1, 2, 3, 4]);
    });

    test("should parse pre-release alpha versions", () => {
      const result = parsePep440("1.2.3a1");
      assert.ok(result);
      assert.deepStrictEqual(result.release, [1, 2, 3]);
      assert.ok(result.pre);
      assert.strictEqual(result.pre?.type, "a");
      assert.strictEqual(result.pre?.number, 1);
    });

    test("should parse pre-release beta versions", () => {
      const result = parsePep440("1.2.3b2");
      assert.ok(result);
      assert.ok(result.pre);
      assert.strictEqual(result.pre?.type, "b");
      assert.strictEqual(result.pre?.number, 2);
    });

    test("should parse pre-release candidate versions", () => {
      const result = parsePep440("1.2.3rc1");
      assert.ok(result);
      assert.ok(result.pre);
      assert.strictEqual(result.pre?.type, "rc");
      assert.strictEqual(result.pre?.number, 1);
    });

    test("should parse post-release versions", () => {
      const result = parsePep440("1.2.3.post1");
      assert.ok(result);
      assert.strictEqual(result.post, 1);
    });

    test("should parse dev versions", () => {
      const result = parsePep440("1.2.3.dev1");
      assert.ok(result);
      assert.strictEqual(result.dev, 1);
    });

    test("should parse epoch versions", () => {
      const result = parsePep440("1!2.3.4");
      assert.ok(result);
      assert.strictEqual(result.epoch, 1);
      assert.deepStrictEqual(result.release, [2, 3, 4]);
    });

    test("should parse local versions", () => {
      const result = parsePep440("1.2.3+local");
      assert.ok(result);
      assert.strictEqual(result.local, "local");
    });

    test("should parse combined formats", () => {
      const result = parsePep440("1.2.3a1.post1.dev1");
      assert.ok(result);
      assert.deepStrictEqual(result.release, [1, 2, 3]);
      assert.ok(result.pre);
      assert.strictEqual(result.pre?.type, "a");
      assert.strictEqual(result.pre?.number, 1);
      assert.strictEqual(result.post, 1);
      assert.strictEqual(result.dev, 1);
    });

    test("should handle versions with dots in post and dev", () => {
      const result = parsePep440("1.2.3.post1.dev2");
      assert.ok(result);
      assert.strictEqual(result.post, 1);
      assert.strictEqual(result.dev, 2);
    });

    test("should return null for invalid versions", () => {
      assert.strictEqual(parsePep440("invalid"), null);
      assert.strictEqual(parsePep440(""), null);
      assert.strictEqual(parsePep440("abc"), null);
    });

    test("should handle whitespace", () => {
      const result = parsePep440("  1.2.3  ");
      assert.ok(result);
      assert.deepStrictEqual(result.release, [1, 2, 3]);
    });
  });

  suite("comparePep440", () => {
    test("should compare equal versions", () => {
      assert.strictEqual(comparePep440("1.2.3", "1.2.3"), 0);
      assert.strictEqual(comparePep440("2.0.0", "2.0.0"), 0);
    });

    test("should compare major versions", () => {
      assert.strictEqual(comparePep440("1.2.3", "2.0.0"), -1);
      assert.strictEqual(comparePep440("2.0.0", "1.2.3"), 1);
    });

    test("should compare minor versions", () => {
      assert.strictEqual(comparePep440("1.2.3", "1.3.0"), -1);
      assert.strictEqual(comparePep440("1.3.0", "1.2.3"), 1);
    });

    test("should compare patch versions", () => {
      assert.strictEqual(comparePep440("1.2.3", "1.2.4"), -1);
      assert.strictEqual(comparePep440("1.2.4", "1.2.3"), 1);
    });

    test("should compare pre-release versions correctly", () => {
      // Pre-release < final
      assert.strictEqual(comparePep440("1.2.3a1", "1.2.3"), -1);
      assert.strictEqual(comparePep440("1.2.3", "1.2.3a1"), 1);

      // a < b < rc
      assert.strictEqual(comparePep440("1.2.3a1", "1.2.3b1"), -1);
      assert.strictEqual(comparePep440("1.2.3b1", "1.2.3rc1"), -1);
      assert.strictEqual(comparePep440("1.2.3a1", "1.2.3rc1"), -1);

      // Same type, compare numbers
      assert.strictEqual(comparePep440("1.2.3a1", "1.2.3a2"), -1);
      assert.strictEqual(comparePep440("1.2.3a2", "1.2.3a1"), 1);
    });

    test("should compare post-release versions correctly", () => {
      // Post-release > non-post
      assert.strictEqual(comparePep440("1.2.3", "1.2.3.post1"), -1);
      assert.strictEqual(comparePep440("1.2.3.post1", "1.2.3"), 1);

      // Compare post numbers
      assert.strictEqual(comparePep440("1.2.3.post1", "1.2.3.post2"), -1);
      assert.strictEqual(comparePep440("1.2.3.post2", "1.2.3.post1"), 1);
    });

    test("should compare dev versions correctly", () => {
      // Dev < non-dev
      assert.strictEqual(comparePep440("1.2.3.dev1", "1.2.3"), -1);
      assert.strictEqual(comparePep440("1.2.3", "1.2.3.dev1"), 1);

      // Compare dev numbers
      assert.strictEqual(comparePep440("1.2.3.dev1", "1.2.3.dev2"), -1);
      assert.strictEqual(comparePep440("1.2.3.dev2", "1.2.3.dev1"), 1);
    });

    test("should compare epoch versions", () => {
      assert.strictEqual(comparePep440("1!1.0.0", "2!1.0.0"), -1);
      assert.strictEqual(comparePep440("2!1.0.0", "1!1.0.0"), 1);
      assert.strictEqual(comparePep440("1!1.0.0", "1!1.0.0"), 0);
    });

    test("should handle versions with different release segment lengths", () => {
      assert.strictEqual(comparePep440("1.2", "1.2.0"), 0);
      assert.strictEqual(comparePep440("1.2.0.0", "1.2.0"), 0);
    });

    test("should fallback to string comparison for invalid versions", () => {
      const result = comparePep440("invalid1", "invalid2");
      assert.ok(typeof result === "number");
    });
  });

  suite("extractBaseVersion", () => {
    test("should extract version from >= specifier", () => {
      assert.strictEqual(extractBaseVersion(">=2.25.0"), "2.25.0");
    });

    test("should extract version from == specifier", () => {
      assert.strictEqual(extractBaseVersion("==4.2.0"), "4.2.0");
    });

    test("should extract version from <= specifier", () => {
      assert.strictEqual(extractBaseVersion("<=1.0.0"), "1.0.0");
    });

    test("should extract version from ~= specifier", () => {
      assert.strictEqual(extractBaseVersion("~=1.20.0"), "1.20.0");
    });

    test("should extract version from > specifier", () => {
      assert.strictEqual(extractBaseVersion(">2.0.0"), "2.0.0");
    });

    test("should extract version from < specifier", () => {
      assert.strictEqual(extractBaseVersion("<3.0.0"), "3.0.0");
    });

    test("should extract version from single = specifier", () => {
      assert.strictEqual(extractBaseVersion("=38.0.1"), "38.0.1");
      assert.strictEqual(extractBaseVersion("=5.2.10"), "5.2.10");
    });

    test("should distinguish between == and = operators", () => {
      assert.strictEqual(extractBaseVersion("==1.0.0"), "1.0.0");
      assert.strictEqual(extractBaseVersion("=1.0.0"), "1.0.0");
    });

    test("should extract version from multiple constraints with single =", () => {
      assert.strictEqual(extractBaseVersion("=38.0.1,<40.0.0"), "38.0.1");
    });

    test("should extract version from multiple constraints", () => {
      assert.strictEqual(extractBaseVersion(">=2.25.0,<3.0.0"), "2.25.0");
      assert.strictEqual(extractBaseVersion(">=1.0.0,<2.0.0,!=1.5.0"), "1.0.0");
    });

    test("should handle version without specifier", () => {
      assert.strictEqual(extractBaseVersion("2.25.0"), "2.25.0");
    });

    test("should handle whitespace", () => {
      assert.strictEqual(extractBaseVersion("  >=2.25.0  "), "2.25.0");
      assert.strictEqual(extractBaseVersion(">=  2.25.0  ,  <3.0.0"), "2.25.0");
    });

    test("should return original string if no pattern matches", () => {
      const input = "some-package-name";
      assert.strictEqual(extractBaseVersion(input), input);
    });
  });

  suite("getVersionParts", () => {
    test("should extract major, minor, patch from standard version", () => {
      const result = getVersionParts("1.2.3");
      assert.strictEqual(result.major, 1);
      assert.strictEqual(result.minor, 2);
      assert.strictEqual(result.patch, 3);
    });

    test("should handle versions with pre-release", () => {
      const result = getVersionParts("1.2.3a1");
      assert.strictEqual(result.major, 1);
      assert.strictEqual(result.minor, 2);
      assert.strictEqual(result.patch, 3);
    });

    test("should handle versions with post-release", () => {
      const result = getVersionParts("1.2.3.post1");
      assert.strictEqual(result.major, 1);
      assert.strictEqual(result.minor, 2);
      assert.strictEqual(result.patch, 3);
    });

    test("should handle versions with fewer parts", () => {
      const result1 = getVersionParts("1.2");
      assert.strictEqual(result1.major, 1);
      assert.strictEqual(result1.minor, 2);
      assert.strictEqual(result1.patch, 0);

      const result2 = getVersionParts("1");
      assert.strictEqual(result2.major, 1);
      assert.strictEqual(result2.minor, 0);
      assert.strictEqual(result2.patch, 0);
    });

    test("should handle invalid versions", () => {
      const result = getVersionParts("invalid");
      assert.strictEqual(result.major, 0);
      assert.strictEqual(result.minor, 0);
      assert.strictEqual(result.patch, 0);
    });

    test("should handle epoch versions", () => {
      const result = getVersionParts("1!2.3.4");
      assert.strictEqual(result.major, 2);
      assert.strictEqual(result.minor, 3);
      assert.strictEqual(result.patch, 4);
    });
  });

  suite("gtePep440", () => {
    test("should return true for equal versions", () => {
      assert.strictEqual(gtePep440("1.2.3", "1.2.3"), true);
    });

    test("should return true when v1 > v2", () => {
      assert.strictEqual(gtePep440("2.0.0", "1.2.3"), true);
      assert.strictEqual(gtePep440("1.3.0", "1.2.3"), true);
      assert.strictEqual(gtePep440("1.2.4", "1.2.3"), true);
    });

    test("should return false when v1 < v2", () => {
      assert.strictEqual(gtePep440("1.2.3", "2.0.0"), false);
      assert.strictEqual(gtePep440("1.2.3", "1.3.0"), false);
      assert.strictEqual(gtePep440("1.2.3", "1.2.4"), false);
    });
  });

  suite("gtPep440", () => {
    test("should return false for equal versions", () => {
      assert.strictEqual(gtPep440("1.2.3", "1.2.3"), false);
    });

    test("should return true when v1 > v2", () => {
      assert.strictEqual(gtPep440("2.0.0", "1.2.3"), true);
      assert.strictEqual(gtPep440("1.3.0", "1.2.3"), true);
      assert.strictEqual(gtPep440("1.2.4", "1.2.3"), true);
    });

    test("should return false when v1 < v2", () => {
      assert.strictEqual(gtPep440("1.2.3", "2.0.0"), false);
      assert.strictEqual(gtPep440("1.2.3", "1.3.0"), false);
      assert.strictEqual(gtPep440("1.2.3", "1.2.4"), false);
    });
  });
});
