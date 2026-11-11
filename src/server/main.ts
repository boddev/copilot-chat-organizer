// Starts the Copilot Chat Organizer: a localhost web UI over every configured source.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../core/store.ts';
import { Organizer } from '../core/organizer.ts';
import type { Provider, ProviderContext, SourceId } from '../core/types.ts';
import { BrowserSession, DEFAULT_PROFILE_DIR, type BrowserMode } from '../lib/browser-session.ts';
import { PageTransport } from '../providers/m365/transport.ts';
import { M365Provider } from '../providers/m365/index.ts';
import { GhAppProvider } from '../providers/ghapp/index.ts';
import { VsCodeProvider } from '../providers/vscode/index.ts';
import { GhWebPageTransport } from '../providers/ghweb/transport.ts';
import { GhWebProvider } from '../providers/ghweb/index.ts';
import { createHandler } from './app.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_SOURCES: SourceId[] = ['m365', 'ghapp', 'vscode', 'ghweb'];
const BROWSER_MODES: BrowserMode[] = ['auto', 'headless', 'visible'];

const HELP = `Copilot Chat Organizer

Usage: npm start -- [options]

  --port <n>            Port on 127.0.0.1 (default 4747)
  --data <dir>          Private data directory (default <repo>/.data)
  --browser <mode>      auto | headless | visible (default auto: headless until a
                        sign-in is needed, then a visible Edge window)
  --profile <dir>       Edge profile used to sign in to Microsoft 365 and github.com
                        (default ${DEFAULT_PROFILE_DIR})
  --sources <list>      Comma-separated sources: ${ALL_SOURCES.join(',')} (default all)
                        m365 = Microsoft 365 Copilot and Cowork, ghapp = GitHub Copilot
                        app/CLI, vscode = VS Code Copilot Chat, ghweb = github.com Copilot
  --copilot-home <dir>  GitHub Copilot app/CLI data directory (default ~/.copilot)
  --no-open             Do not open the UI in your default browser
  -h, --help            Show this help
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function openInBrowser(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed anyway.
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '4747' },
      data: { type: 'string', default: path.join(ROOT, '.data') },
      browser: { type: 'string', default: 'auto' },
      profile: { type: 'string', default: DEFAULT_PROFILE_DIR },
      sources: { type: 'string', default: ALL_SOURCES.join(',') },
      'copilot-home': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid --port ${values.port}`);
  const browserMode = values.browser as BrowserMode;
  if (!BROWSER_MODES.includes(browserMode)) fail(`--browser must be one of ${BROWSER_MODES.join(', ')}`);
  const sources = values.sources
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as SourceId[];
  const unknown = sources.filter((s) => !ALL_SOURCES.includes(s));
  if (unknown.length) fail(`Unknown source(s): ${unknown.join(', ')}. Use: ${ALL_SOURCES.join(', ')}`);
  if (!sources.length) fail('Enable at least one source.');

  const store = new Store(values.data);
  const logFile = store.file('organizer.log');
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // Logging must never break an operation.
    }
  };
  const context = (id: SourceId): ProviderContext => ({
    dataDir: store.dataDir,
    trashDir: store.trashDir(id),
    log: (m) => log(`${id}: ${m}`),
  });

  let session: BrowserSession | undefined;
  const providers: Provider[] = [];
  for (const id of sources) {
    if (id === 'm365') {
      session ??= new BrowserSession({ profileDir: values.profile, mode: browserMode, log: (m) => log(`browser: ${m}`) });
      const transport = new PageTransport({ session, hintsFile: store.file('m365-hints.json'), log: (m) => log(`m365: ${m}`) });
      providers.push(new M365Provider(context('m365'), { transport }));
    } else if (id === 'ghapp') {
      providers.push(new GhAppProvider(context('ghapp'), { copilotHome: values['copilot-home'] }));
    } else if (id === 'vscode') {
      providers.push(new VsCodeProvider(context('vscode')));
    } else if (id === 'ghweb') {
      session ??= new BrowserSession({ profileDir: values.profile, mode: browserMode, log: (m) => log(`browser: ${m}`) });
      const transport = new GhWebPageTransport({ session, log: (m) => log(`ghweb: ${m}`) });
      providers.push(new GhWebProvider(context('ghweb'), { transport, copilotHome: values['copilot-home'] }));
    }
  }

  const organizer = new Organizer(store, providers, log);
  const token = crypto.randomBytes(24).toString('base64url');
  const handler = createHandler({
    organizer,
    publicDir: path.join(ROOT, 'public'),
    token,
    port,
    info: {
      dataDir: store.dataDir,
      browserMode,
      profileDir: values.profile,
      startedAt: new Date().toISOString(),
    },
  });

  const server = http.createServer(handler);
  server.requestTimeout = 15 * 60_000;
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      fail(`Port ${port} is already in use. Is the organizer already running? Open http://127.0.0.1:${port}/ or pass --port.`);
    }
    fail(`Server error: ${e.message}`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('Shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    server.close();
    await organizer.close().catch(() => {});
    await session?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    log(`Copilot Chat Organizer is running at ${url} (sources: ${sources.join(', ')}; data: ${store.dataDir})`);
    log('Press Ctrl+C to stop.');
    if (!values['no-open']) openInBrowser(url);
  });
}

main().catch((e) => fail(String((e as Error)?.stack ?? e)));
