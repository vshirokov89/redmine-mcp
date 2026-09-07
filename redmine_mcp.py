# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mcp>=1.2.0",
#   "httpx>=0.27",
# ]
# ///
"""
Redmine MCP server.

A connector that exposes Redmine's REST API to Claude as MCP tools:
issues, time tracking, projects and reference data (statuses, trackers,
priorities, users).

Configuration via environment variables:
  REDMINE_URL      Base URL of the Redmine instance, e.g. https://redmine.example.com
  REDMINE_API_KEY  Your personal API access key (Redmine: My account -> API access key)
  REDMINE_VERIFY_SSL  Optional, "false" to skip TLS verification (self-signed certs). Default: true.

Run with uv (recommended, auto-installs deps):
  REDMINE_URL=... REDMINE_API_KEY=... uv run redmine_mcp.py
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP

REDMINE_URL = os.environ.get("REDMINE_URL", "").rstrip("/")
REDMINE_API_KEY = os.environ.get("REDMINE_API_KEY", "")
VERIFY_SSL = os.environ.get("REDMINE_VERIFY_SSL", "true").lower() not in ("false", "0", "no")

mcp = FastMCP("redmine")


def _client() -> httpx.Client:
    if not REDMINE_URL:
        raise RuntimeError("REDMINE_URL is not set")
    if not REDMINE_API_KEY:
        raise RuntimeError("REDMINE_API_KEY is not set")
    return httpx.Client(
        base_url=REDMINE_URL,
        headers={
            "X-Redmine-API-Key": REDMINE_API_KEY,
            "Content-Type": "application/json",
        },
        timeout=30.0,
        verify=VERIFY_SSL,
    )


def _request(method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> Any:
    with _client() as client:
        resp = client.request(method, path, params=params, json=json)
        if resp.status_code >= 400:
            # Surface Redmine's validation errors, which are useful to the caller.
            detail = resp.text
            try:
                body = resp.json()
                if isinstance(body, dict) and "errors" in body:
                    detail = "; ".join(body["errors"])
            except Exception:
                pass
            raise RuntimeError(f"Redmine API {method} {path} -> {resp.status_code}: {detail}")
        if resp.status_code == 204 or not resp.content:
            return {"ok": True}
        return resp.json()


def _clean(d: dict) -> dict:
    """Drop None values so we only send fields the caller actually provided."""
    return {k: v for k, v in d.items() if v is not None}


# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------

@mcp.tool()
def list_issues(
    project_id: Optional[str] = None,
    status_id: Optional[str] = None,
    assigned_to_id: Optional[str] = None,
    tracker_id: Optional[int] = None,
    query: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
) -> Any:
    """Search Redmine issues with optional filters.

    Args:
        project_id: Project identifier or numeric id to filter by.
        status_id: Status filter. Use a status id, "open", "closed", or "*" for all. Default is open only.
        assigned_to_id: User id to filter by assignee. Use "me" for the current user.
        tracker_id: Tracker (issue type) id.
        query: Free-text search across subject/description.
        limit: Max issues to return (1-100).
        offset: Pagination offset.
    """
    params = _clean({
        "project_id": project_id,
        "status_id": status_id,
        "assigned_to_id": assigned_to_id,
        "tracker_id": tracker_id,
        "limit": max(1, min(limit, 100)),
        "offset": offset,
    })
    if query:
        # Redmine supports full-text search via the search API; use the issues
        # filter subject when a simple contains match is enough.
        params["subject"] = f"~{query}"
    return _request("GET", "/issues.json", params=params)


@mcp.tool()
def get_issue(issue_id: int, include: Optional[str] = "journals,attachments,relations,children") -> Any:
    """Get a single issue with full detail.

    Args:
        issue_id: Numeric issue id.
        include: Comma-separated extra data to include (journals=comments, attachments, relations, children, watchers).
    """
    return _request("GET", f"/issues/{issue_id}.json", params=_clean({"include": include}))


@mcp.tool()
def create_issue(
    project_id: str,
    subject: str,
    description: Optional[str] = None,
    tracker_id: Optional[int] = None,
    status_id: Optional[int] = None,
    priority_id: Optional[int] = None,
    assigned_to_id: Optional[int] = None,
    parent_issue_id: Optional[int] = None,
    fixed_version_id: Optional[int] = None,
) -> Any:
    """Create a new Redmine issue.

    Args:
        project_id: Project identifier or numeric id (required).
        subject: Issue title (required).
        description: Issue body text.
        tracker_id: Tracker/type id (see list_trackers).
        status_id: Initial status id (see list_statuses).
        priority_id: Priority id (see list_priorities).
        assigned_to_id: Assignee user id.
        parent_issue_id: Parent issue id, to create a subtask.
        fixed_version_id: Target version/milestone id.
    """
    issue = _clean({
        "project_id": project_id,
        "subject": subject,
        "description": description,
        "tracker_id": tracker_id,
        "status_id": status_id,
        "priority_id": priority_id,
        "assigned_to_id": assigned_to_id,
        "parent_issue_id": parent_issue_id,
        "fixed_version_id": fixed_version_id,
    })
    return _request("POST", "/issues.json", json={"issue": issue})


@mcp.tool()
def update_issue(
    issue_id: int,
    subject: Optional[str] = None,
    description: Optional[str] = None,
    status_id: Optional[int] = None,
    priority_id: Optional[int] = None,
    assigned_to_id: Optional[int] = None,
    done_ratio: Optional[int] = None,
    notes: Optional[str] = None,
    private_notes: bool = False,
) -> Any:
    """Update an issue and/or add a comment (note).

    Args:
        issue_id: Numeric issue id (required).
        subject: New title.
        description: New description body.
        status_id: New status id.
        priority_id: New priority id.
        assigned_to_id: New assignee user id.
        done_ratio: Percent done, 0-100.
        notes: A comment/journal note to add to the issue.
        private_notes: If true, the note is marked as private.
    """
    issue = _clean({
        "subject": subject,
        "description": description,
        "status_id": status_id,
        "priority_id": priority_id,
        "assigned_to_id": assigned_to_id,
        "done_ratio": done_ratio,
        "notes": notes,
    })
    if notes and private_notes:
        issue["private_notes"] = True
    if not issue:
        raise RuntimeError("Nothing to update: provide at least one field or a note.")
    return _request("PUT", f"/issues/{issue_id}.json", json={"issue": issue})


@mcp.tool()
def add_issue_comment(issue_id: int, notes: str, private_notes: bool = False) -> Any:
    """Add a comment (journal note) to an issue without changing other fields.

    Args:
        issue_id: Numeric issue id.
        notes: The comment text.
        private_notes: If true, mark the comment as private.
    """
    return update_issue(issue_id=issue_id, notes=notes, private_notes=private_notes)


# ---------------------------------------------------------------------------
# Time tracking
# ---------------------------------------------------------------------------

@mcp.tool()
def list_time_entries(
    issue_id: Optional[int] = None,
    project_id: Optional[str] = None,
    user_id: Optional[str] = None,
    spent_on: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
) -> Any:
    """List time entries with optional filters.

    Args:
        issue_id: Filter by issue.
        project_id: Filter by project identifier or id.
        user_id: Filter by user id, or "me" for the current user.
        spent_on: Exact date (YYYY-MM-DD).
        from_date: Range start date (YYYY-MM-DD), used as ">=".
        to_date: Range end date (YYYY-MM-DD), used as "<=".
        limit: Max entries (1-100).
        offset: Pagination offset.
    """
    params = _clean({
        "issue_id": issue_id,
        "project_id": project_id,
        "user_id": user_id,
        "spent_on": spent_on,
        "limit": max(1, min(limit, 100)),
        "offset": offset,
    })
    if from_date and to_date:
        params["from"] = from_date
        params["to"] = to_date
    return _request("GET", "/time_entries.json", params=params)


@mcp.tool()
def create_time_entry(
    hours: float,
    issue_id: Optional[int] = None,
    project_id: Optional[str] = None,
    spent_on: Optional[str] = None,
    activity_id: Optional[int] = None,
    comments: Optional[str] = None,
) -> Any:
    """Log time against an issue or a project.

    One of issue_id or project_id must be provided.

    Args:
        hours: Number of hours spent (required).
        issue_id: Issue to log against.
        project_id: Project to log against (if not tied to a specific issue).
        spent_on: Date of the work (YYYY-MM-DD). Defaults to today on the server.
        activity_id: Time-tracking activity id (see list_time_entry_activities).
        comments: Short description of the work.
    """
    if not issue_id and not project_id:
        raise RuntimeError("Provide either issue_id or project_id for the time entry.")
    entry = _clean({
        "hours": hours,
        "issue_id": issue_id,
        "project_id": project_id,
        "spent_on": spent_on,
        "activity_id": activity_id,
        "comments": comments,
    })
    return _request("POST", "/time_entries.json", json={"time_entry": entry})


# ---------------------------------------------------------------------------
# Projects and reference data
# ---------------------------------------------------------------------------

@mcp.tool()
def list_projects(limit: int = 100, offset: int = 0) -> Any:
    """List projects visible to the current user.

    Args:
        limit: Max projects (1-100).
        offset: Pagination offset.
    """
    params = {"limit": max(1, min(limit, 100)), "offset": offset}
    return _request("GET", "/projects.json", params=params)


@mcp.tool()
def get_project(project_id: str, include: Optional[str] = "trackers,issue_categories") -> Any:
    """Get one project with detail.

    Args:
        project_id: Project identifier or numeric id.
        include: Comma-separated extras (trackers, issue_categories, enabled_modules, time_entry_activities).
    """
    return _request("GET", f"/projects/{project_id}.json", params=_clean({"include": include}))


@mcp.tool()
def list_statuses() -> Any:
    """List all issue statuses (id + name)."""
    return _request("GET", "/issue_statuses.json")


@mcp.tool()
def list_trackers() -> Any:
    """List all trackers / issue types (id + name)."""
    return _request("GET", "/trackers.json")


@mcp.tool()
def list_priorities() -> Any:
    """List issue priority values (id + name)."""
    return _request("GET", "/enumerations/issue_priorities.json")


@mcp.tool()
def list_time_entry_activities() -> Any:
    """List time-tracking activities (id + name), used when logging time."""
    return _request("GET", "/enumerations/time_entry_activities.json")


@mcp.tool()
def list_users(
    name: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
) -> Any:
    """List users (requires admin rights on most Redmine instances).

    Args:
        name: Filter by a name/login substring.
        project_id: Restrict to members of a project.
        limit: Max users (1-100).
        offset: Pagination offset.
    """
    params = _clean({
        "name": name,
        "project_id": project_id,
        "limit": max(1, min(limit, 100)),
        "offset": offset,
    })
    return _request("GET", "/users.json", params=params)


@mcp.tool()
def current_user() -> Any:
    """Get the account tied to the configured API key (id, name, login)."""
    return _request("GET", "/users/current.json")


if __name__ == "__main__":
    mcp.run()
