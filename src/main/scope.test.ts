// Run: node --test src/main/scope.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inScope, scopesOverlap } from "./scope.ts";

test("inScope: globs and plain paths", () => {
  assert.ok(inScope("src/ui/button.tsx", ["src/ui/**"]));
  assert.ok(inScope("src\\ui\\deep\\x.ts", ["src/ui/**"]));
  assert.ok(!inScope("src/api/x.ts", ["src/ui/**"]));
  assert.ok(inScope("README.md", ["README.md"]));
  assert.ok(inScope("lib/math/add.js", ["lib/math"]));
  assert.ok(!inScope("lib/mathx/add.js", ["lib/math"]));
  assert.ok(inScope("src/a.js", ["src/*.js"]));
  assert.ok(!inScope("src/sub/a.js", ["src/*.js"]));
});

test("scopesOverlap", () => {
  assert.ok(!scopesOverlap(["src/ui/**"], ["src/api/**"]));
  assert.ok(scopesOverlap(["src/**"], ["src/api/**"]));
  assert.ok(scopesOverlap(["src/ui/**"], []));
  assert.ok(!scopesOverlap(["math.js"], ["strings.js"]));
  assert.ok(scopesOverlap(["math.js"], ["math.js"]));
  assert.ok(!scopesOverlap(["lib/math/**"], ["lib/strings/**", "test/strings.test.js"]));
});
