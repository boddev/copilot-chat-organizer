# GitHub Copilot on github.com endpoints (unofficial)

There is **no public API** for listing or deleting your Copilot chats and agent tasks on
github.com. Everything below was mapped empirically (November 2026) by recording
`https://github.com/copilot` with `tools/discover.ts`. These are internal endpoints and
**can change without notice**. The organizer checks the shape of every response and stops
with an error instead of guessing.

All calls run as the signed-in user, inside a github.com page in the organizer's dedicated
Edge profile (`%LOCALAPPDATA%\copilot-chat-organizer\browser-profile`, shared with the
Microsoft 365 source). Code: `src/providers/ghweb/transport.ts` (page and token) and
`src/providers/ghweb/index.ts` (listing, transcripts, deletes).

## 1. Signing in and the API token

* The organizer opens `https://github.com/copilot` in a page named `ghweb`. It's signed in
  when the page has a non-empty `<meta name="user-login">`, the numeric user id in
  `<meta name="octolytics-actor-id">` (used as `creator_id` below) and a
  `<meta name="fetch-nonce">`. It's signed out on an empty `user-login` tag, a github.com
  sign-in path (`/login`, `/session`, `/sessions/...` including two-factor, `/signup`,
  `/join`, `/password_reset`, organization or enterprise SSO) or an external SSO page. In
  `auto` mode the organizer then reopens Edge as a visible window on
  `/login?return_to=/copilot` and waits up to five minutes.
* The API token comes from the page's own session cookie:

  ```http
  POST /copilot/agent-sessions/cmc-api-token
  accept: application/json
  content-type: application/json
  github-verified-fetch: true
  x-requested-with: XMLHttpRequest
  x-fetch-nonce: <content of meta[name=fetch-nonce]>
  ```

  sent with `credentials: include`. The response is `{"token": "...", "expiration": ...}`.
  The organizer accepts `expiration` as seconds or milliseconds since the epoch, or as a
  date string; anything else is treated as 10 minutes.
* The token is kept **in page memory only** (`window.__copilotChatOrganizerAgentsToken`)
  and refreshed when it has less than 2 minutes left. A 401 from the API clears it and
  retries once with a new token. Node never sees the token: every API call is a `fetch`
  that runs inside the page (`pageRequest`). If the token request itself fails, the
  organizer reloads github.com (signing in again if needed) and retries once.

## 2. Agents API

Base URL: `https://api.github.com/cmc_internal/api/agents/`. Every call sends:

```http
accept: application/json
copilot-integration-id: copilot-web
x-client-application: copilot-cloud-web
authorization: <the token, in the same scheme the github.com UI uses>
```

`apiUrl()` resolves every path against the base and refuses any URL outside it.
Pagination links go through `pageUrl()`, which maps the API's public path
(`https://api.github.com/agents/...`) onto the base before the same check. Calls that
return 429, 502, 503 or 504 are retried with backoff (honoring `Retry-After`), up to 4
attempts.

### List tasks and chats

```http
GET tasks?creator_id=<user id>&page=1&archived=<true|false>&per_page=250[&type=chat]
```

Response: `{"tasks": [TaskRecord, ...]}`. Pages are followed through the `Link` header's
`rel="next"` URL, up to 200 pages, stopping if a link repeats. The API writes that URL
against its public path (`https://api.github.com/agents/tasks?...`), so the organizer keeps
the query and calls it under the base.

The organizer walks four lists in parallel and merges them by `id`:

| Walk | Query | If it fails |
| --- | --- | --- |
| Tasks | `archived=false` | The refresh fails |
| Archived tasks | `archived=true` | Warning; the rest is shown |
| Chats | `archived=false&type=chat` | Warning; the rest is shown |
| Archived chats | `archived=true&type=chat` | Warning; the rest is shown |

`TaskRecord` fields the organizer uses:

```jsonc
{
  "id": "…",                      // task id
  "name": "…",                    // title
  "state": "completed",           // or "status"; also in_progress, queued, …
  "created_at": "…", "updated_at": "…",
  "archived_at": null,            // set when archived
  "repository": { "full_name": "owner/repo" },
  "agent_collaborators": [
    { "agent_id": 0, "agent_task_id": "…", "agent_type": "…", "slug": "copilot-developer-cli" }
  ],
  "session_count": 1
}
```

How items are classified:

