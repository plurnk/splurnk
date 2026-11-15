import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOTS = ["scripts", "src", "test", "web"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const SQL =
    /\b(?:alter\s+table|create\s+(?:index|table|trigger|view)|delete\s+from|drop\s+(?:index|table|trigger|view)|insert\s+into|pragma\b|select\s+.+\s+from|update\s+\S+\s+set)\b/isu;

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        },
    );
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const child = join(directory, entry.name);
            if (entry.isDirectory()) return sourceFiles(child);
            return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [child] : [];
        }),
    );
    return nested.flat();
}

function stringLiterals(source: string): Array<{ text: string; line: number }> {
    const literals: Array<{ text: string; line: number }> = [];
    let index = 0;
    let line = 1;
    while (index < source.length) {
        const character = source[index];
        const next = source[index + 1];
        if (character === "/" && next === "/") {
            index = source.indexOf("\n", index + 2);
            if (index === -1) break;
            line += 1;
            index += 1;
            continue;
        }
        if (character === "/" && next === "*") {
            const end = source.indexOf("*/", index + 2);
            const block = source.slice(index, end === -1 ? source.length : end + 2);
            line += block.match(/\n/gu)?.length ?? 0;
            index = end === -1 ? source.length : end + 2;
            continue;
        }
        if (character !== '"' && character !== "'" && character !== "`") {
            if (character === "\n") line += 1;
            index += 1;
            continue;
        }

        const quote = character;
        const startLine = line;
        let text = "";
        index += 1;
        while (index < source.length) {
            const current = source[index];
            if (current === "\\") {
                text += source.slice(index, index + 2);
                index += 2;
                continue;
            }
            if (current === quote) {
                index += 1;
                break;
            }
            if (current === "\n") line += 1;
            text += current;
            index += 1;
        }
        literals.push({ text, line: startLine });
    }
    return literals;
}

const violations: string[] = [];
for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
        if (file === "scripts/check-sql-boundary.ts") continue;
        const source = await readFile(file, "utf8");
        for (const { text, line } of stringLiterals(source)) {
            if (text && SQL.test(text)) {
                violations.push(`${file}:${line}`);
            }
        }
    }
}

assert.deepEqual(
    violations,
    [],
    `SQL literals are forbidden outside .sql files:\n${violations.join("\n")}`,
);
