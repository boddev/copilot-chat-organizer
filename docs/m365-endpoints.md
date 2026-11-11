# Microsoft 365 Copilot / Cowork endpoints (unofficial)

There is **no public API** for managing M365 Copilot chat history, Cowork tasks or
Projects. Everything below was mapped empirically (November 2026) by recording the
Copilot web app (`https://copilot.cloud.microsoft`) with `tools/discover.ts`. These are
internal endpoints and **can change without notice**. The organizer detects most
breaking changes (unknown hash, 4xx) and stops instead of guessing.

All calls run as the signed-in user, through a dedicated Edge profile driven by
Playwright (`%LOCALAPPDATA%\copilot-chat-organizer\browser-profile`). The github.com source
shares that profile and browser; see [ghweb-endpoints.md](ghweb-endpoints.md).

## 1. Copilot web app server functions (`_serverFn`)

The web app is a TanStack Start app. Most chat-history operations go through a single
server-function dispatcher, authenticated by the page's cookies, so calls are made with
`fetch()` **inside the page** (`page.evaluate`).

```
POST https://copilot.cloud.microsoft/_serverFn/<dispatcherHash>
x-tsr-serverfn: true
content-type: application/json
accept: application/x-tss-framed, application/x-ndjson, application/json

{"t": <seroval-encoded {data: {...}}>, "f": 127, "m": []}
```

* `<dispatcherHash>` was `73e9366c…e54268`. It changes with deployments, so the client
  learns it at runtime from the first POST whose decoded body contains `data.action`.
