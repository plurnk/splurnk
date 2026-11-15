// {§splurnk-http-lifecycle} HTTP listener, health readiness, semantic landing document,
// RFC 9457 Problem Details, and bounded shutdown settlement.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SplurnkConfig } from "./Config.ts";

const PROBLEM_TYPE_PREFIX = "https://problems.plurnk.xyz/splurnk";

export interface ProblemDetails {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail?: string;
    readonly retryable?: boolean;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function renderIndexDocument(config: SplurnkConfig): string {
    const handle = escapeHtml(`@${config.botHandle}`);
    const origin = escapeHtml(config.publicOrigin);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Splurnk</title>
  </head>
  <body>
    <main>
      <h1>Splurnk</h1>
      <p>Social task coordination with <code>${handle}</code> at <code>${origin}</code>.</p>
    </main>
  </body>
</html>
`;
}

function writeBody(
    res: ServerResponse,
    method: string,
    status: number,
    contentType: string,
    payload: string,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    const body = Buffer.from(payload, "utf8");
    res.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Length": String(body.byteLength),
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders,
    });
    if (method === "HEAD") {
        res.end();
        return;
    }
    res.end(body);
}

export function writeProblem(
    res: ServerResponse,
    method: string,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    writeBody(
        res,
        method,
        problem.status,
        "application/problem+json; charset=utf-8",
        `${JSON.stringify(problem)}\n`,
        extraHeaders,
    );
}

export default class SplurnkServer {
    readonly #config: SplurnkConfig;
    readonly #route: RouteHandler | null;
    readonly #server: Server;
    readonly #inFlight = new Set<Promise<void>>();
    #listening = false;
    #stopping: Promise<void> | null = null;
    #origin: string | null = null;

    constructor(config: SplurnkConfig, route: RouteHandler | null = null) {
        this.#config = config;
        this.#route = route;
        this.#server = createServer((req, res) => {
            const task = this.#handle(req, res).finally(() => {
                this.#inFlight.delete(task);
            });
            this.#inFlight.add(task);
        });
    }

    get url(): string {
        if (this.#origin === null) {
            throw new Error("SplurnkServer has not been started.");
        }
        return this.#origin;
    }

    async start(): Promise<string> {
        if (this.#stopping !== null) {
            throw new Error("SplurnkServer cannot restart after stopping.");
        }
        if (this.#listening && this.#origin !== null) {
            return this.#origin;
        }
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.#server.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                this.#server.off("error", onError);
                resolve();
            };
            this.#server.once("error", onError);
            this.#server.once("listening", onListening);
            this.#server.listen(this.#config.port, this.#config.host);
        });
        const addr = this.#server.address() as AddressInfo;
        const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
        this.#origin = `http://${host}:${addr.port}`;
        this.#listening = true;
        return this.#origin;
    }

    async stop(): Promise<void> {
        if (this.#stopping !== null) {
            return await this.#stopping;
        }
        this.#stopping = this.#drainAndClose();
        return await this.#stopping;
    }

    async #drainAndClose(): Promise<void> {
        if (!this.#listening) {
            return;
        }
        let timer: NodeJS.Timeout | null = null;
        const closePromise = new Promise<void>((resolve) => {
            this.#server.close(() => {
                resolve();
            });
        });
        this.#server.closeIdleConnections();
        try {
            await Promise.race([
                Promise.all([Promise.allSettled(this.#inFlight), closePromise]),
                new Promise<void>((resolve) => {
                    timer = setTimeout(() => {
                        this.#server.closeAllConnections();
                        resolve();
                    }, this.#config.stopTimeoutMs);
                }),
            ]);
            await closePromise;
        } finally {
            if (timer !== null) clearTimeout(timer);
            this.#listening = false;
        }
    }

    async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        if (this.#stopping !== null) {
            writeProblem(
                res,
                method,
                {
                    type: `${PROBLEM_TYPE_PREFIX}/service-stopping`,
                    title: "Service Unavailable",
                    status: 503,
                    detail: "Splurnk is stopping and refusing new requests.",
                    retryable: true,
                },
                { Connection: "close" },
            );
            return;
        }

        try {
            if (this.#route !== null && (await this.#route(req, res))) {
                return;
            }
        } catch {
            if (!res.headersSent) {
                writeProblem(res, method, {
                    type: `${PROBLEM_TYPE_PREFIX}/request-failed`,
                    title: "Internal Server Error",
                    status: 500,
                });
            }
            return;
        }

        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== "/" && pathname !== "/health") {
            writeProblem(res, method, {
                type: `${PROBLEM_TYPE_PREFIX}/not-found`,
                title: "Not Found",
                status: 404,
            });
            return;
        }

        if (method !== "GET" && method !== "HEAD") {
            writeProblem(
                res,
                method,
                {
                    type: `${PROBLEM_TYPE_PREFIX}/method-not-allowed`,
                    title: "Method Not Allowed",
                    status: 405,
                },
                { Allow: "GET, HEAD" },
            );
            return;
        }

        if (pathname === "/health") {
            writeBody(
                res,
                method,
                200,
                "application/json; charset=utf-8",
                `${JSON.stringify({
                    status: "ok",
                    origin: this.#config.publicOrigin,
                    botHandle: this.#config.botHandle,
                })}\n`,
            );
            return;
        }

        writeBody(res, method, 200, "text/html; charset=utf-8", renderIndexDocument(this.#config));
    }
}
