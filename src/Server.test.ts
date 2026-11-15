import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { afterEach, describe, test } from "node:test";
import { readConfig, SplurnkServer, type ProblemDetails, type RouteHandler } from "./index.ts";

const activeServers: SplurnkServer[] = [];

afterEach(async () => {
    while (activeServers.length > 0) {
        const server = activeServers.pop();
        if (server) await server.stop();
    }
});

function createTestServer(
    overrides: Readonly<Record<string, string>> = {},
    route: RouteHandler | null = null,
): SplurnkServer {
    const config = readConfig({
        ...process.env,
        SPLURNK_HOST: "127.0.0.1",
        SPLURNK_PORT: "0",
        SPLURNK_PUBLIC_ORIGIN: "https://dev.splurnk.app",
        SPLURNK_BOT_HANDLE: "splurnkbot",
        SPLURNK_STOP_TIMEOUT_MS: "2000",
        ...overrides,
    });
    const server = new SplurnkServer(config, route);
    activeServers.push(server);
    return server;
}

describe("SplurnkServer", () => {
    test("{§splurnk-http-lifecycle} serves /health, /, HEAD parity, 404, 405, and route errors cleanly", async () => {
        const server = createTestServer({}, (req, res) => {
            if (req.url === "/custom") {
                res.writeHead(204);
                res.end();
                return true;
            }
            if (req.url === "/boom") {
                throw new Error("boom");
            }
            return false;
        });
        assert.throws(() => server.url, /has not been started/u);

        const baseUrl = await server.start();
        assert.equal(await server.start(), baseUrl);
        assert.equal(server.url, baseUrl);

        const health = await fetch(`${baseUrl}/health`);
        assert.equal(health.status, 200);
        assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
        assert.equal(health.headers.get("x-content-type-options"), "nosniff");
        assert.equal(health.headers.get("cache-control"), "no-store");
        assert.deepEqual(await health.json(), {
            status: "ok",
            origin: "https://dev.splurnk.app",
            botHandle: "splurnkbot",
        });

        const headHealth = await fetch(`${baseUrl}/health`, { method: "HEAD" });
        assert.equal(headHealth.status, 200);
        assert.equal(await headHealth.text(), "");

        const home = await fetch(`${baseUrl}/`);
        assert.equal(home.status, 200);
        assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
        const html = await home.text();
        assert.match(html, /@splurnkbot/u);
        assert.match(html, /https:\/\/dev\.splurnk\.app/u);

        const custom = await fetch(`${baseUrl}/custom`);
        assert.equal(custom.status, 204);

        const boom = await fetch(`${baseUrl}/boom`);
        assert.equal(boom.status, 500);
        const boomBody = (await boom.json()) as ProblemDetails;
        assert.equal(boomBody.type, "https://problems.plurnk.xyz/splurnk/request-failed");

        const missing = await fetch(`${baseUrl}/unknown`);
        assert.equal(missing.status, 404);
        assert.equal(missing.headers.get("content-type"), "application/problem+json; charset=utf-8");
        const missingBody = (await missing.json()) as ProblemDetails;
        assert.equal(missingBody.type, "https://problems.plurnk.xyz/splurnk/not-found");
        assert.equal(missingBody.status, 404);

        const wrongMethod = await fetch(`${baseUrl}/health`, { method: "POST" });
        assert.equal(wrongMethod.status, 405);
        assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD");
        const wrongMethodBody = (await wrongMethod.json()) as ProblemDetails;
        assert.equal(wrongMethodBody.type, "https://problems.plurnk.xyz/splurnk/method-not-allowed");
        assert.equal(wrongMethodBody.status, 405);
    });

    test("{§splurnk-http-lifecycle} answers 503 service-stopping on pipelined requests during drain and enforces stopTimeoutMs", async () => {
        const unstarted = createTestServer();
        await unstarted.stop();
        await assert.rejects(() => unstarted.start(), /cannot restart after stopping/u);

        let enteredSlow = (): void => {};
        const slowEntered = new Promise<void>((resolve) => {
            enteredSlow = resolve;
        });
        let releaseSlow = (): void => {};
        const slowGate = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });

        const server = createTestServer({ SPLURNK_STOP_TIMEOUT_MS: "2000" }, async (req, res) => {
            if (req.url === "/slow") {
                enteredSlow();
                await slowGate;
                res.writeHead(200, { "Content-Length": "2", "Content-Type": "text/plain" });
                res.end("ok");
                return true;
            }
            return false;
        });
        const baseUrl = new URL(await server.start());
        const port = Number(baseUrl.port);

        // Send a slow request followed by a pipelined /health request on the same socket after stop() starts.
        const rawTranscript = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const socket = createConnection({ host: "127.0.0.1", port }, () => {
                socket.write("GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            });
            socket.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            socket.on("error", reject);
            socket.on("close", () => {
                resolve(Buffer.concat(chunks).toString("utf8"));
            });

            void slowEntered.then(() => {
                const stopping = server.stop();
                socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
                releaseSlow();
                void stopping;
            });
        });

        assert.match(rawTranscript, /HTTP\/1\.1 200 OK/u);
        assert.match(rawTranscript, /HTTP\/1\.1 503 Service Unavailable/u);
        assert.match(rawTranscript, /"https:\/\/problems\.plurnk\.xyz\/splurnk\/service-stopping"/u);
        await server.stop();

        // Also verify stopTimeoutMs forcibly closes wedged connections when deadline expires.
        let enteredWedged = (): void => {};
        const wedgedEntered = new Promise<void>((resolve) => {
            enteredWedged = resolve;
        });
        const wedgedServer = createTestServer({ SPLURNK_STOP_TIMEOUT_MS: "30" }, async (req) => {
            if (req.url === "/wedged") {
                enteredWedged();
                await new Promise<void>(() => {});
                return true;
            }
            return false;
        });
        const wedgedUrl = await wedgedServer.start();
        const wedgedFetch = fetch(`${wedgedUrl}/wedged`).catch(() => null);
        await wedgedEntered;
        await wedgedServer.stop();
        await wedgedFetch;
    });
});
