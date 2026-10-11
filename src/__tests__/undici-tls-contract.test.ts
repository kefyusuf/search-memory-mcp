import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

const opensslAvailable = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

// This tests Node's underlying Undici/TLS transport contract with a local CA.
// Its test-only lookup resolves to loopback and deliberately does NOT use the
// production SSRF guard: the guarded path must never allow that address.
describe.skipIf(!opensslAvailable)("Undici TLS hostname contract (local HTTPS fixture)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("preserves URL hostname in TLS SNI and HTTP Host; rejects certificate mismatch", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mcp-tls-contract-"));
    tempDirs.push(temp);
    const keyPath = join(temp, "tls-key.pem");
    const certPath = join(temp, "tls-cert.pem");
    const generated = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=public.example.test",
      "-addext", "subjectAltName=DNS:public.example.test",
    ], { encoding: "utf8", timeout: 10000 });
    expect(generated.status, generated.stderr).toBe(0);

    const cert = readFileSync(certPath);
    const server = createServer(
      { key: readFileSync(keyPath), cert },
      (request, response) => {
        expect(request.headers.host).toBe(`public.example.test:${port}`);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("verified TLS fixture");
      },
    );
    let servername: string | undefined;
    server.on("secureConnection", (socket) => { servername = socket.servername; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    // Local fixture connection policy is intentionally not the production
    // policy. Only inspect that Undici retains original URL Host, SNI and TLS.
    const agent = new Agent({
      connect: {
        ca: cert,
        lookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
      },
    });

    try {
      const success = await fetch(`https://public.example.test:${port}/page`, {
        dispatcher: agent,
      } as RequestInit);
      expect(success.status).toBe(200);
      expect(await success.text()).toBe("verified TLS fixture");
      expect(servername).toBe("public.example.test");

      const error = await fetch(`https://other.example.test:${port}/page`, {
        dispatcher: agent,
      } as RequestInit).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      const tlsCause = (error as Error & { cause?: { code?: string } }).cause;
      expect(tlsCause?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    } finally {
      await agent.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 20000);
});
