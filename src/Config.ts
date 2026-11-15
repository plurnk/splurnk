// {§splurnk-configuration} {§splurnk-deployment-boundary} {§splurnk-daemon-posture}
// Configuration boundary: every deployment choice lives in .env.defaults and enters
// exclusively through @plurnk/plurnk-meta Knob with zero reader-local defaults.
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

export type Environment = Readonly<Record<string, string | undefined>>;

const BOT_HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,31}$/u;
const OPERATOR_DAEMON_PORT = 1066;
const MAX_TCP_PORT = 65535;

export interface SplurnkSecrets {
    readonly telegramBotToken: string | null;
    readonly telegramOidcClientId: string | null;
    readonly telegramOidcClientSecret: string | null;
    readonly sessionSecret: string | null;
    readonly plurnkSecret: string | null;
}

export interface SplurnkConfig {
    readonly host: string;
    readonly port: number;
    readonly publicOrigin: string;
    readonly stopTimeoutMs: number;
    readonly dbPath: string;
    readonly plurnkUrl: string;
    readonly botHandle: string;
    readonly telegramOidcIssuer: string;
    readonly telegramApiOrigin: string;
    readonly loginTtlSec: number;
    readonly sessionTtlSec: number;
    readonly secrets: SplurnkSecrets;
}

function readRequiredText(name: string, env: Environment): string {
    const value = Knob.text(name, env).trim();
    if (value.length === 0) {
        throw new ConfigurationError(name, `${name} must not be empty.`);
    }
    return value;
}

function readHttpOrigin(name: string, env: Environment): string {
    const raw = readRequiredText(name, env);
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch (cause) {
        throw new ConfigurationError(name, `${name} must be a valid http(s) origin; got ${JSON.stringify(raw)}.`, { cause });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ConfigurationError(name, `${name} must use http: or https:; got ${JSON.stringify(parsed.protocol)}.`);
    }
    if (
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        (parsed.pathname !== "/" && parsed.pathname !== "") ||
        parsed.search.length > 0 ||
        parsed.hash.length > 0 ||
        raw.endsWith("/")
    ) {
        throw new ConfigurationError(
            name,
            `${name} must be a bare origin without credentials, path, query,hash, or trailing slash; got ${JSON.stringify(raw)}.`,
        );
    }
    return parsed.origin;
}

function readPort(name: string, env: Environment): number {
    const port = Knob.integer(name, 0, env);
    if (port > MAX_TCP_PORT) {
        throw new ConfigurationError(name, `${name} must be between 0 and ${MAX_TCP_PORT}; got ${port}.`);
    }
    return port;
}

function readBotHandle(name: string, env: Environment): string {
    const handle = readRequiredText(name, env);
    if (!BOT_HANDLE_PATTERN.test(handle)) {
        throw new ConfigurationError(
            name,
            `${name} must be a valid bot handle without leading '@'; got ${JSON.stringify(handle)}.`,
        );
    }
    return handle;
}

function readOptionalSecret(name: string, env: Environment): string | null {
    const raw = env[name];
    if (raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readConfig(env: Environment = process.env): SplurnkConfig {
    const secrets: SplurnkSecrets = Object.freeze({
        telegramBotToken: readOptionalSecret("TELEGRAM_BOT_TOKEN", env),
        telegramOidcClientId: readOptionalSecret("TELEGRAM_OIDC_CLIENT_ID", env),
        telegramOidcClientSecret: readOptionalSecret("TELEGRAM_OIDC_CLIENT_SECRET", env),
        sessionSecret: readOptionalSecret("SPLURNK_SESSION_SECRET", env),
        plurnkSecret: readOptionalSecret("PLURNK_SECRET", env),
    });

    return Object.freeze({
        host: readRequiredText("SPLURNK_HOST", env),
        port: readPort("SPLURNK_PORT", env),
        publicOrigin: readHttpOrigin("SPLURNK_PUBLIC_ORIGIN", env),
        stopTimeoutMs: Knob.integer("SPLURNK_STOP_TIMEOUT_MS", 1, env),
        dbPath: readRequiredText("SPLURNK_DB_PATH", env),
        plurnkUrl: readHttpOrigin("SPLURNK_PLURNK_URL", env),
        botHandle: readBotHandle("SPLURNK_BOT_HANDLE", env),
        telegramOidcIssuer: readHttpOrigin("SPLURNK_TELEGRAM_OIDC_ISSUER", env),
        telegramApiOrigin: readHttpOrigin("SPLURNK_TELEGRAM_API_ORIGIN", env),
        loginTtlSec: Knob.integer("SPLURNK_LOGIN_TTL_SEC", 1, env),
        sessionTtlSec: Knob.integer("SPLURNK_SESSION_TTL_SEC", 1, env),
        secrets,
    });
}

// {§splurnk-daemon-posture} Asserts that a parsed config/plurnk.env profile preserves
// Splurnk's locked-down Plurnk daemon posture and stays off the operator's :1066 port.
export function assertDaemonPosture(env: Environment): void {
    const port = readPort("PLURNK_PORT", env);
    if (port === 0 || port === OPERATOR_DAEMON_PORT) {
        throw new ConfigurationError(
            "PLURNK_PORT",
            `PLURNK_PORT must be a dedicated port distinct from ${OPERATOR_DAEMON_PORT}; got ${port}.`,
        );
    }
    if (!Knob.flag("PLURNK_AUTH", env)) {
        throw new ConfigurationError("PLURNK_AUTH", "PLURNK_AUTH must be 1 for Splurnk's Plurnk daemon.");
    }
    const execsOnly = Knob.text("PLURNK_EXECS_ONLY", env).trim();
    if (execsOnly.length !== 0) {
        throw new ConfigurationError("PLURNK_EXECS_ONLY", "PLURNK_EXECS_ONLY must be empty so all host executors stay disabled.");
    }
    if (Knob.flag("PLURNK_SERVICE_GIT_ALLOWED", env)) {
        throw new ConfigurationError("PLURNK_SERVICE_GIT_ALLOWED", "PLURNK_SERVICE_GIT_ALLOWED must be 0.");
    }
    if (Knob.flag("PLURNK_SERVICE_GIT_AUTO", env)) {
        throw new ConfigurationError("PLURNK_SERVICE_GIT_AUTO", "PLURNK_SERVICE_GIT_AUTO must be 0.");
    }
    Knob.choice("PLURNK_SERVICE_FILE_CREATE_SCOPE", ["none"], env);
    Knob.choice("PLURNK_SERVICE_MEMBERS_MODEL_SCOPE", ["none"], env);
    if (Knob.flag("PLURNK_MEMBERS_AUTO_ADD", env)) {
        throw new ConfigurationError("PLURNK_MEMBERS_AUTO_ADD", "PLURNK_MEMBERS_AUTO_ADD must be 0.");
    }
    Knob.choice("PLURNK_SERVICE_PROPOSALS", ["review"], env);
    if (!Knob.flag("PLURNK_SCHEDULE_ENABLED", env)) {
        throw new ConfigurationError("PLURNK_SCHEDULE_ENABLED", "PLURNK_SCHEDULE_ENABLED must be 1.");
    }
}
