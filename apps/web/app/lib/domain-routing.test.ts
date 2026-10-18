import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

function route(host: string, path = "/") {
  return proxy(new NextRequest(`https://${host}${path}`, { headers: { host } }));
}

test("marketing roots rewrite internally; app and preview roots remain unchanged", () => {
  for (const host of ["kaada.xyz", "www.kaada.xyz", "localhost:3000"]) {
    assert.equal(new URL(route(host).headers.get("x-middleware-rewrite")!).pathname, "/marketing");
  }
  for (const host of ["app.kaada.xyz", "app.localhost:3000", "preview.example"]) {
    assert.equal(route(host).headers.get("x-middleware-next"), "1");
  }
});

test("legacy flow redirects preserve bearer paths and query parameters", () => {
  for (const path of [
    "/setup/token",
    "/authorize/token",
    "/root-action/token",
    "/security/token",
    "/recovery",
    "/recovery/cancel",
  ]) {
    const response = route("kaada.xyz", `${path}?token=a%2Fb&return=%2F`);
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      `https://app.kaada.xyz${path}?token=a%2Fb&return=%2F`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(route("app.kaada.xyz", path).headers.get("x-middleware-next"), "1");
    assert.equal(route("localhost:3000", path).headers.get("x-middleware-next"), "1");
  }
});

test("internal marketing URLs are hidden and unrelated requests pass through", () => {
  for (const host of ["kaada.xyz", "app.kaada.xyz"]) {
    assert.equal(route(host, "/marketing").status, 404);
    assert.equal(route(host, "/marketing/extra").status, 404);
  }
  for (const path of ["/api/v1/health", "/_next/static/file.js", "/security-guide"]) {
    assert.equal(route("kaada.xyz", path).headers.get("x-middleware-next"), "1");
  }
  const spoofed = proxy(
    new NextRequest("https://preview.example/", {
      headers: { host: "preview.example", "x-forwarded-host": "kaada.xyz" },
    }),
  );
  assert.equal(spoofed.headers.get("x-middleware-next"), "1");
});
