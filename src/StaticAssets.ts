// {§splurnk-http-lifecycle} Preloaded Vite static asset inventory with br/gzip negotiation.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import Negotiator from "negotiator";
import HttpError from "./HttpError.ts";

export type AssetInventoryEntry = readonly [
    pathname: string,
    file: string,
    mediaType: string,
    encoded: Readonly<Record<string, string>>,
];

export interface LoadedAsset {
    readonly pathname: string;
    readonly mediaType: string;
    readonly immutable: boolean;
    readonly representations: ReadonlyMap<string, Buffer>;
    readonly preferredEncodings: readonly string[];
}

export class StaticAssets {
    readonly #indexHtml: string;
    readonly #assets: ReadonlyMap<string, LoadedAsset>;

    constructor(indexHtml: string, assets: ReadonlyMap<string, LoadedAsset>) {
        this.#indexHtml = indexHtml;
        this.#assets = assets;
    }

    static async loadFromDist(
        distClientUrl: URL = new URL("../dist/client/", import.meta.url),
    ): Promise<StaticAssets> {
        const rawInventory = await readFile(new URL("assets.json", distClientUrl), "utf8");
        const inventory = JSON.parse(rawInventory) as AssetInventoryEntry[];

        let indexHtml: string | null = null;
        const assets = new Map<string, LoadedAsset>();

        await Promise.all(
            inventory.map(async ([pathname, relFile, mediaType, encoded]) => {
                const identityBody = await readFile(new URL(relFile, distClientUrl));
                if (pathname === "/index.html") {
                    indexHtml = identityBody.toString("utf8");
                    return;
                }
                const variantPairs = await Promise.all(
                    Object.entries(encoded).map(
                        async ([encoding, encodedFile]) =>
                            [encoding, await readFile(new URL(encodedFile, distClientUrl))] as const,
                    ),
                );
                const representations = new Map<string, Buffer>([
                    ["identity", identityBody],
                    ...variantPairs,
                ]);
                const preferredEncodings = [...representations]
                    .toSorted(([, a], [, b]) => a.byteLength - b.byteLength)
                    .map(([encoding]) => encoding);

                assets.set(pathname, {
                    pathname,
                    mediaType,
                    immutable: pathname.startsWith("/assets/"),
                    representations,
                    preferredEncodings,
                });
            }),
        );

        if (indexHtml === null) {
            throw new Error("Built web asset inventory is missing /index.html.");
        }

        return new StaticAssets(indexHtml, assets);
    }

    get indexHtml(): string {
        return this.#indexHtml;
    }

    has(pathname: string): boolean {
        return this.#assets.has(pathname);
    }

    serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
        const asset = this.#assets.get(pathname);
        if (!asset) {
            return false;
        }

        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") {
            throw new HttpError(
                405,
                "method-not-allowed",
                "Method Not Allowed",
                `Method ${method} is not allowed on static assets.`,
                { headers: { Allow: "GET, HEAD" } },
            );
        }

        const negotiator = new Negotiator(req);
        const chooseEncoding = negotiator.encoding as (
            available: readonly string[],
            options: { preferred: readonly string[] },
        ) => string | undefined;
        const encoding = chooseEncoding.call(negotiator, asset.preferredEncodings, {
            preferred: asset.preferredEncodings,
        });
        if (encoding === undefined) {
            throw new HttpError(
                406,
                "not-acceptable",
                "Not Acceptable",
                "No acceptable content encoding.",
                { headers: { Vary: "Accept-Encoding" } },
            );
        }

        const body = asset.representations.get(encoding);
        if (!body) {
            throw new Error(`Negotiated undeclared asset encoding: ${encoding}`);
        }

        const contentType = asset.mediaType.startsWith("text/")
            ? `${asset.mediaType}; charset=utf-8`
            : asset.mediaType;

        res.writeHead(200, {
            "Cache-Control": asset.immutable
                ? "public, max-age=31536000, immutable"
                : "public, max-age=3600",
            "Content-Length": String(body.byteLength),
            "Content-Type": contentType,
            Vary: "Accept-Encoding",
            "X-Content-Type-Options": "nosniff",
            ...(encoding === "identity" ? {} : { "Content-Encoding": encoding }),
        });
        if (method === "HEAD") {
            res.end();
        } else {
            res.end(body);
        }
        return true;
    }
}
