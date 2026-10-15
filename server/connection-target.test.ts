import { describe, expect, it } from "vitest";
import { describeConnection, parseConnectionTarget } from "./connection-target";

function offerUrl(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `https://app.paseo.sh/#offer=${encoded}`;
}

const offer = {
  v: 2,
  serverId: "srv_TESTSERVER01",
  daemonPublicKeyB64: Buffer.alloc(32, 7).toString("base64"),
  relay: { endpoint: "relay.paseo.sh:443", useTls: true },
};

describe("parseConnectionTarget", () => {
  it("parses a pairing offer into a relay target bound to the offer's serverId", () => {
    const target = parseConnectionTarget(offerUrl(offer));
    expect(target).toMatchObject({
      kind: "relay",
      serverId: "srv_TESTSERVER01",
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      endpoint: "relay.paseo.sh:443",
    });
    const url = new URL(target.url);
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("serverId")).toBe("srv_TESTSERVER01");
    expect(url.searchParams.get("role")).toBe("client");
  });

  it("uses plain ws for a self-hosted relay without TLS", () => {
    const target = parseConnectionTarget(
      offerUrl({ ...offer, relay: { endpoint: "10.0.0.5:8080", useTls: false } }),
    );
    expect(new URL(target.url).protocol).toBe("ws:");
  });

  it("parses host:port as a direct WebSocket endpoint", () => {
    expect(parseConnectionTarget("100.64.0.7:6767")).toEqual({
      kind: "direct",
      url: "ws://100.64.0.7:6767/ws",
      endpoint: "100.64.0.7:6767",
    });
  });

  it("keeps explicit ws:// and wss:// URLs and defaults the path to /ws", () => {
    expect(parseConnectionTarget("wss://paseo.example.com").url).toBe("wss://paseo.example.com/ws");
    expect(parseConnectionTarget("ws://box.lan:7000/ws").url).toBe("ws://box.lan:7000/ws");
  });

  it("rejects unsupported schemes, empty input and malformed offers", () => {
    expect(() => parseConnectionTarget("ssh://me@box")).toThrow(/Unsupported connection/);
    expect(() => parseConnectionTarget("   ")).toThrow(/empty/);
    expect(() => parseConnectionTarget("https://app.paseo.sh/#offer=not-json")).toThrow(
      /Invalid pairing offer URL/,
    );
    expect(() => parseConnectionTarget(offerUrl({ ...offer, serverId: "" }))).toThrow(
      /Invalid pairing offer URL/,
    );
  });

  it("describes relay targets without leaking the daemon key", () => {
    const description = describeConnection(parseConnectionTarget(offerUrl(offer)));
    expect(description).toBe("relay relay.paseo.sh:443 (srv_TESTSERVER01)");
    expect(description).not.toContain(offer.daemonPublicKeyB64);
  });
});