* Bodies/responses use the [seroval](https://github.com/lxsmnsyc/seroval) JSON node
  format; `src/lib/seroval.ts` encodes/decodes it. Responses decode to
  `{result: {store | result, meta}}`.
* The `state` argument is the client's current store. The server only uses it to return
  updated copies of lists, so `{}` (or an empty list) is enough.

| Action | Arguments | Result |
| --- | --- | --- |
| `GetConversationPageHistoryList` | `syncState`, `enableLastMessage: true`, `saveToStore: "chatLandingPageHistoryList"`, `state: {chatLandingPageHistoryList: {chats: [], syncState}}` | `store.chatLandingPageHistoryList {chats[], syncState, metrics}` |
| `RefreshNavPane` | `conversationHistoryFilter: null`, `skipNotebooks: true`, `skipAgentListCache: false`, `preservePinnedChats: false`, `enableLastMessage: false`, `state: {}` | `store.conversationPageHistoryList` (32 newest), `taskConversationPageHistoryList` (~72 newest), `pinnedChatIds`, … |
| `DeleteConversation` | `conversationId`, `state: {}` | `store.lastConversationActionMetrics {statusCode, conversationCount}` |
| `GetNavProjectChats` | `projectId` | `result {tasks[], copilotChats[{threadId, conversationId, title, createdAt, lastActivity}], isComplete}` |
| `GetCoworkTaskHistoryList` | `syncState: ""`, `state: {chatLandingPageCoworkTaskList: {items: [], syncState: ""}}` | Cowork items, 50/page (Aether `/v1/tasks/live` is used instead) |
| `GetMoreTasks` | `cursor: ""`, `filter: {conversationId}`, `storeKey: "pendingDeleteTasks"`, `state: {}` | Tasks that will be deleted together with a chat |

### Chat history paging

* `syncState` is base64 JSON `{IC3SyncState: base64 JSON {deliveredSegments: [{start, end}],
  zeroLMSTDeliveredSegments, sortOrder, includeZeroLMST}}`.
* Start from `RefreshNavPane` (fresh), then call `GetConversationPageHistoryList` with the
  previous `syncState`. Each call returns ~18 *older* chats and moves
  `deliveredSegments[0].start` backwards.
* **End condition:** the segment start becomes `1970-01-01T00:00:00` and the following
  call returns 0 chats. A full listing of ~1,100 chats is ~62 calls / ~30 s.
* **Server-side caching:** calls with `enableLastMessage: false`, and calls with an
  empty `syncState`, are served from a per-user cache for several minutes (identical
  `metrics.responseTraceId`, ~12 ms TTFB). They can return chats that were just deleted
  and collide with `RefreshNavPane`'s cached lists. Always page with
  `enableLastMessage: true`, and keep local tombstones for recently deleted ids.
* Chat fields: `conversationId`, `chatName`, `tone` (Magic/Chat/DeepWork),
  `createTimeUtc`, `updateTimeUtc` (0 for some), `threadId` (IC3 `19:…@thread.v2`),
  `isUnread`, `hasCopilotTasks`, `turnState`, `path`, `plugins`, `retentionPolicyEffect`,
  `preview`. **There is no project field** — membership comes from `GetNavProjectChats`.
* `preview` is about the first 200 characters of the newest message. For agents that build
  files, that's a JSON payload cut off part-way, so the list describes it instead, the
  same way as the transcript (`chatPreview`).

### Chat content

```
GET https://copilot.cloud.microsoft/chat/conversation/<conversationId>?direction=Backward
x-streaming: true
accept: application/x-ndjson,application/json
```

NDJSON: line 1 is `{messages[], syncState, chatName, createTimeUtc, updateTimeUtc, tone,
conversationSensitivityLabel, …}` with the newest ~20 messages. Longer chats continue with
more `{messages[]}` lines holding older messages (one 4.7 MB response had 18 lines), then
`{isLastPage: true|false}`. Read every line: the first alone can miss half a chat,
including its first prompts.

Messages have `author` (`user`/`bot`/`system`/`tool`/`BotOnBehalfOfUser`), `text`,
`createdAt`, `messageId`, `messageType`, `contentOrigin` and often `adaptiveCards`. About
half of the bot replies have no `text`; their answer is only in the cards' TextBlocks. When
both exist, prefer `text`. Message types seen:

| `messageType` | Content | Shown as |
| --- | --- | --- |
| (none) | The prompt or the answer | user / assistant |
| `Progress` | Intermediate status or reasoning | status |
| `GeneratedCode` | Fenced code that Copilot ran | tool |
| `AttachmentAction` (author `system`) | Markdown link to an attached file | system |
| `Internal` | Search-result bookkeeping as JSON | skipped |
| `EndOfRequest` | Empty marker | skipped |

A `BotOnBehalfOfUser` message is a prompt sent on the user's behalf; it's shown as user.
Author `tool` messages (for example `InternalContentDescription`, the prompt of a generated
image) are shown as tool.

Agents that build PowerPoint and Word files post machine payloads with no `messageType`;
`contentOrigin` tells them apart:

| `contentOrigin` | Content | Shown as |
| --- | --- | --- |
| `ChainOfThoughtContentOrigin` | `headerText: …\nsubText: …` progress steps (often 100+ messages per chat), sometimes with `interstitialText: …` notes such as web searches. Each message usually repeats the earlier steps and adds one | status, without the labels; only the last message of such a run is shown |
| `SlideHTMLGenerationContentOrigin`, `InterimSlideHTMLGenerationContentOrigin` | `{fileName, html}` for one slide | tool, "Generated <file>" |
| `ConfigurationGenerationContentOrigin` | `{fileName: "presentationConfig.json", configurationJSON}` | tool, "Generated <file>" |
| `ConfigurationResultMessageGenerationContentOrigin` | `{fileName: "resultMessage.txt", configurationJSON: "<reply>"}` | assistant, the reply |
| `DocumentGenerationSuccess` | `{fileType, fileName, fileId, driveId, shareableLink, …}` | tool, "Created <file>" + link |
| `LuminaTerminalToolHandler` (`Progress`) | `{stdIn, stdOut, stderr, callId, sessionName}` | tool, command + output |
| `TodoListContentOrigin` (`Progress`) | `[{content, status, activeForm}]` | status, a checklist |
| `DeepLeo`, `EditorialAnswersResponseHandler` | Sometimes an empty `<m-workflow-…-card>` element | skipped when empty |

Other bot JSON is shown as is, as tool. Some agents (such as HR agents) wrap a disclaimer in
`<m-disclaimer>…</m-disclaimer>`, which the Copilot app shows as a note; the tags are dropped
from replies and list previews, and the disclaimer text is kept. Transcripts are shown in the
details pane and saved in pre-delete backups; backups keep the original messages.

## 2. Cowork / Projects REST API ("Aether")

* Base URL is per-tenant (`https://mcsaetherruntime-cus.us-ia302.gateway.prod.island.powerapps.com`
  for Microsoft) and is learned from the page's own traffic.
* `authorization: Bearer <token>` — audience `6ab48b67-cd74-4ad4-81af-5932984589be`,
  scope `access_as_user`, ~1 h lifetime. Taken from the page's own requests; refreshed by
  reloading the page.
* Also send `x-user-id: <oid>`, `x-tenant-id: <tid>`, `x-request-id: <uuid>`,
  `accept`/`content-type: application/json`. Calls work from Node `fetch`.
* **URL-encode every id** in a path (`19:…@thread.v2`, `tenant:oid:session`).

| Operation | Request | Response |
| --- | --- | --- |
| List projects | `GET /v1/projects` | `{items[{projectId, title, state, archived, projectGuid, description, createdAt, updatedAt}]}` |
| Create project | `POST /v1/projects {"title","instructions":"","tags":[]}` | 201 project |
| Rename project | `PATCH /v1/projects/{projectId} {"title"}` | 200 |
| Archive / restore | `PATCH /v1/projects/{projectId} {"state":"archived"|"active"}` | 200 |
| Project color | `PATCH /v1/settings {"projectColors":{"<projectId>":"green"|null}}` | 200 full settings |
| Delete project | `DELETE /v1/projects/{projectId}` | **202** (async) |
| Project's Cowork tasks | `GET /v1/projects/{projectId}/tasks?pageSize=200` | `{items, cursor}` |
| Add chat to project | `POST /v1/projects/{projectId}/chats {"threadId":"19:…@thread.v2"}` | 201 `{bound:true}` |
| Add Cowork task to project | `POST /v2/tasks/projects/{projectId}/tasks {"conversationId":"<tid>:<oid>:<sessionId>"}` | 201 |
| Remove chat from project | `DELETE /v1/projects/{projectId}/tasks/{chat threadId}` | 204 |
| Remove task from project | `DELETE /v1/projects/{projectId}/tasks/{<tid>:<oid>:<sessionId>}` | 204 |
| List Cowork tasks | `GET /v1/tasks/live?pageSize=50&includeCached=true&sessionType=interactive[&cursor=…]` | `{tasks[], nextCursor}` |
| Cowork task detail | `GET /v1/tasks/live/detail?sessionId=<sessionId>` | `{task, snapshot}` |
| Cowork task events | `GET /v1/tasks/live/messages?threadId=<ic3ThreadId>&pageSize=50[&cursor]` | `{events[], nextCursor}` — token-level stream, MBs per page |
| Delete Cowork task | `DELETE /v1/conversations/{sessionId}` | 204 |
| Settings | `GET /v1/settings` | `{pinnedConversationIds, projectColors, rev, …}` |

Project colors offered by the UI: gray (default), green, blue, pumpkin, purple, pink,
yellow.

Cowork task events arrive newest page first; the organizer sorts them by the sequence
number in `id` (`seq:<n>`). It replays these event codes into a transcript:

| Code | Meaning | Fields used |
| --- | --- | --- |
| `u` | User prompt | `t` text, `ts`, `att[{fn, url}]` attachments (only the names are shown) |
| `dx` | Reply text, a few tokens at a time | `t`, `aid`. No time: a reply takes the time of the next timed event |
| `th` | Thinking, a few tokens at a time | Ignored |
| `ts`, `tx` | Tool call starts, ends | `tid`, `tn` tool name, `d` description, `ts`, `aid`; then `dur` (ms), `ok` |
| `sa`, `sx` | Subagent starts, ends | `tid`, `d` description (empty on `sx`), `ad`, `sat` type, `m` model, `ts`; then `dur`, `ok`. Older tasks send both when the subagent ends, with `dur` 0, and send `sx` twice |
| `aq` | Cowork asks the user a question | `q[{header, question, options}]`, `iid`, `rid`, `ts` |
| `aa` | The user's answer | `answers` (`{"0": …}`), `iid`, `ts`. Empty when the user sent a new message instead; skipped |
| `ar` | Unclear; only seen with an empty `r` | `rid`, `r`. Ignored when `r` is empty, otherwise treated as unknown |
| `ci` | Citation | `ttl`, `src`; listed once at the end as "Sources" |
| `fu` | File added to the task's OneDrive folder | `ip` path (`Tasks/<task>/input/<file>`), `rp`, `sz`, `mt`, `ts` |
| `fc` | File the task created or changed | `fn` (`output/<file>`), `ct` (`created`, `modified`), `sz`, `ts`. Sent on every save; each file is listed once at the end |
| `fr` | End of the reply | `stop`, `ts` |

Subagents run in parallel, so their events interleave with each other and with the main
agent's. The main agent's `dx` and `ts` events have no `aid`; a subagent's carry its `sa`
`tid` (`toolu_…`). The organizer shows each subagent's text and tool calls inside that
subagent's entry rather than as separate messages.

Other codes are logged as "unknown Cowork event codes" and shown only if they carry text.
The first 50 are kept unchanged in the transcript's `raw.unknownEvents`, so full backups
keep them too.

## 3. Semantics and caveats

* **Deleting a chat** also deletes Copilot tasks created from it (UI warning).
* **Deleting a project**: the UI warns it "permanently deletes the project, the chats,
  and project-level custom instructions". The API returns 202 and cleanup is
  asynchronous. The organizer therefore removes (detaches) items from a project before
  deleting it unless the user explicitly asks to delete the contents too.
* A chat/task belongs to at most one project in the UI; the organizer detaches an item
  from its current project before adding it to another.
* Cowork task URLs: `https://copilot.cloud.microsoft/cowork/#/task/<url-encoded taskId>`.
  Chat URLs: `https://copilot.cloud.microsoft/chat/conversation/<conversationId>`.
* **Empty Cowork tasks**: a task that was opened but never given a prompt (0 credits)
  comes back from `/v1/tasks/live` with an empty title and no `lastActivity` or
  `createdAt`; only `/detail` has `lastActivity`. The organizer lists these as
  "(untitled task)" with no date, so they sort together at the end of the list. Opening
  Cowork in a browser appears to create them (several appeared while these endpoints
  were being captured); the organizer only loads `/home`, which doesn't.
* **Cowork task files**: a task's files live in the user's OneDrive under
  `Tasks/<task>/`, with inputs in `input/` (`fu` events) and outputs in `output/`
  (`fc` events). It hasn't been verified whether deleting a task also deletes that
  folder, so check OneDrive after deleting tasks whose files matter.
