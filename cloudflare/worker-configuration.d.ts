// Minimal binding types for this Worker.
// Base runtime types (KVNamespace, DurableObjectNamespace, etc.) come from
// @cloudflare/workers-types via tsconfig. Regenerate the full file any time with
// `npx wrangler types` if you develop locally.
declare namespace Cloudflare {
	interface Env {
		OAUTH_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		REDMINE_URL: string;
		REDMINE_API_KEY: string;
		MCP_OBJECT: DurableObjectNamespace<import("./src/index").MyMCP>;
	}
}
interface Env extends Cloudflare.Env {}