* **Web chat**: listed by a `type=chat` walk.
* **App/CLI session copy** (`cli-task`): every `agent_collaborators[].slug` is
  `copilot-developer-cli`. The GitHub Copilot app and CLI sync sessions to github.com this
  way. If `agent_task_id` matches a folder in `~/.copilot/session-state`, the item is
  marked as the github.com copy of a session on this PC.
* **Coding agent task** (`agent-task`): everything else. Only these are reported as
  "still running" when `state` is `in_progress` or `queued`; synced app/CLI sessions often
  keep `in_progress` after they end.

Every item links to `https://github.com/copilot/tasks/<id>`.

### Read a task

```http
GET tasks/{id}
```

Returns the `TaskRecord` plus `sessions[]`:

```jsonc
{
  "sessions": [
    {
      "prompt": "…", "event_content": "…", "state": "completed",
      "head_ref": "copilot/fix-…", "resource_number": 123,
      "premium_requests": 1, "created_at": "…", "completed_at": "…"
    }
  ]
}
```

404 means the item no longer exists.

### Read the conversation

```http
GET tasks/{id}/events
```

Returns `{"events": [...], "total": <n>}`. A task with no history (seen on failed coding
agent tasks) returns `{"events": null, "total": 0}`, which the organizer reads as an empty
log. Logs can be tens of MB, so the page reads the response as a stream and filters it
before anything reaches Node:

* For the detail pane, it stops after 16 MB and keeps only the complete events at the start
  of the `events` array; the transcript is marked partial. The full view (and **Full**
  backups) read everything. Sessions run in Fusion (Auto) mode log thousands of
  `assistant.fusion_phase_activity` events, so their logs grow quickly; their replies are
  still ordinary `assistant.message` events.
* It returns `{total, count, bytes, truncated, kinds, events}`, where `kinds` counts the
  event kinds read (at most 60) so unrecognized logs can be diagnosed from the log file.

Two event formats appear:

1. **Copilot CLI/app format** (synced sessions, and assumed for coding agent tasks):
   `{type, timestamp, agentId, data}`. Only `user.message`, `assistant.message`, `abort`
   and `session.error` are kept, with the `data` fields the transcript needs. These are
   rendered by the same code as local app/CLI sessions (`src/providers/ghapp/events.ts`).
2. **github.com chat format**: `{ns: "ahp", at, payload: {data: {action: {type, ...}}}}`.
   Kept actions:

   | `action.type` | Fields used |
   | --- | --- |
   | `chat/turnStarted` | `startedAt`, `message.text`, `message.origin.kind` (`user` or another origin) |
   | `chat/responsePart` | `part.id`, `part.kind` (`markdown` or `text` only), `part.content` |
   | `chat/delta` | `partId`, `content`, appended to the matching response part |
   | `chat/turnCancel…`, `chat/turnAbort…`, `chat/turnFail…`, `chat/turnError…`, `chat/error…` | `error` (string or `{message}`) or `reason` |

The two lists are merged by time. If a task has no readable messages, the transcript is a
summary built from `sessions[]` (prompt, state, branch, PR or issue number, premium
requests), with a note:

* If the log holds only housekeeping events (`session.*`, `permission.*`, `hook.*`,
  `tool.*`, `commands.*`, `capabilities.*` and similar), the note says github.com has no
  messages for the conversation. This is common for github.com copies of app and CLI
  sessions.
* If the log has other event kinds, the events request returns 404, or the response isn't
  an event log, the note says the organizer couldn't read the history. The server log
  records the event kinds, or the response's structure (keys and value types, never its
  content).
* Other HTTP errors fail the request: they are usually temporary or need a new sign-in.

### Delete

```http
DELETE tasks/{id}
```

Permanent; github.com has no trash. The organizer deletes up to 3 items at a time. A 404
counts as success ("Already deleted on github.com").

## 3. Semantics and caveats

* github.com has no projects or folders, so the organizer groups these items with its local
  collections only.
* Deleting the github.com copy of an app/CLI session calls only the API above; the
  organizer doesn't touch the session on this PC. Delete that separately from the GitHub
  Copilot app & CLI tab.
* Archived items are listed (and deletable) like any other; their status shows
  `archived`.

Not yet verified:

* Whether the GitHub Copilot app or CLI reacts when the github.com copy of a session is
  deleted.
* The event format of coding agent tasks (assumed to be the CLI format).
* The exact names of the chat cancel and error actions (matched by pattern).
* Whether web chats have their own URL (they use the task URL).
* The maximum `per_page` (paging works either way).
