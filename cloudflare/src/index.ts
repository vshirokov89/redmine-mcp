import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

/**
 * Auth context passed down from the GitHub OAuth flow, available as this.props.
 */
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

/**
 * GitHub usernames allowed to use this connector. In single-user mode this is
 * just the owner. Anyone else can authenticate but gets no Redmine tools.
 */
const ALLOWED_USERNAMES = new Set<string>(["vshirokov89"]);

// ---------------------------------------------------------------------------
// Redmine REST helpers
// ---------------------------------------------------------------------------

type RedmineResponse = { status: number; data: unknown };

async function redmineFetch(
	env: Env,
	method: string,
	path: string,
	opts: { params?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<RedmineResponse> {
	const url = new URL(path, env.REDMINE_URL);
	if (opts.params) {
		for (const [k, v] of Object.entries(opts.params)) {
			if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
		}
	}
	const headers: Record<string, string> = { "X-Redmine-API-Key": env.REDMINE_API_KEY };
	let body: string | undefined;
	if (opts.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(opts.body);
	}
	const resp = await fetch(url.toString(), { method, headers, body });
	const text = await resp.text();
	let data: unknown = text;
	try {
		data = text ? JSON.parse(text) : { ok: true };
	} catch {
		/* keep raw text */
	}
	return { status: resp.status, data };
}

type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

function toResult(r: RedmineResponse): ToolResult {
	if (r.status >= 400) {
		let msg = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
		const d = r.data as { errors?: string[] } | null;
		if (d && Array.isArray(d.errors)) msg = d.errors.join("; ");
		return { content: [{ type: "text", text: `Redmine error ${r.status}: ${msg}` }], isError: true };
	}
	const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
	return { content: [{ type: "text", text }] };
}

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
	return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "Redmine", version: "0.1.0" });

	async init() {
		const env = this.env;

		// Always available: identity + access check.
		this.server.tool(
			"whoami",
			"Show the authenticated GitHub identity, whether this account may use Redmine tools, and the connected Redmine user.",
			{},
			async () => {
				const allowed = ALLOWED_USERNAMES.has(this.props!.login);
				const lines = [
					`GitHub: ${this.props!.name} (@${this.props!.login})`,
					`Access to Redmine tools: ${allowed ? "yes" : "no"}`,
				];
				if (allowed) {
					const me = await redmineFetch(env, "GET", "/users/current.json");
					const u = (me.data as { user?: { firstname?: string; lastname?: string; login?: string; id?: number } })?.user;
					if (u) lines.push(`Redmine: ${u.firstname ?? ""} ${u.lastname ?? ""} (login ${u.login}, id ${u.id})`);
					else lines.push(`Redmine: could not read current user (HTTP ${me.status})`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }] };
			},
		);

		if (!ALLOWED_USERNAMES.has(this.props!.login)) return;

		// ----- Issues -----
		this.server.tool(
			"list_issues",
			"Search Redmine issues. Defaults to open issues; pass status_id='*' for all or 'closed' for closed.",
			{
				project_id: z.string().optional().describe("Project identifier or numeric id"),
				status_id: z.string().optional().describe("Status id, or 'open' | 'closed' | '*'"),
				assigned_to_id: z.string().optional().describe("Assignee user id, or 'me'"),
				tracker_id: z.number().optional(),
				priority_id: z.number().optional(),
				subject: z.string().optional().describe("Substring match on the subject"),
				sort: z.string().optional().describe("e.g. 'updated_on:desc'"),
				limit: z.number().min(1).max(100).default(25),
				offset: z.number().min(0).default(0),
			},
			async (a) => {
				const params = clean({
					project_id: a.project_id,
					status_id: a.status_id ?? "open",
					assigned_to_id: a.assigned_to_id,
					tracker_id: a.tracker_id,
					priority_id: a.priority_id,
					subject: a.subject ? `~${a.subject}` : undefined,
					sort: a.sort,
					limit: a.limit,
					offset: a.offset,
				});
				return toResult(await redmineFetch(env, "GET", "/issues.json", { params }));
			},
		);

		this.server.tool(
			"get_issue",
			"Get one issue with full detail.",
			{
				issue_id: z.number(),
				include: z
					.string()
					.optional()
					.describe("Comma list: journals,attachments,relations,children,watchers"),
			},
			async (a) =>
				toResult(
					await redmineFetch(env, "GET", `/issues/${a.issue_id}.json`, {
						params: { include: a.include ?? "journals,attachments,relations,children" },
					}),
				),
		);

		this.server.tool(
			"create_issue",
			"Create a new Redmine issue.",
			{
				project_id: z.string().describe("Project identifier or numeric id"),
				subject: z.string(),
				description: z.string().optional(),
				tracker_id: z.number().optional(),
				status_id: z.number().optional(),
				priority_id: z.number().optional(),
				assigned_to_id: z.number().optional(),
				parent_issue_id: z.number().optional(),
				fixed_version_id: z.number().optional(),
			},
			async (a) => {
				const issue = clean({
					project_id: a.project_id,
					subject: a.subject,
					description: a.description,
					tracker_id: a.tracker_id,
					status_id: a.status_id,
					priority_id: a.priority_id,
					assigned_to_id: a.assigned_to_id,
					parent_issue_id: a.parent_issue_id,
					fixed_version_id: a.fixed_version_id,
				});
				return toResult(await redmineFetch(env, "POST", "/issues.json", { body: { issue } }));
			},
		);

		this.server.tool(
			"update_issue",
			"Update an issue's fields and/or add a comment (note).",
			{
				issue_id: z.number(),
				subject: z.string().optional(),
				description: z.string().optional(),
				status_id: z.number().optional(),
				priority_id: z.number().optional(),
				assigned_to_id: z.number().optional(),
				done_ratio: z.number().min(0).max(100).optional(),
				notes: z.string().optional(),
				private_notes: z.boolean().optional(),
			},
			async (a) => {
				const issue = clean({
					subject: a.subject,
					description: a.description,
					status_id: a.status_id,
					priority_id: a.priority_id,
					assigned_to_id: a.assigned_to_id,
					done_ratio: a.done_ratio,
					notes: a.notes,
					private_notes: a.notes && a.private_notes ? true : undefined,
				});
				if (Object.keys(issue).length === 0) {
					return {
						content: [{ type: "text", text: "Nothing to update: provide at least one field or a note." }],
						isError: true,
					};
				}
				const r = await redmineFetch(env, "PUT", `/issues/${a.issue_id}.json`, { body: { issue } });
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Issue #${a.issue_id} updated.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"add_issue_comment",
			"Add a comment (journal note) to an issue.",
			{
				issue_id: z.number(),
				notes: z.string(),
				private_notes: z.boolean().optional(),
			},
			async (a) => {
				const issue = clean({ notes: a.notes, private_notes: a.private_notes ? true : undefined });
				const r = await redmineFetch(env, "PUT", `/issues/${a.issue_id}.json`, { body: { issue } });
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Comment added to #${a.issue_id}.` }] };
				return toResult(r);
			},
		);

		// ----- Time tracking -----
		this.server.tool(
			"list_time_entries",
			"List time entries with optional filters.",
			{
				issue_id: z.number().optional(),
				project_id: z.string().optional(),
				user_id: z.string().optional().describe("User id or 'me'"),
				spent_on: z.string().optional().describe("Exact date YYYY-MM-DD"),
				from: z.string().optional().describe("Range start YYYY-MM-DD"),
				to: z.string().optional().describe("Range end YYYY-MM-DD"),
				limit: z.number().min(1).max(100).default(25),
				offset: z.number().min(0).default(0),
			},
			async (a) =>
				toResult(
					await redmineFetch(env, "GET", "/time_entries.json", {
						params: clean({
							issue_id: a.issue_id,
							project_id: a.project_id,
							user_id: a.user_id,
							spent_on: a.spent_on,
							from: a.from,
							to: a.to,
							limit: a.limit,
							offset: a.offset,
						}),
					}),
				),
		);

		this.server.tool(
			"create_time_entry",
			"Log time against an issue or a project. Provide issue_id OR project_id.",
			{
				hours: z.number().positive(),
				issue_id: z.number().optional(),
				project_id: z.string().optional(),
				spent_on: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
				activity_id: z.number().optional(),
				comments: z.string().optional(),
			},
			async (a) => {
				if (!a.issue_id && !a.project_id) {
					return {
						content: [{ type: "text", text: "Provide either issue_id or project_id." }],
						isError: true,
					};
				}
				const time_entry = clean({
					hours: a.hours,
					issue_id: a.issue_id,
					project_id: a.project_id,
					spent_on: a.spent_on,
					activity_id: a.activity_id,
					comments: a.comments,
				});
				return toResult(await redmineFetch(env, "POST", "/time_entries.json", { body: { time_entry } }));
			},
		);

		// ----- Projects & reference data -----
		this.server.tool(
			"list_projects",
			"List projects visible to the account.",
			{ limit: z.number().min(1).max(100).default(100), offset: z.number().min(0).default(0) },
			async (a) =>
				toResult(await redmineFetch(env, "GET", "/projects.json", { params: { limit: a.limit, offset: a.offset } })),
		);

		this.server.tool("list_statuses", "List issue statuses (id + name).", {}, async () =>
			toResult(await redmineFetch(env, "GET", "/issue_statuses.json")),
		);
		this.server.tool("list_trackers", "List trackers / issue types (id + name).", {}, async () =>
			toResult(await redmineFetch(env, "GET", "/trackers.json")),
		);
		this.server.tool("list_priorities", "List issue priorities (id + name).", {}, async () =>
			toResult(await redmineFetch(env, "GET", "/enumerations/issue_priorities.json")),
		);
		this.server.tool(
			"list_time_entry_activities",
			"List time-tracking activities (id + name).",
			{},
			async () => toResult(await redmineFetch(env, "GET", "/enumerations/time_entry_activities.json")),
		);
		this.server.tool("current_user", "Get the Redmine account tied to the configured API key.", {}, async () =>
			toResult(await redmineFetch(env, "GET", "/users/current.json")),
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp") as any,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
