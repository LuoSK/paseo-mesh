#!/usr/bin/env node
// Stand-in for `ssh -W host:port destination` in end-to-end tests: forwards stdin/stdout to the
// TCP target like OpenSSH's stdio forwarding. A destination containing "denied" fails the way
// a missing key does, so tests can check that the SSH error reaches the peer status.
import net from "node:net";

const args = process.argv.slice(2);
const forward = args[args.indexOf("-W") + 1];
const destination = args.at(-1) ?? "";
if (!forward || !args.includes("BatchMode=yes")) {
  process.stderr.write("fake-ssh: unexpected arguments\n");
  process.exit(2);
}
if (destination.includes("denied")) {
  process.stderr.write(`${destination}: Permission denied (publickey).\n`);
  process.exit(255);
}
const [host, port] = [
  forward.slice(0, forward.lastIndexOf(":")),
  Number(forward.slice(forward.lastIndexOf(":") + 1)),
];
const socket = net.connect(port, host);
socket.on("error", (error) => {
  process.stderr.write(`fake-ssh: ${error.message}\n`);
  process.exit(255);
});
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
