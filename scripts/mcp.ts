import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp-server/server.js";
import { LegalServices } from "../src/services.js";

// stdio MCP server for Hermes. stdout carries the protocol: diagnostics go to stderr only.
const dataArg = process.argv.indexOf("--data");
const cfg = loadConfig({ dataDir: dataArg > 0 ? process.argv[dataArg + 1] : undefined });
const services = new LegalServices(cfg, (s) => process.stderr.write(`${s}\n`));
const server = createMcpServer(services);
await server.connect(new StdioServerTransport());
process.stderr.write(`legal-evidence MCP server ready (data: ${cfg.dataDir})\n`);
// Warm the index in the background so the first tool call is fast.
void services.search.getIndex().catch((err: unknown) => process.stderr.write(`index warm-up failed: ${(err as Error).message}\n`));
