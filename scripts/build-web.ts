import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { build } from "vite";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain",
    ".woff2": "font/woff2",
};

const CODECS: ReadonlyArray<
    readonly [string, string, (buf: Buffer) => Promise<Buffer>]
> = [
    ["br", ".br", promisify(brotliCompress)],
    ["gzip", ".gz", promisify(gzip)],
];

export async function prepareVendorAssets(): Promise<void> {
    const webRoot = new URL("../web/", import.meta.url);
    const otmRoot = new URL("../../", import.meta.resolve("on_the_money"));
    const picoRoot = new URL("./", import.meta.resolve("@picocss/pico/package.json"));
    const vendorDir = new URL("./public/vendor/", webRoot);
    const stylesDir = new URL("./styles/", webRoot);

    await mkdir(vendorDir, { recursive: true });
    await mkdir(stylesDir, { recursive: true });

    await copyFile(new URL("LICENSE", otmRoot), new URL("OTM-LICENSE.txt", vendorDir));
    await copyFile(
        new URL("css/pico.classless.green.css", picoRoot),
        new URL("app-vendor.css", stylesDir),
    );
    await copyFile(new URL("LICENSE.md", picoRoot), new URL("PICO-LICENSE.txt", vendorDir));
}

export async function buildWebAssets(): Promise<void> {
    await prepareVendorAssets();
    await build({ logLevel: "warn" });

    const outputDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
    const entries = await readdir(outputDir, { recursive: true, withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const relFile = relative(outputDir, resolve(entry.parentPath, entry.name)).replaceAll(
                "\\",
                "/",
            );
            const mediaType = MEDIA_TYPES[extname(relFile)];
            if (!mediaType) {
                throw new Error(`Undeclared media type for built web asset: ${relFile}`);
            }
            return [`/${relFile}`, relFile, mediaType] as const;
        })
        .toSorted(([a], [b]) => a.localeCompare(b));

    const inventory = await Promise.all(
        files.map(async ([urlPath, relFile, mediaType]) => {
            const body = await readFile(resolve(outputDir, relFile));
            const encodedPairs =
                mediaType === "text/html"
                    ? []
                    : await Promise.all(
                          CODECS.map(async ([encoding, suffix, compress]) => {
                              const compressed = await compress(body);
                              if (compressed.byteLength >= body.byteLength) {
                                  return null;
                              }
                              const target = `${relFile}${suffix}`;
                              await writeFile(resolve(outputDir, target), compressed);
                              return [encoding, target] as const;
                          }),
                      );
            const encoded = Object.fromEntries(
                encodedPairs.filter((pair): pair is readonly [string, string] => pair !== null),
            );
            return [urlPath, relFile, mediaType, encoded] as const;
        }),
    );

    await writeFile(
        new URL("../dist/client/assets.json", import.meta.url),
        `${JSON.stringify(inventory, null, 2)}\n`,
    );
}

if (import.meta.main) {
    await buildWebAssets();
}
