import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLIENT_IP_HEADER, PROXY_AUTH_HEADER, clientIpOf } from "../src/security/client-ip.js";

/*
 * Per-address limits must count each visitor separately even though every browser request reaches the API through the web proxy,
 * and nobody may be able to pick the address they are counted under.
 */

const SECRET = "s".repeat(40);
const SOCKET = "172.18.0.1";

const request = (headers: Record<string, string | string[] | undefined>) => ({
  ip: SOCKET,
  headers,
});

describe("the address a request is counted under", () => {
  it("is the visitor's own address when the proxy proves it", () => {
    assert.equal(
      clientIpOf(
        request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: "105.127.11.187" }),
        SECRET,
      ),
      "105.127.11.187",
    );
    assert.equal(
      clientIpOf(
        request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: "2001:db8::1" }),
        SECRET,
      ),
      "2001:db8::1",
    );
  });

  it("two visitors behind the same proxy are two addresses", () => {
    const a = clientIpOf(
      request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: "1.1.1.1" }),
      SECRET,
    );
    const b = clientIpOf(
      request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: "2.2.2.2" }),
      SECRET,
    );
    assert.notEqual(a, b);
  });

  it("a direct caller cannot choose their address: a wrong or missing proof is ignored", () => {
    assert.equal(
      clientIpOf(request({ [PROXY_AUTH_HEADER]: "guess", [CLIENT_IP_HEADER]: "9.9.9.9" }), SECRET),
      SOCKET,
    );
    assert.equal(clientIpOf(request({ [CLIENT_IP_HEADER]: "9.9.9.9" }), SECRET), SOCKET);
    assert.equal(clientIpOf(request({ [PROXY_AUTH_HEADER]: SECRET }), SECRET), SOCKET);
  });

  it("with no secret configured the header is never believed", () => {
    assert.equal(
      clientIpOf(
        request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: "9.9.9.9" }),
        undefined,
      ),
      SOCKET,
    );
  });

  it("junk in the header falls back to the socket, and repeated headers are not trusted", () => {
    for (const junk of ["not-an-ip", "1.1.1.1, 2.2.2.2", "", "1.1.1.1\r\nx: y"]) {
      assert.equal(
        clientIpOf(request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: junk }), SECRET),
        SOCKET,
        junk,
      );
    }
    assert.equal(
      clientIpOf(
        request({ [PROXY_AUTH_HEADER]: SECRET, [CLIENT_IP_HEADER]: ["1.1.1.1", "2.2.2.2"] }),
        SECRET,
      ),
      SOCKET,
    );
  });
});
