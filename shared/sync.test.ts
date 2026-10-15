import { describe, expect, it } from "vitest";
import { parseConnectionTarget } from "../server/hosts/connection-target";
import {
  type AppHost,
  isOnAppMachine,
  parseAppRegistry,
  peerNameFor,
  planConnection,
  planSync,
} from "./sync";

const KEY = Buffer.alloc(32, 9).toString("base64");

function host(serverId: string, connections: AppHost["connections"], extra: Partial<AppHost> = {}) {
  return { serverId, label: serverId, connections, ...extra } as AppHost;
}

const remote = { targetOnAppMachine: false, publishedOffer: null };
const local = { targetOnAppMachine: true, publishedOffer: null };

describe("parseAppRegistry", () => {
  it("reads the app's stored hosts and keeps unknown fields out of the way", () => {
    const raw = JSON.stringify([
      {
        serverId: "srv_A",
        label: "Devbox CN",
        appearance: { color: "blue" },
        connections: [
          {
            id: "relay:x",
            type: "relay",
            relayEndpoint: "relay.paseo.sh:443",
            daemonPublicKeyB64: KEY,
          },
        ],
        preferredConnectionId: null,
      },
    ]);
    expect(parseAppRegistry(raw)).toMatchObject([{ serverId: "srv_A", label: "Devbox CN" }]);
    expect(parseAppRegistry(null)).toEqual([]);
  });

  it("refuses data it does not understand instead of guessing", () => {
    expect(() => parseAppRegistry("{not json")).toThrow(/not valid JSON/);
    expect(() => parseAppRegistry(JSON.stringify({ hosts: [] }))).toThrow(/unexpected format/);
    expect(() => parseAppRegistry(JSON.stringify([{ serverId: "x", connections: [] }]))).toThrow(
      /unexpected format/,
    );
  });
});

describe("planConnection", () => {
  it("prefers the app's relay connection and produces a URI the daemon parses", () => {
    const plan = planConnection(
      host("srv_A", [
        { type: "directTcp", endpoint: "10.0.0.5:6767" },
        { type: "relay", relayEndpoint: "relay.paseo.sh:443", daemonPublicKeyB64: KEY },
      ]),
      remote,
    );
    expect("connection" in plan && plan.connection).toMatch(/^relay:\/\//);
    if (!("connection" in plan)) throw new Error("expected a connection");
    expect(parseConnectionTarget(plan.connection)).toMatchObject({
      kind: "relay",
      serverId: "srv_A",
      daemonPublicKeyB64: KEY,
      endpoint: "relay.paseo.sh:443",
    });
    const target = parseConnectionTarget(plan.connection);
    expect("url" in target && new URL(target.url).protocol).toBe("wss:");
  });

  it("uses the host's published offer when the app only reaches it locally", () => {
    const laptop = host("srv_L", [{ type: "directSocket", path: "/tmp/paseo.sock" }]);
    expect(
      planConnection(laptop, {
        targetOnAppMachine: false,
        publishedOffer: "https://app.paseo.sh/#offer=x",
      }),
    ).toEqual({ connection: "https://app.paseo.sh/#offer=x" });
    expect(planConnection(laptop, remote)).toEqual({
      skip: "the app reaches it only from this machine; enable its relay or install mesh on it",
    });
  });

  it("uses loopback endpoints only for a target on the app's machine", () => {
    const box = host("srv_B", [{ type: "directTcp", endpoint: "127.0.0.1:7000" }]);
    expect(planConnection(box, local)).toEqual({ connection: "127.0.0.1:7000" });
    expect("skip" in planConnection(box, remote)).toBe(true);
    const lan = host("srv_C", [{ type: "directTcp", endpoint: "10.1.2.3:6767", useTls: true }]);
    expect(planConnection(lan, remote)).toEqual({ connection: "wss://10.1.2.3:6767" });
  });

  it("falls back to SSH with the stored user, ports and a URI the daemon parses", () => {
    const headless = host("srv_D", [
      { type: "remoteSsh", host: "dev@devbox-cn", sshPort: 2222, daemonPort: 7000 },
    ]);
    const plan = planConnection(headless, remote);
    expect(plan).toEqual({ connection: "ssh://dev@devbox-cn:2222?daemonPort=7000" });
    if (!("connection" in plan)) throw new Error("expected a connection");
    expect(parseConnectionTarget(plan.connection)).toMatchObject({
      kind: "ssh",
      ssh: { host: "dev@devbox-cn", sshPort: 2222, daemonPort: 7000 },
    });
    expect(
      planConnection(host("srv_E", [{ type: "remoteSsh", host: "devbox-cn" }]), remote),
    ).toEqual({ connection: "ssh://devbox-cn?daemonPort=6767" });
  });

  it("carries the profile password, or the legacy one stored on a direct connection", () => {
    expect(
      planConnection(
        host("srv_F", [{ type: "directTcp", endpoint: "10.0.0.9:6767" }], { password: "p1" }),
        remote,
      ),
    ).toEqual({ connection: "10.0.0.9:6767", password: "p1" });
    expect(
      planConnection(
        host("srv_G", [{ type: "directTcp", endpoint: "10.0.0.9:6767", password: "legacy" }]),
        remote,
      ),
    ).toEqual({ connection: "10.0.0.9:6767", password: "legacy" });
  });
});

describe("planSync", () => {
  it("skips the target itself and duplicates, and explains hosts it cannot plan", () => {
    const result = planSync({
      hosts: [
        host("srv_T", [{ type: "directTcp", endpoint: "127.0.0.1:6767" }]),
        host("srv_A", [{ type: "directTcp", endpoint: "10.0.0.1:6767" }]),
        host("srv_A", [{ type: "directTcp", endpoint: "10.0.0.2:6767" }]),
        host("srv_P", [{ type: "directPipe", path: "\\\\.\\pipe\\paseo" }], { label: "Pipe host" }),
      ],
      targetServerId: "srv_T",
      targetOnAppMachine: true,
      publishedOffers: new Map(),
    });
    expect(result.hosts).toEqual([
      { serverId: "srv_A", label: "srv_A", connection: "10.0.0.1:6767" },
    ]);
    expect(result.skipped).toEqual([
      { label: "Pipe host", reason: "the app reaches it only through a local socket or pipe" },
    ]);
  });

  it("recognizes hosts on the app's machine", () => {
    expect(isOnAppMachine(host("x", [{ type: "directTcp", endpoint: "localhost:6767" }]))).toBe(
      true,
    );
    expect(
      isOnAppMachine(
        host("x", [{ type: "relay", relayEndpoint: "r:443", daemonPublicKeyB64: KEY }]),
      ),
    ).toBe(false);
  });
});

describe("peerNameFor", () => {
  it("turns app labels into valid peer names", () => {
    expect(peerNameFor("Devbox CN")).toBe("devbox-cn");
    expect(peerNameFor("James's Mac mini")).toBe("james-s-mac-mini");
    expect(peerNameFor("  !!  ")).toBe("");
    expect(peerNameFor("Local")).toBe("");
  });
});
