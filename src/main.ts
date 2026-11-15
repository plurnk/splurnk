import { readConfig } from "./Config.ts";
import Splurnk from "./Splurnk.ts";

const config = readConfig();
const app = new Splurnk({ config });
const boundUrl = await app.start();
process.stdout.write(`Splurnk listening on ${boundUrl} (origin: ${config.publicOrigin})\n`);

const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`Received ${signal}; draining Splurnk...\n`);
    await app.stop();
    process.exit(0);
};

process.once("SIGINT", () => {
    void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
});
