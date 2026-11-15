import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { parseEnv } from "node:util";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { assertDaemonPosture, readConfig, type Environment } from "./index.ts";

const BASE_ENV: Environment = Object.freeze({
    SPLURNK_HOST: "127.0.0.1",
    SPLURNK_PORT: "3400",
    SPLURNK_PUBLIC_ORIGIN: "http://127.0.0.1:3400",
    SPLURNK_STOP_TIMEOUT_MS: "10000",
    SPLURNK_DB_PATH: "data/splurnk.db",
    SPLURNK_PLURNK_URL: "http://127.0.0.1:1067",
    SPLURNK_BOT_HANDLE: "splurnkbot",
    SPLURNK_TELEGRAM_OIDC_ISSUER: "https://oauth.telegram.org",
    SPLURNK_TELEGRAM_API_ORIGIN: "https://api.telegram.org",
});

describe("Config", () => {
    test("{§splurnk-configuration} {§splurnk-deployment-boundary} reads committed .env.defaults floor cleanly", async () => {
        const defaultsRaw = await readFile(new URL("../.env.defaults", import.meta.url), "utf8");
        const parsed = parseEnv(defaultsRaw);
        const config = readConfig(parsed);

        assert.equal(config.host, "127.0.0.1");
        assert.equal(config.port, 3400);
        assert.equal(config.publicOrigin, "http://127.0.0.1:3400");
        assert.equal(config.stopTimeoutMs, 10000);
        assert.equal(config.dbPath, "data/splurnk.db");
        assert.equal(config.plurnkUrl, "http://127.0.0.1:1067");
        assert.equal(config.botHandle, "splurnkbot");
        assert.equal(config.telegramOidcIssuer, "https://oauth.telegram.org");
        assert.equal(config.telegramApiOrigin, "https://api.telegram.org");
        assert.deepEqual(config.secrets, {
            telegramBotToken: null,
            telegramOidcClientId: null,
            telegramOidcClientSecret: null,
            sessionSecret: null,
            plurnkSecret: null,
        });
    });

    test("{§splurnk-deployment-boundary} supports dev.splurnk.app, splurnk.app, and custom third-party origins and bots", () => {
        const staging = readConfig({
            ...BASE_ENV,
            SPLURNK_PUBLIC_ORIGIN: "https://dev.splurnk.app",
            SPLURNK_BOT_HANDLE: "splurnk_dev_bot",
            TELEGRAM_BOT_TOKEN: "  test-token  ",
            SPLURNK_SESSION_SECRET: "   ",
        });

        assert.equal(staging.publicOrigin, "https://dev.splurnk.app");
        assert.equal(staging.botHandle, "splurnk_dev_bot");
        assert.equal(staging.secrets.telegramBotToken, "test-token");
        assert.equal(staging.secrets.sessionSecret, null);
    });

    test("{§splurnk-configuration} fails fast when a required floor key is absent or blank", () => {
        const { SPLURNK_HOST: _omitted, ...withoutHost } = BASE_ENV;
        assert.throws(() => readConfig(withoutHost), /SPLURNK_HOST is missing from the assembled environment floor/u);
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_DB_PATH: "   " }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_DB_PATH",
        );
    });

    test("{§splurnk-configuration} {§splurnk-deployment-boundary} rejects invalid ports, origins, and bot handles", () => {
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_PORT: "70000" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_PORT",
        );
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_PUBLIC_ORIGIN: "not a url" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_PUBLIC_ORIGIN",
        );
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_PUBLIC_ORIGIN: "ftp://splurnk.app" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_PUBLIC_ORIGIN",
        );
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_PUBLIC_ORIGIN: "https://splurnk.app/subpath" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_PUBLIC_ORIGIN",
        );
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_PUBLIC_ORIGIN: "https://splurnk.app/" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_PUBLIC_ORIGIN",
        );
        assert.throws(
            () => readConfig({ ...BASE_ENV, SPLURNK_BOT_HANDLE: "@splurnkbot" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "SPLURNK_BOT_HANDLE",
        );
    });

    test("{§splurnk-daemon-posture} validates committed config/plurnk.env security posture", async () => {
        const daemonRaw = await readFile(new URL("../config/plurnk.env", import.meta.url), "utf8");
        const daemonEnv = parseEnv(daemonRaw);
        assertDaemonPosture(daemonEnv);

        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_PORT: "1066" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_PORT",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_AUTH: "0" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_AUTH",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_EXECS_ONLY: "sh" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_EXECS_ONLY",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_SERVICE_GIT_ALLOWED: "1" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SERVICE_GIT_ALLOWED",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_SERVICE_GIT_AUTO: "1" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SERVICE_GIT_AUTO",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_SERVICE_FILE_CREATE_SCOPE: "root" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SERVICE_FILE_CREATE_SCOPE",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_MEMBERS_AUTO_ADD: "1" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_MEMBERS_AUTO_ADD",
        );
        assert.throws(
            () => assertDaemonPosture({ ...daemonEnv, PLURNK_SCHEDULE_ENABLED: "0" }),
            (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SCHEDULE_ENABLED",
        );
    });
});
