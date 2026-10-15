import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";

export type ConnectionTarget =
  | {
      kind: "relay";
      url: string;
      /** Identity promised by the offer; the handshake must report the same ID. */
      serverId: string;
      daemonPublicKeyB64: string;
      endpoint: string;
    }
  | { kind: "direct"; url: string; endpoint: string };

/**
 * Accepts a pairing offer URL (`https://app.paseo.sh/#offer=...`), a `host:port` endpoint,
 * or a `ws://` / `wss://` URL. Throws with a readable message for anything else.
 */
export function parseConnectionTarget(input: string): ConnectionTarget {
  const value = input.trim();
  if (!value) throw new Error("Connection is empty");

  if (value.includes("#offer=")) {
    let offer: ReturnType<typeof parseConnectionOfferFromUrl>;
    try {
      offer = parseConnectionOfferFromUrl(value);
    } catch (error) {
      throw new Error(`Invalid pairing offer URL: ${describe(error)}`);
    }
    if (!offer) throw new Error("Invalid pairing offer URL");
    return {
      kind: "relay",
      url: buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        serverId: offer.serverId,
        role: "client",
        useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
      }),
      serverId: offer.serverId,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      endpoint: offer.relay.endpoint,
    };
  }

  if (/^wss?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid WebSocket URL: ${value}`);
    }
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
    return { kind: "direct", url: url.toString(), endpoint: url.host };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(
      "Unsupported connection. Use a pairing offer URL, host:port, ws:// or wss:// (forward SSH yourself with ssh -L).",
    );
  }

  try {
    return {
      kind: "direct",
      url: buildDaemonWebSocketUrl(value, { useTls: false }),
      endpoint: value,
    };
  } catch (error) {
    throw new Error(`Invalid host:port endpoint "${value}": ${describe(error)}`);
  }
}

/** Display form that never includes the offer payload or key. */
export function describeConnection(target: ConnectionTarget): string {
  return target.kind === "relay"
    ? `relay ${target.endpoint} (${target.serverId})`
    : target.endpoint;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
