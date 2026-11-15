import { readConfig } from "./Config.ts";
import SplurnkServer from "./Server.ts";

const config = readConfig();
const server = new SplurnkServer(config);
const boundUrl = await server.start();
process.stdout.write(`Splurnk listening on ${boundUrl} (origin: ${config.publicOrigin})\n`);

const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`Received ${signal}; draining Splurnk...\n`);
    await server.stop();
    process.exit(0);
};

process.once("SIGINT", () => {
    void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
});
