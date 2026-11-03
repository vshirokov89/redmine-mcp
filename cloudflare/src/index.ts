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
 * GitHub usernames allowed to use this connector, read from the
 * ALLOWED_GITHUB_USERNAMES var (comma-separated) in wrangler.jsonc. Anyone else
 * can authenticate but gets no Redmine tools. Falls back to "vshirokov89" if the
 * var is unset. Comparison is case-insensitive.
 */
function allowedUsernames(env: Env): Set<string> {
	const raw = env.ALLOWED_GITHUB_USERNAMES ?? "vshirokov89";
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

function isAllowed(env: Env, login: string): boolean {
	return allowedUsernames(env).has(login.toLowerCase());
}

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

/**
 * Custom field values for an issue: [{ id, value }]. `value` is a string, or an
 * array of strings for multi-value fields. Look up field ids with list_custom_fields.
 */
const CUSTOM_FIELDS_SCHEMA = z
	.array(z.object({ id: z.number(), value: z.union([z.string(), z.array(z.string())]) }))
	.optional()
	.describe("Custom field values: [{id, value}]; value is a string, or array of strings for multi-value fields");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Upload raw file bytes to Redmine (POST /uploads.json). Returns the upload token
 * in data.upload.token on success (201).
 */
async function redmineUpload(env: Env, filename: string, body: Uint8Array): Promise<RedmineResponse> {
	const url = new URL("/uploads.json", env.REDMINE_URL);
	url.searchParams.set("filename", filename);
	const resp = await fetch(url.toString(), {
		method: "POST",
		headers: { "X-Redmine-API-Key": env.REDMINE_API_KEY, "Content-Type": "application/octet-stream" },
		body,
	});
	const text = await resp.text();
	let data: unknown = text;
	try {
		data = text ? JSON.parse(text) : { ok: true };
	} catch {
		/* keep raw */
	}
	return { status: resp.status, data };
}

/** Decode base64 (tolerating a leading data: URL prefix) to bytes. */
function base64ToBytes(b64: string): Uint8Array {
	const raw = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
	const bin = atob(raw.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
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
				const allowed = isAllowed(env, this.props!.login);
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

		if (!isAllowed(env, this.props!.login)) return;

		// ----- Issues -----
		this.server.tool(
			"list_issues",
			"Search Redmine issues. Defaults to open issues; pass status_id='*' for all or 'closed' for closed.",
			{
				project_id: z.string().optional().describe("Project identifier or numeric id"),
				subproject_id: z.string().optional().describe("Subproject filter; '!*' excludes subprojects"),
				status_id: z.string().optional().describe("Status id, or 'open' | 'closed' | '*'"),
				assigned_to_id: z.string().optional().describe("Assignee user id, or 'me'"),
				author_id: z.string().optional().describe("Author user id, or 'me'"),
				tracker_id: z.number().optional(),
				priority_id: z.number().optional(),
				parent_id: z.number().optional().describe("Return subtasks of this issue"),
				issue_id: z.string().optional().describe("One id or a comma-separated list of ids"),
				subject: z.string().optional().describe("Substring match on the subject"),
				created_on: z.string().optional().describe("Operator filter, e.g. '>=2026-01-01' or '><2026-01-01|2026-02-01'"),
				updated_on: z.string().optional().describe("Operator filter, same format as created_on"),
				include: z.string().optional().describe("Comma list: attachments, relations"),
				sort: z.string().optional().describe("e.g. 'updated_on:desc'"),
				limit: z.number().min(1).max(100).default(25),
				offset: z.number().min(0).default(0),
			},
			async (a) => {
				const params = clean({
					project_id: a.project_id,
					subproject_id: a.subproject_id,
					status_id: a.status_id ?? "open",
					assigned_to_id: a.assigned_to_id,
					author_id: a.author_id,
					tracker_id: a.tracker_id,
					priority_id: a.priority_id,
					parent_id: a.parent_id,
					issue_id: a.issue_id,
					subject: a.subject ? `~${a.subject}` : undefined,
					created_on: a.created_on,
					updated_on: a.updated_on,
					include: a.include,
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
					.describe("Comma list: journals, attachments, relations, children, watchers, changesets, allowed_statuses"),
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
				category_id: z.number().optional(),
				parent_issue_id: z.number().optional(),
				fixed_version_id: z.number().optional().describe("Target version/milestone id"),
				start_date: z.string().optional().describe("YYYY-MM-DD"),
				due_date: z.string().optional().describe("YYYY-MM-DD"),
				estimated_hours: z.number().optional(),
				done_ratio: z.number().min(0).max(100).optional(),
				is_private: z.boolean().optional(),
				watcher_user_ids: z.array(z.number()).optional().describe("User ids to add as watchers"),
				custom_fields: CUSTOM_FIELDS_SCHEMA,
			},
			async (a) => {
				const issue = clean({
					project_id: a.project_id,
					subject: a.subject,
					description: a.description,
					tracker_id: a.tracker_id,
					status_id: a.status_id,
					priority_id: a.priority_id,
					custom_fields: a.custom_fields,
					assigned_to_id: a.assigned_to_id,
					category_id: a.category_id,
					parent_issue_id: a.parent_issue_id,
					fixed_version_id: a.fixed_version_id,
					start_date: a.start_date,
					due_date: a.due_date,
					estimated_hours: a.estimated_hours,
					done_ratio: a.done_ratio,
					is_private: a.is_private,
					watcher_user_ids: a.watcher_user_ids,
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
				project_id: z.string().optional().describe("Move the issue to another project (id or identifier)"),
				tracker_id: z.number().optional(),
				status_id: z.number().optional(),
				priority_id: z.number().optional(),
				assigned_to_id: z.number().optional(),
				category_id: z.number().optional(),
				fixed_version_id: z.number().optional(),
				parent_issue_id: z.number().optional(),
				start_date: z.string().optional().describe("YYYY-MM-DD"),
				due_date: z.string().optional().describe("YYYY-MM-DD"),
				estimated_hours: z.number().optional(),
				done_ratio: z.number().min(0).max(100).optional(),
				is_private: z.boolean().optional(),
				custom_fields: CUSTOM_FIELDS_SCHEMA,
				notes: z.string().optional(),
				private_notes: z.boolean().optional(),
			},
			async (a) => {
				const issue = clean({
					subject: a.subject,
					description: a.description,
					project_id: a.project_id,
					tracker_id: a.tracker_id,
					status_id: a.status_id,
					custom_fields: a.custom_fields,
					priority_id: a.priority_id,
					assigned_to_id: a.assigned_to_id,
					category_id: a.category_id,
					fixed_version_id: a.fixed_version_id,
					parent_issue_id: a.parent_issue_id,
					start_date: a.start_date,
					due_date: a.due_date,
					estimated_hours: a.estimated_hours,
					done_ratio: a.done_ratio,
					is_private: a.is_private,
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

		this.server.tool(
			"delete_issue",
			"DANGER: permanently delete an issue (and its subtasks). Irreversible.",
			{
				issue_id: z.number(),
				confirm: z.boolean().describe("Must be true to proceed — guards against accidental deletion."),
			},
			async (a) => {
				if (!a.confirm) {
					return {
						content: [{ type: "text", text: "Deletion not confirmed. Pass confirm=true to delete this issue." }],
						isError: true,
					};
				}
				const r = await redmineFetch(env, "DELETE", `/issues/${a.issue_id}.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Issue #${a.issue_id} deleted.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"add_issue_watcher",
			"Add a user as a watcher of an issue.",
			{ issue_id: z.number(), user_id: z.number() },
			async (a) => {
				const r = await redmineFetch(env, "POST", `/issues/${a.issue_id}/watchers.json`, {
					body: { user_id: a.user_id },
				});
				if (r.status === 204 || r.status === 200 || r.status === 201)
					return { content: [{ type: "text", text: `User ${a.user_id} now watches #${a.issue_id}.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"remove_issue_watcher",
			"Remove a watcher from an issue.",
			{ issue_id: z.number(), user_id: z.number() },
			async (a) => {
				const r = await redmineFetch(env, "DELETE", `/issues/${a.issue_id}/watchers/${a.user_id}.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `User ${a.user_id} no longer watches #${a.issue_id}.` }] };
				return toResult(r);
			},
		);

		// ----- Attachments -----
		this.server.tool(
			"get_attachment",
			"Get an attachment's metadata (filename, filesize, content_type, author, content_url).",
			{ attachment_id: z.number() },
			async (a) => toResult(await redmineFetch(env, "GET", `/attachments/${a.attachment_id}.json`)),
		);

		this.server.tool(
			"download_attachment",
			"Read an attachment's content. Returns text for text files; for binary files returns metadata and the content_url (binary is not returned inline).",
			{
				attachment_id: z.number(),
				max_bytes: z
					.number()
					.min(1)
					.max(1048576)
					.default(262144)
					.describe("Max bytes of text to return (default 256 KiB)"),
			},
			async (a) => {
				const meta = await redmineFetch(env, "GET", `/attachments/${a.attachment_id}.json`);
				if (meta.status >= 400) return toResult(meta);
				const att = (meta.data as {
					attachment?: { content_url?: string; content_type?: string; filename?: string; filesize?: number };
				}).attachment;
				if (!att?.content_url)
					return { content: [{ type: "text", text: "Attachment has no content_url." }], isError: true };
				const ct = att.content_type ?? "";
				const isText = /^text\/|json|xml|csv|javascript|yaml|x-sh|html/i.test(ct);
				if (!isText) {
					return {
						content: [
							{
								type: "text",
								text: `Binary attachment "${att.filename}" (${ct}, ${att.filesize} bytes). Download URL: ${att.content_url}`,
							},
						],
					};
				}
				const resp = await fetch(att.content_url, { headers: { "X-Redmine-API-Key": env.REDMINE_API_KEY } });
				if (!resp.ok)
					return {
						content: [{ type: "text", text: `Failed to download (HTTP ${resp.status}). URL: ${att.content_url}` }],
						isError: true,
					};
				const buf = new Uint8Array(await resp.arrayBuffer());
				const slice = buf.subarray(0, a.max_bytes);
				const body = new TextDecoder().decode(slice);
				const note = buf.length > slice.length ? `\n…(truncated, ${buf.length} bytes total)` : "";
				return { content: [{ type: "text", text: `${att.filename} (${ct}):\n\n${body}${note}` }] };
			},
		);

		this.server.tool(
			"attach_file_to_issue",
			"Attach a file to an existing issue. Provide the file as a URL to fetch, base64 bytes, or plain text. Uploads it then links it to the issue.",
			{
				issue_id: z.number(),
				filename: z.string().describe("Name the file will have on the issue"),
				url: z.string().optional().describe("http(s) URL to fetch the file from"),
				content_base64: z.string().optional().describe("Base64-encoded bytes (a data: URL is also accepted)"),
				text_content: z.string().optional().describe("Plain-text content, for text attachments"),
				content_type: z.string().optional().describe("MIME type; optional, Redmine can detect it"),
				description: z.string().optional(),
			},
			async (a) => {
				let bytes: Uint8Array;
				let ctype = a.content_type;
				try {
					if (a.url) {
						if (!/^https?:\/\//i.test(a.url))
							return { content: [{ type: "text", text: "url must start with http:// or https://" }], isError: true };
						const r = await fetch(a.url);
						if (!r.ok)
							return { content: [{ type: "text", text: `Failed to fetch url (HTTP ${r.status}).` }], isError: true };
						bytes = new Uint8Array(await r.arrayBuffer());
						ctype = ctype ?? r.headers.get("content-type") ?? undefined;
					} else if (a.content_base64) {
						bytes = base64ToBytes(a.content_base64);
					} else if (a.text_content !== undefined) {
						bytes = new TextEncoder().encode(a.text_content);
						ctype = ctype ?? "text/plain";
					} else {
						return {
							content: [{ type: "text", text: "Provide one of: url, content_base64, text_content." }],
							isError: true,
						};
					}
				} catch (e) {
					return { content: [{ type: "text", text: `Could not read file content: ${String(e)}` }], isError: true };
				}
				if (bytes.byteLength === 0)
					return { content: [{ type: "text", text: "File is empty." }], isError: true };
				if (bytes.byteLength > MAX_UPLOAD_BYTES)
					return {
						content: [
							{ type: "text", text: `File too large (${bytes.byteLength} bytes; limit ${MAX_UPLOAD_BYTES}).` },
						],
						isError: true,
					};

				const up = await redmineUpload(env, a.filename, bytes);
				if (up.status >= 400) return toResult(up);
				const token = (up.data as { upload?: { token?: string } }).upload?.token;
				if (!token)
					return { content: [{ type: "text", text: `Upload returned no token (HTTP ${up.status}).` }], isError: true };

				const upload = clean({ token, filename: a.filename, content_type: ctype, description: a.description });
				const r = await redmineFetch(env, "PUT", `/issues/${a.issue_id}.json`, {
					body: { issue: { uploads: [upload] } },
				});
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Attached "${a.filename}" to issue #${a.issue_id}.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"delete_attachment",
			"DANGER: permanently delete an attachment. Irreversible.",
			{
				attachment_id: z.number(),
				confirm: z.boolean().describe("Must be true to proceed — guards against accidental deletion."),
			},
			async (a) => {
				if (!a.confirm)
					return {
						content: [{ type: "text", text: "Deletion not confirmed. Pass confirm=true to delete this attachment." }],
						isError: true,
					};
				const r = await redmineFetch(env, "DELETE", `/attachments/${a.attachment_id}.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Attachment ${a.attachment_id} deleted.` }] };
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

		// ----- Projects -----
		const PROJECT_INCLUDE =
			"Comma list: trackers, issue_categories, enabled_modules, time_entry_activities, issue_custom_fields";

		this.server.tool(
			"list_projects",
			"List projects visible to the account.",
			{
				include: z.string().optional().describe(PROJECT_INCLUDE),
				limit: z.number().min(1).max(100).default(100),
				offset: z.number().min(0).default(0),
			},
			async (a) =>
				toResult(
					await redmineFetch(env, "GET", "/projects.json", {
						params: clean({ include: a.include, limit: a.limit, offset: a.offset }),
					}),
				),
		);

		this.server.tool(
			"get_project",
			"Get one project by numeric id or identifier.",
			{
				project_id: z.string().describe("Numeric id or identifier, e.g. 'website'"),
				include: z.string().optional().describe(PROJECT_INCLUDE),
			},
			async (a) =>
				toResult(
					await redmineFetch(env, "GET", `/projects/${a.project_id}.json`, {
						params: clean({ include: a.include ?? "trackers,issue_categories,enabled_modules" }),
					}),
				),
		);

		this.server.tool(
			"create_project",
			"Create a project. Requires project-admin rights in Redmine.",
			{
				name: z.string(),
				identifier: z
					.string()
					.describe("Unique url-safe identifier, 1-100 chars: lowercase letters, digits, - and _"),
				description: z.string().optional(),
				homepage: z.string().optional(),
				is_public: z.boolean().optional(),
				parent_id: z.number().optional().describe("Parent project id, to create a subproject"),
				inherit_members: z.boolean().optional(),
				tracker_ids: z.array(z.number()).optional(),
				enabled_module_names: z
					.array(z.string())
					.optional()
					.describe("e.g. issue_tracking, time_tracking, wiki, repository, boards, news, files, gantt, calendar, documents"),
			},
			async (a) => {
				const project = clean({
					name: a.name,
					identifier: a.identifier,
					description: a.description,
					homepage: a.homepage,
					is_public: a.is_public,
					parent_id: a.parent_id,
					inherit_members: a.inherit_members,
					tracker_ids: a.tracker_ids,
					enabled_module_names: a.enabled_module_names,
				});
				return toResult(await redmineFetch(env, "POST", "/projects.json", { body: { project } }));
			},
		);

		this.server.tool(
			"update_project",
			"Update a project's fields. Requires project-admin rights in Redmine.",
			{
				project_id: z.string().describe("Numeric id or identifier"),
				name: z.string().optional(),
				description: z.string().optional(),
				homepage: z.string().optional(),
				is_public: z.boolean().optional(),
				parent_id: z.number().optional(),
				inherit_members: z.boolean().optional(),
				tracker_ids: z.array(z.number()).optional(),
				enabled_module_names: z.array(z.string()).optional(),
			},
			async (a) => {
				const project = clean({
					name: a.name,
					description: a.description,
					homepage: a.homepage,
					is_public: a.is_public,
					parent_id: a.parent_id,
					inherit_members: a.inherit_members,
					tracker_ids: a.tracker_ids,
					enabled_module_names: a.enabled_module_names,
				});
				if (Object.keys(project).length === 0) {
					return { content: [{ type: "text", text: "Nothing to update: provide at least one field." }], isError: true };
				}
				const r = await redmineFetch(env, "PUT", `/projects/${a.project_id}.json`, { body: { project } });
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Project ${a.project_id} updated.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"archive_project",
			"Archive a project (hides it; reversible with unarchive_project). Redmine 5.0+.",
			{ project_id: z.string().describe("Numeric id or identifier") },
			async (a) => {
				const r = await redmineFetch(env, "PUT", `/projects/${a.project_id}/archive.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Project ${a.project_id} archived.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"unarchive_project",
			"Unarchive (restore) a previously archived project. Redmine 5.0+.",
			{ project_id: z.string().describe("Numeric id or identifier") },
			async (a) => {
				const r = await redmineFetch(env, "PUT", `/projects/${a.project_id}/unarchive.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Project ${a.project_id} unarchived.` }] };
				return toResult(r);
			},
		);

		this.server.tool(
			"delete_project",
			"DANGER: permanently delete a project AND all of its issues, wiki, time entries and subprojects. Irreversible. Requires project-admin rights.",
			{
				project_id: z.string().describe("Numeric id or identifier"),
				confirm: z
					.boolean()
					.describe("Must be true to proceed — guards against accidental deletion."),
			},
			async (a) => {
				if (!a.confirm) {
					return {
						content: [{ type: "text", text: "Deletion not confirmed. Pass confirm=true to delete this project." }],
						isError: true,
					};
				}
				const r = await redmineFetch(env, "DELETE", `/projects/${a.project_id}.json`);
				if (r.status === 204 || r.status === 200)
					return { content: [{ type: "text", text: `Project ${a.project_id} deleted.` }] };
				return toResult(r);
			},
		);

		// ----- Reference data -----

		this.server.tool("list_statuses", "List issue statuses (id, name, is_closed).", {}, async () =>
			toResult(await redmineFetch(env, "GET", "/issue_statuses.json")),
		);
		this.server.tool(
			"list_custom_fields",
			"List custom field definitions (id, name, field_format, possible_values, ...). Requires admin rights in Redmine. Use to find field ids/formats for the custom_fields argument of create_issue/update_issue.",
			{},
			async () => toResult(await redmineFetch(env, "GET", "/custom_fields.json")),
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
