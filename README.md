# Copilot Chat Organizer

A local web app for reviewing, grouping and bulk-deleting your Copilot conversations from
one list:

- **Microsoft 365 Copilot**: chats and Copilot Cowork tasks, plus your Copilot projects.
- **GitHub Copilot app & CLI**: sessions stored on this PC.
- **VS Code Copilot Chat**: chats stored on this PC (Stable and Insiders).
- **GitHub Copilot on github.com**: web chats, Copilot coding agent tasks, and the
  github.com copies of app and CLI sessions.

It runs on your PC at `http://127.0.0.1:4747`, acts only as you, and asks you to confirm
every deletion.

> **Unofficial.** None of these services has a public API for managing chat history. The
> organizer calls the internal endpoints the Copilot web apps use, from an Edge window you
> sign in to, and reads the local apps' own files. Any of this can change without notice.
> When a response doesn't look the way it expects, the organizer stops instead of
> guessing. See [docs/m365-endpoints.md](docs/m365-endpoints.md) and
> [docs/ghweb-endpoints.md](docs/ghweb-endpoints.md).

## What each source supports

| Source (`--sources` id) | Lists | Group into | Delete |
| --- | --- | --- | --- |
| Microsoft 365 Copilot (`m365`) | Chats (including agents such as Researcher and Analyst) and Cowork tasks | Your M365 Copilot projects, and collections | Permanently, in Microsoft 365 |
| GitHub Copilot app & CLI (`ghapp`) | App and CLI sessions in `~/.copilot` | Collections | CLI sessions move to the organizer trash. App sessions go through the [hand-off queue](#github-copilot-app-sessions-hand-off) |
| VS Code Copilot Chat (`vscode`) | Chats in VS Code's storage | Collections | Chats move to the organizer trash. VS Code must be closed |
| GitHub Copilot on github.com (`ghweb`) | Web chats, coding agent tasks and github.com copies of app/CLI sessions, including archived ones | Collections | Permanently, on github.com |

**Projects** are Microsoft 365 Copilot's own projects: changes you make here show up in
Copilot. **Collections** are the organizer's own groups. They work across every source, so
one collection can hold an M365 chat, a VS Code chat and a github.com task. They're stored
only on this PC and change nothing in the services.

## Requirements

- Windows. The local sources also know the macOS and Linux paths, but only Windows is
  tested.
- Node.js 24 or later. The organizer runs its TypeScript directly (Node's built-in type
  stripping) and reads SQLite with the built-in `node:sqlite`, so there's no build step.
  It's developed on Node 26.
- Microsoft Edge, for the Microsoft 365 and github.com sources.

## Get started

```powershell
cd copilot-chat-organizer
npm install
npm start
```

The UI opens in your default browser. Each source shows **Not loaded** until you select
**Load** (or **Refresh**). After that, the organizer remembers the last list, so it shows
right away the next time. Stop the organizer with Ctrl+C.

### Options

```text
npm start -- [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `4747` | Port on 127.0.0.1. |
| `--data <dir>` | `<repo>\.data` | The organizer's private data folder. See [Your data](#your-data). |
| `--browser <mode>` | `auto` | `auto`: Edge runs in the background until you need to sign in, then a window opens. `visible`: always show the window. `headless`: never show it (sign-ins fail). |
| `--profile <dir>` | `%LOCALAPPDATA%\copilot-chat-organizer\browser-profile` | The Edge profile you sign in with. |
| `--sources <list>` | all | Comma-separated: `m365,ghapp,vscode,ghweb`. |
| `--copilot-home <dir>` | `~/.copilot`, or `COPILOT_HOME` | The GitHub Copilot app/CLI data folder. |
| `--no-open` | | Don't open the UI in a browser. |
| `-h`, `--help` | | Show help. |

For example, to organize only your local GitHub Copilot chats on another port:

```powershell
npm start -- --sources ghapp,vscode --port 5000
```

VS Code chats are read from `%APPDATA%\Code\User` and `%APPDATA%\Code - Insiders\User`. Set
`VSCODE_APPDATA` to use a different base folder.

### Signing in

The Microsoft 365 and github.com sources use a dedicated Edge profile that only the
organizer uses. It's separate from your everyday Edge profile.

1. When a source needs you to sign in, an Edge window opens on the Microsoft 365 Copilot
   or github.com sign-in page.
2. Sign in as usual, including MFA, two-factor or SSO prompts. You have about five
   minutes.
3. Keep the window open while you use the organizer. Next time, it reuses your sign-in and
   stays in the background.

Only one program can use the profile at a time, so close other organizer windows (and
`npm run discover`) first.

## Using it

### Find conversations

- Pick a source tab, or **All**. The strip under the tabs shows each source's count, when
  it was last refreshed, and any sign-in prompts or warnings.
- Filter by project, collection, type, location (for example a repository, VS Code
  workspace or M365 agent) and age, such as **More than 90 days ago**.
- Search titles, previews, locations and IDs. Press `/` to jump to the search box.
- Sort by any column header. When the list is narrow, each row wraps onto extra lines and
  only the **Conversation** and **Last activity** headers are shown.
- Select a row to see its details and transcript. Long Cowork and github.com histories
  load a preview first; select **Load the full conversation** for the rest. Very long
  GitHub Copilot app and CLI sessions show their start and end, with a marker where the
  middle was skipped. Tool output longer than 1,500 characters is shortened; select
  **Show all** to expand it. For Microsoft 365 agents that build files, the preview and
  transcript describe their machine output (for example, "Created plan.docx"), and
  progress updates that repeat earlier steps show only the latest one. **Open ↗** opens
  the conversation in its own app.
- In a window narrower than 1,100 pixels, the details open over the list. Select **Close**
  or press Esc to go back to the list.
- Cowork tasks that were opened but never given a prompt show as **(untitled task)** with
  no date, at the end of the list when it's sorted by **Last activity**. To select them all,
  open the **Microsoft 365 Copilot** tab, search for `untitled task`, then select the box in
  the list header.

### Select

| Do this | To |
| --- | --- |
| Click a row's box, or Ctrl-click the row | Select or unselect it |
| Shift-click | Select a range |
| Ctrl+A, or the box in the list header | Select everything shown |
| Esc | Clear the selection (in a narrow window, first close the open details) |
| ↑ ↓ | Move between rows |
| Shift+↑ ↓ | Extend the selection |
| Space | Select or unselect the current row |
| Delete | Delete the selection |

The bar above the list acts on the selection: **Move to project…**, **Remove from
project**, **Add to collection…**, **Remove from "*collection*"** and **Delete…**. You can
also drag a selection onto a project or collection in the sidebar.

### Group into projects (Microsoft 365)

- **Move to project…** puts the selection in an existing project or a new one. A chat or
  task can be in only one project, so items already in another project move.
- Select **⋯** next to a project to rename it, change its color, archive it (archived
  projects are hidden from Copilot's main project list) or delete it.
- When you delete a project you choose:
  - **Keep its conversations**: they're taken out of the project, then the empty project
    is deleted.
  - **Delete its conversations too**: they're deleted permanently, then the project.
    Type the confirmation phrase to continue.

  Either way, the organizer checks that the project is really empty before deleting it, so
  nothing it doesn't know about is lost.

### Group into collections (every source)

Select **+ New** under **Collections**, then add conversations with **Add to
collection…** or by dragging. Collections can mix sources, have a color and can be renamed
or deleted. Deleting a collection never deletes the conversations in it.

### Delete

**Delete…** first shows a plan: what will be deleted permanently, what moves to the trash,
what goes to the hand-off queue and what can't be deleted. To continue, type
`delete <count>`, for example `delete 12`.

Before a permanent delete, the organizer saves a backup:

- **Summary** (recommended): what the list knows plus the readable conversation.
- **Full**: also loads the complete history of Cowork tasks and github.com items. Slower.
- **None**: saves nothing.

If a backup fails, that conversation isn't deleted. Backups are saved in the `backups`
folder of the [data folder](#your-data).

What happens per source:

- **Microsoft 365 Copilot.** The chat or Cowork task is deleted permanently. Microsoft 365
  also deletes any Copilot tasks created from a deleted chat; the plan warns you. A Cowork
  task keeps its files in your OneDrive under `Tasks\<task name>`; it hasn't been
  confirmed whether deleting the task removes them, so check that folder afterwards.
- **github.com.** The chat or task is deleted permanently from github.com. For a
  github.com copy of an app or CLI session, only the github.com copy is deleted; the
  session on your PC is listed separately under GitHub Copilot app & CLI.
- **GitHub Copilot app & CLI.** CLI sessions (folders the app doesn't track) move to the
  organizer trash, along with their rows in the CLI's session index. Sessions a running
  Copilot process is using are skipped. App sessions go to the hand-off queue.
- **VS Code Copilot Chat.** Chats move to the organizer trash, along with their entries in
  VS Code's chat index. VS Code keeps that index in memory, so close VS Code first; if the
  organizer can't tell whether it's running, it assumes it is.

#### GitHub Copilot app sessions (hand-off)

The GitHub Copilot app manages its own sessions, so the organizer never deletes them
itself. Instead, it queues them. Select **Hand-off**, then **Copy request**, and paste the
request into a chat in the GitHub Copilot app; the app deletes the sessions. Refresh the
GitHub Copilot app & CLI tab afterward, and deleted sessions leave the queue.

#### Trash and Activity

- **Trash** lists the local sessions the organizer moved to its trash. Select them, then
  **Restore selected** to put them back.
- **Activity** lists recent operations (moves into and out of projects, project changes,
  deletes and restores) with per-item results.

## Your data

Everything stays on your PC. The organizer talks only to the services you're signed in to.

The data folder (`.data` by default) holds conversation content, so treat it as private.
It's excluded from git, as is `captures` (endpoint recordings from `npm run discover`).

| Path | Contents |
| --- | --- |
| `cache\` | The last list and projects from each source |
| `backups\<date>\<source>\` | Backups made before deleting |
| `trash\<source>\` | Local sessions in the organizer trash |
| `collections.json` | Your collections |
| `handoff.json` | The hand-off queue |
| `tombstones.json` | Recently deleted items, hidden while a service still returns them |
| `oplog.jsonl` | The Activity log |
| `organizer.log` | Diagnostic log |
| `m365-hints.json` | Endpoint details learned from the Microsoft 365 Copilot web app |

How the organizer protects your accounts and files:

- API tokens stay in memory and are never written to the data folder or logs. The
  github.com token never leaves the Edge page. Your sign-in itself is kept by the Edge
  profile, as in any browser.
- The server listens only on 127.0.0.1. Each run has a random token that the page must
  send with every request, and requests with another host name are rejected, so other
  websites can't drive it.
- It reads the GitHub Copilot app's database read-only, and changes VS Code's files only
  while VS Code is closed.

## Development

```powershell
npm test            # node:test suites (fake providers and fixtures; no network)
npm run typecheck   # tsc --noEmit
npm run discover    # record a Copilot web app's API traffic (see tools/discover.ts)
```

```text
src/
  server/      main.ts (command line) and app.ts (HTTP API)
  core/        organizer (jobs, delete plans, backups), store (data folder), types
  lib/         shared Edge session (Playwright), async helpers, seroval codec
  providers/
    m365/      Microsoft 365 Copilot and Cowork
    ghapp/     GitHub Copilot app and CLI
    vscode/    VS Code Copilot Chat
    ghweb/     GitHub Copilot on github.com
public/        the web UI (plain JavaScript, no build)
test/          tests, fixtures and test helpers
tools/         endpoint discovery and capture analysis
docs/          endpoint notes
```

Each source is a provider (`src/core/types.ts`) that lists conversations, renders
transcripts, deletes, and optionally manages native projects. To add a source, implement
`Provider` and register it in `src/server/main.ts`.

When a web app changes, run `npm run discover` against it, reproduce the action in the
window, and inspect the capture with `tools/analyze.ts`, `tools/actions.ts` and
`tools/decode.ts`. Captures redact secrets but still contain conversation content.
