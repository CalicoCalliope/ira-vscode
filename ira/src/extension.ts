import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logPemToCoordinator, updateAccessed } from "./coordinator-service";

// ---------------------- TYPES ----------------------

export interface PemLogEntry {
  id: string;
  timestamp: string;
  pem: string;
  pemType: string;
  pemSkeleton: string;
  code: string;
  username: string;
  activeFile: string;
  workingDirectory: string;
  directoryTree: string[];
  pythonVersion?: string;
  packages?: any[];
  isFirstOccurrence: boolean;
  llm: {
    hint?: string;
    reasoning?: string;
    answer?: string;
  };
}

interface WebviewState {
  stage: 'initial' | 'hint' | 'reasoning' | 'answer';
  isFirstOccurrence: boolean;
  hint?: string;
  reasoning?: string;
  answer?: string; // content used for "Fix" display
  context?: string;
  focusMessage?: string;
  initialMessage?: string;
  seenHint?: boolean;
  seenReasoning?: boolean;
}

interface TracebackFrame {
  file: string;
  line: number;
  column?: number;
  functionName?: string;
  errorMessage?: string;
}

interface HighlightMetadata {
  line: number;
  column?: number;
  displayText: string;
  pointerText: string;
  isSyntaxError: boolean;
}

const diagnosticCollection = vscode.languages.createDiagnosticCollection('ira');
let errorLineDecoration: vscode.TextEditorDecorationType | undefined;
let errorColumnDecoration: vscode.TextEditorDecorationType | undefined;
let errorPointerDecoration: vscode.TextEditorDecorationType | undefined;
let syntaxBannerDecoration: vscode.TextEditorDecorationType | undefined;
let iraGuidancePanel: vscode.WebviewPanel | undefined;
let iraGuidanceMessageListener: vscode.Disposable | undefined;
let analysisStatusItem: vscode.StatusBarItem | undefined;
let lastHighlightState: {
  uri: vscode.Uri;
  lineRange: vscode.Range;
  columnRange?: vscode.Range;
  pointerOption?: vscode.DecorationOptions;
  syntaxBannerRange?: vscode.Range;
  syntaxBannerMessage?: string;
} | null = null;
let activeHighlightDocumentVersion: number | null = null;

// ---------------------- CONFIG ----------------------
const COORDINATOR_URL = 'http://YOUR_VM_IP:PORT'; // kept for reference if needed elsewhere

// Friendly intro messages shown before the 3-tier guidance
const FIRST_TIME_MESSAGES: string[] = [
  `Don't panic, I'm here. Let's peek at this together 🐣`,
  `You found an error, not a dead end. We can fix it 🌱`,
  `New error unlocked! Curious mode on? ✨`,
  `It's okay to stumble. This is how programmers level up 💪`,
  `Deep breath. We got this. Want a hint? 😊`,
  `Errors are just computers asking for clarity. Let's help them 😺`,
  `You're doing great. Ready for a gentle nudge? 💡`,
  `No stress. We'll go one tiny step at a time 🧩`,
  `You spotted something new—let's stay curious and unpack it together 🌱`,
  `Deep breath; this error is just a clue and we can decode it calmly 🧘`,
  `New puzzle unlocked! We'll explore it step by step ✨`,
  `It's okay to feel unsure; I'm here to guide the next move 🤝`,
  `No rush—let's turn this mysterious message into insight 🧩`,
  `You’re learning with every attempt; ready for a gentle nudge? 💡`,
  `We’ve got this—confidence first, syntax second 💪`,
  `Errors are questions in disguise; let's answer them together 🔍`
];

const SEEN_BEFORE_MESSAGES: string[] = [
  `Hey, we've seen this before. Want a quick refresh? 🔁`,
  `Welcome back. Familiar error. Shall we try the fast path? 🚀`,
  `Good news, this one has a known fix. Want the recap? 📘`,
  `Deja vu! Let's apply what worked last time ✅`,
  `We recognize this pattern. Want the shortcut summary? 🎯`,
  `Same vibes as earlier. Want a guided reminder? 🧭`,
  `This looks familiar; let’s revisit what worked last time ✅`,
  `Welcome back, teammate—ready for a calm refresher? 🔁`,
  `We already mapped this terrain; shall we take the guided trail? 🧭`,
  `Good news: you've handled this before. Want the friendly recap? 📘`,
  `Same pattern, same steady approach. Let’s walk through it 🌿`,
  `Your past effort is paying off—let me highlight the key steps ⭐`,
  `Already met this bug? Perfect, we can reinforce the lesson together 🧠`,
  `A quick reminder and you’ll be right back on track 🚶`
];

function friendlyIntro(isFirst: boolean): string {
  const arr = isFirst ? FIRST_TIME_MESSAGES : SEEN_BEFORE_MESSAGES;
  return arr[Math.floor(Math.random() * arr.length)];
}

function showAnalysisStatus(message: string): vscode.Disposable {
  if (!analysisStatusItem) {
    analysisStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    analysisStatusItem.color = '#16a34a';
  }
  analysisStatusItem.text = message;
  analysisStatusItem.tooltip = 'IRA is running your code';
  analysisStatusItem.show();
  return { dispose: () => analysisStatusItem?.hide() };
}

function disposeGuidanceMessageListener() {
  if (iraGuidanceMessageListener) {
    iraGuidanceMessageListener.dispose();
    iraGuidanceMessageListener = undefined;
  }
}

// ---------------------- HELPER FUNCTIONS ----------------------
async function resolvePythonCmd(): Promise<string> {
  const candidates = ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      await new Promise<void>((res, rej) => {
        exec(`${cmd} --version`, (err) => (err ? rej(err) : res()));
      });
      return cmd;
    } catch {
      // try next
    }
  }
  vscode.window.showErrorMessage('Python interpreter not found. Please install Python 3 and ensure it is on PATH.');
  throw new Error('No Python interpreter found on PATH');
}

async function getEnvInfo(): Promise<{ pythonVersion?: string; packages?: any[] }> {
  return new Promise(async (resolve) => {
    try {
      const py = await resolvePythonCmd();
      exec(`${py} --version`, (err, stdout, stderr) => {
        const versionOut = (stdout || stderr || '').toString().trim();
        exec(`${py} -m pip list --format=json`, (err2, stdout2) => {
          let packages: any[] = [];
          try {
            if (stdout2?.trim()) {
              packages = JSON.parse(stdout2.toString());
            }
          } catch {}
          resolve({ pythonVersion: versionOut, packages });
        });
      });
    } catch {
      resolve({ pythonVersion: undefined, packages: [] });
    }
  });
}

function extractPemType(errorMessage: string): string {
  const match = errorMessage.match(/([a-zA-Z]+Error)/);
  return match ? match[1] : 'UnknownError';
}

async function getPemSkeletonFromPython(pem: string): Promise<string> {
  const py = await resolvePythonCmd();
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'pem_parser.py');
    const python = spawn(py, [scriptPath]);

    let output = '';
    let error = '';

    python.stdout.on('data', (data) => (output += data.toString()));
    python.stderr.on('data', (data) => (error += data.toString()));

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${error}`));
      } else {
        try {
          const parsed = JSON.parse(output);
          resolve(parsed.pemSkeleton);
        } catch (err) {
          reject(new Error(`Failed to parse JSON from Python script: ${err}`));
        }
      }
    });

    python.stdin.write(pem);
    python.stdin.end();
  });
}

async function buildPemLogEntry(
  pem: string,
  code: string,
  filePath: string,
): Promise<PemLogEntry> {
  const { pythonVersion, packages } = await getEnvInfo();
  let pemSkeleton = pem.split(':')[0]; // fallback skeleton
  try {
    pemSkeleton = await getPemSkeletonFromPython(pem);
  } catch (err) {
    console.warn('Failed to get PEM skeleton:', err);
  }

  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    pem,
    pemType: extractPemType(pem),
    pemSkeleton,
    code,
    username: process.env.USER || 'unknown',
    activeFile: filePath,
    workingDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
    directoryTree: [],
    pythonVersion,
    packages,
    isFirstOccurrence: true,
    llm: {}
  };
}

// Optional direct POST helper if needed elsewhere
async function sendPemLog(entry: PemLogEntry): Promise<string> {
  try {
    const response = await axios.post(`${COORDINATOR_URL}/process-pem`, entry);
    const data = response.data;
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (error) {
    console.error('Error sending PEM to coordinator:', error);
    return 'Failed to communicate with PEM service.';
  }
}

// ---------------------- WEBVIEW UI ----------------------
function getHraWebviewHtml(state: WebviewState, mode: 'full' | 'baseline' = 'full') {
  const {
    stage,
    isFirstOccurrence,
    hint,
    reasoning,
    answer,
    context,
    focusMessage,
    initialMessage,
    seenHint = false,
    seenReasoning = false
  } = state;

  const hasSeenHint = seenHint || stage === 'hint';
  const hasSeenReasoning = seenReasoning || stage === 'reasoning' || stage === 'answer';

  let content = '';
  let buttons = '';

  // Escape HTML for safe display in body
  const escapeHtml = (str: string | undefined) =>
    (str ?? '')
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/\n/g, "<br>");
      
  // Helper to generate buttons safely
  const createButton = (label: string, payloadObj?: any, type: "primary" | "ghost" | "default" = "default") => {
    const payload = payloadObj ? JSON.stringify(payloadObj).replace(/'/g, "&apos;") : "";
    const cls = type === "primary" ? "btn primary" : type === "ghost" ? "btn ghost" : "btn";
    if (payloadObj) {
      return `<button class="${cls}" data-payload='${payload}' onclick='sendMessageFromButton(this)'>${label}</button>`;
    } else {
      return `<button class="${cls}" onclick='sendMessage("close")'>${label}</button>`;
    }
  };

  const basePayload = {
    isFirstOccurrence,
    hint,
    reasoning,
    answer,
    context,
    focusMessage,
    initialMessage,
    seenHint: hasSeenHint,
    seenReasoning: hasSeenReasoning
  };

  const buildPayload = (nextStage: WebviewState['stage'], overrides: Partial<WebviewState> = {}) => ({
    ...basePayload,
    ...overrides,
    stage: nextStage
  });

  switch (stage) {
    case 'initial': {
      const contextBlock = context && !isFirstOccurrence ? `<pre class="context">${escapeHtml(context)}</pre>` : '';
      content = escapeHtml(initialMessage) + contextBlock;
      buttons = `
        ${createButton("Yes, I am lost. Show me step-by-step please 😬", buildPayload("hint", { seenHint: true }), "primary")}
        ${createButton("Hmmmm. Walk me through why this happened 🧭", buildPayload("reasoning", { seenReasoning: true }))}
        ${createButton("I can do this! I do not need help right now 💪")}
      `;
      break;
    }
    case 'hint':
      content = `<h3>What's happening</h3><p>${escapeHtml(hint)}</p>`;
      buttons = `
        ${createButton("Teach me why this happened 🧠", buildPayload("reasoning", { seenHint: true, seenReasoning: true }), "primary")}
        ${createButton("Okay, I got it 👍")}
      `;
      break;
    case 'reasoning': {
      content = `<h3>Why it happens</h3><p>${escapeHtml(reasoning)}</p>`;
      const fixButton = hasSeenHint ? createButton("Show me how to fix this type of error", buildPayload("answer"), "ghost") : '';
      buttons = `
        ${createButton("Back to \"What's happening\" 🔙", buildPayload("hint", { seenHint: true }))}
        ${createButton("I'm ready to tackle this myself 💪", undefined, "primary")}
        ${fixButton}
      `;
      break;
    }
    case 'answer':
      content = `<h3>How to fix it</h3><p>${escapeHtml(answer)}</p>`;
      buttons = `
        ${createButton("Got it 👍")}
        ${createButton("Explain how it works 🧠", buildPayload("reasoning", { seenHint: true, seenReasoning: true }))}
      `;
      break;
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>HRA Panel</title>
      <style>
        :root {
          --fg: var(--vscode-foreground);
          --bg: var(--vscode-editor-background);
          --panel: var(--vscode-sideBar-background);
          --border: var(--vscode-panel-border);
          --btn-fg: var(--vscode-button-foreground);
          --btn-bg: var(--vscode-button-background);
          --btn-hover: var(--vscode-button-hoverBackground);
          --accent-green: #16a34a;
          --btn-border: var(--accent-green);
          --btn-secondary-bg: var(--vscode-button-secondaryBackground, #2a2e3a);
          --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
          --input-bg: var(--vscode-input-background);
          --btn-primary-bg: var(--accent-green);
          --btn-primary-hover: #15803d;
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; }
        .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
        .focus-pill { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(22,163,74,0.5); background: rgba(22,163,74,0.18); font-weight: 600; color: #dcfce7; }
        h3 { margin: 0 0 8px; font-size: 14px; }
        p { margin: 0; white-space: pre-wrap; }
        .context { background: var(--input-bg); border: 1px solid var(--border); padding: 10px; border-radius: 8px; overflow: auto; max-height: 220px; margin-top: 8px; }
        .actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
        .btn { appearance: none; border: 1px solid var(--btn-border); background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); padding: 8px 12px; border-radius: 8px; cursor: pointer; user-select: none; transition: filter .12s ease, background .12s ease, transform .02s ease-in-out; }
        .btn:hover { filter: brightness(1.08); }
        .btn:active { transform: translateY(1px); }
        .btn.primary { background: var(--btn-primary-bg); color: var(--btn-fg); border-color: var(--btn-primary-bg); }
        .btn.primary:hover { background: var(--btn-primary-hover); filter: none; }
        .btn.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
      </style>
    </head>
    <body>
      <div class="card">
        ${focusMessage ? `<div class="focus-pill">Focus on ${escapeHtml(focusMessage)}</div>` : ''}
        <div class="content">${content}</div>
        <div class="actions">${buttons}</div>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
        function sendMessage(command, data = {}) { vscode.postMessage({ command, data }); }

        window.addEventListener('message', event => {
          const msg = event.data;
          if (msg.command === 'updateStage') {
            console.log("[Webview] Updating stage:", msg.data.stage);
            document.querySelector('.content').innerHTML =
              '<h3>' + msg.data.stage + '</h3>';
          }
        });

        // Helper to read payload from button data attribute
        function sendMessageFromButton(btn) {
          const payload = btn.getAttribute('data-payload');
          if (!payload) return;
          try {
            const data = JSON.parse(payload);
            console.log("[Webview] Button clicked, sending nextStage:", data);
            sendMessage("nextStage", data);
          } catch (err) {
            console.error("Failed to parse button payload", err);
          }
        }

        // Keyboard shortcuts: Enter activates first primary button, Esc closes
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') sendMessage('close');
          if (e.key === 'Enter') {
            const primary = document.querySelector('.btn.primary');
            if (primary) primary.click();
          }
        });
      </script>
    </body>
    </html>
  `;
}

// ---------------------- WEBVIEW CREATION ----------------------
export function createHraWebview(
  title: string,
  isFirstOccurrence: boolean,
  hint?: string,
  reasoning?: string,
  answer?: string,
  context?: string,
  focusMessage?: string,
  pemId?: string,
  mode: 'full' | 'baseline' = 'full'
) {
  if (!iraGuidancePanel) {
    iraGuidancePanel = vscode.window.createWebviewPanel(
      'hraPanel',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    iraGuidancePanel.onDidDispose(() => {
      iraGuidancePanel = undefined;
      disposeGuidanceMessageListener();
    });
  } else {
    iraGuidancePanel.title = title;
    iraGuidancePanel.reveal(vscode.ViewColumn.Beside);
  }

  const panel = iraGuidancePanel;
  if (!panel) {
    return;
  }

  const initialMessage = friendlyIntro(isFirstOccurrence);

  // Render initial HTML
  panel.webview.html = getHraWebviewHtml({
    stage: 'initial',
    isFirstOccurrence,
    hint,
    reasoning,
    answer,
    context,
    focusMessage,
    initialMessage
  },
  mode);

  // Initialize local accessed state (baseline)
  let accessedState = { hint: false, reasoning: false, answer: false };

  // Push initial state to DB so field always exists
  (async () => {
    try {
      if (pemId) {
        await updateAccessed(pemId, accessedState);
        console.log(`[IRA] Initialized accessed flags for ${pemId}`);
      }
    } catch (err) {
      console.warn("Failed to initialize accessed:", err);
    }
  })();

  // Handle button clicks from webview
  disposeGuidanceMessageListener();
  iraGuidanceMessageListener = panel.webview.onDidReceiveMessage(async (message) => {
    console.log("[IRA] Message received from Webview:", message);

    switch (message.command) {
      case 'nextStage': {
        const nextStage = message.data.stage as WebviewState['stage'];
        console.log("[IRA] nextStage triggered:", nextStage);

        // Re-render UI (preserves the full HRA styling)
        panel.webview.html = getHraWebviewHtml({
          ...message.data,
          stage: nextStage,
          mode
        });

        // Update local state: only flip flags to true, never back to false
        if (nextStage === 'hint') {
          accessedState.hint = true;
        }
        if (nextStage === 'reasoning') {
          accessedState.hint = true;
          accessedState.reasoning = true;
        }
        if (nextStage === 'answer') {
          accessedState.hint = true;
          accessedState.reasoning = true;
          accessedState.answer = true;
        }

        // Push updated state to backend
        try {
          if (pemId) {
            await updateAccessed(pemId, accessedState);
          }
          console.log(`[IRA] Updated accessed for ${pemId}:`, accessedState);
        } catch (err) {
          console.warn("Failed to update accessed:", err);
        }

        break;
      }

      case 'close':
        panel.dispose();
        break;
    }
  });
}

// ---------------------- RUNTIME ERROR HANDLING ----------------------
function normalizePathForComparison(inputPath: string): string {
  if (!inputPath) {
    return '';
  }

  let resolved = path.resolve(inputPath);
  try {
    resolved = fs.realpathSync(inputPath);
  } catch {
    // best effort: ignore if path doesn't exist yet
  }

  const normalized = path.normalize(resolved);
  return (process.platform === 'win32' || process.platform === 'darwin')
    ? normalized.toLowerCase()
    : normalized;
}

function extractPreferredBracket(errorMessage?: string): string | undefined {
  if (!errorMessage) {
    return undefined;
  }
  const match = errorMessage.match(/['"]([\(\[\{])['"] was never closed/i);
  return match ? match[1] : undefined;
}

function findUnclosedBracketPosition(
  document: vscode.TextDocument,
  limitLine: number,
  preferChar?: string
): { line: number; column: number } | null {
  const openings = ['(', '[', '{'];
  const closingMap = new Map<string, string>([
    [')', '('],
    [']', '['],
    ['}', '{']
  ]);
  const stack: Array<{ char: string; line: number; column: number }> = [];
  const maxLine = Math.min(Math.max(limitLine, 0), document.lineCount - 1);

  for (let line = 0; line <= maxLine; line += 1) {
    const text = document.lineAt(line).text;
    for (let column = 0; column < text.length; column += 1) {
      const char = text[column];
      if (openings.includes(char)) {
        stack.push({ char, line, column });
      } else if (closingMap.has(char)) {
        const match = closingMap.get(char);
        const top = stack[stack.length - 1];
        if (top && top.char === match) {
          stack.pop();
        }
      }
    }
  }

  if (!stack.length) {
    return null;
  }

  if (preferChar) {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].char === preferChar) {
        return { line: stack[i].line, column: stack[i].column };
      }
    }
  }

  const last = stack[stack.length - 1];
  return { line: last.line, column: last.column };
}

function findLikelySyntaxOrigin(
  document: vscode.TextDocument,
  errorLine: number,
  errorMessage?: string
): { line: number; column: number } | null {
  const prefer = extractPreferredBracket(errorMessage);
  return findUnclosedBracketPosition(document, errorLine, prefer);
}

function applySyntaxBanner(
  editor: vscode.TextEditor,
  range: vscode.Range | undefined,
  message: string | undefined
) {
  if (!syntaxBannerDecoration) {
    return;
  }
  if (!range || !message) {
    editor.setDecorations(syntaxBannerDecoration, []);
    return;
  }
  editor.setDecorations(syntaxBannerDecoration, [
    {
      range,
      renderOptions: {
        after: {
          contentText: ` ${message}`,
          color: '#14532d',
          backgroundColor: 'rgba(22, 163, 74, 0.18)',
          margin: '0 0 0 8px',
          fontWeight: '600'
        }
      }
    }
  ]);
}

function extractRuntimeError(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]?.trim();
    if (!candidate) {
      continue;
    }
    if (/(Exception|Error)\b/i.test(candidate)) {
      return candidate;
    }
  }

  const tracebackLine = lines.find((line) => /Traceback \(most recent call last\):/i.test(line));
  return tracebackLine ? tracebackLine.trim() : null;
}

function parsePythonTraceback(stderr: string): TracebackFrame[] {
  const lines = stderr.split(/\r?\n/);
  const frames: TracebackFrame[] = [];
  let pendingErrorMessage: string | undefined;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const rawLine = lines[i] ?? '';
    const fileMatch = rawLine.match(/\s*File "([^"]+)", line (\d+)(?:, in ([^\r\n]+))?/);
    if (fileMatch) {
      const filePath = path.normalize(fileMatch[1]);
      const lineNumber = Number(fileMatch[2]);
      const functionName = fileMatch[3]?.trim();

      const codeLine = lines[i + 1] ?? '';
      const caretLine = lines[i + 2] ?? '';
      const caretIndex = caretLine.indexOf('^');
      const column = caretIndex >= 0 ? caretIndex : undefined;

      const frame: TracebackFrame = {
        file: filePath,
        line: lineNumber,
        column,
        functionName,
        errorMessage: pendingErrorMessage
      };

      frames.unshift(frame);
      continue;
    }

    const trimmed = rawLine.trim();
    if (!pendingErrorMessage && /^[A-Za-z]+Error:/i.test(trimmed)) {
      pendingErrorMessage = trimmed;
      continue;
    }

    if (frames.length === 0) {
      continue;
    }

    if (/Traceback \(most recent call last\):/i.test(trimmed)) {
      continue;
    }

    if (!rawLine.startsWith(' ')) {
      break;
    }
  }

  return frames;
}

function shouldIgnoreCaret(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  if (!/SyntaxError/i.test(errorMessage)) {
    return false;
  }
  const patterns = [
    /unexpected EOF while parsing/i,
    /was never closed/i,
    /unterminated/i,
    /EOL while scanning string literal/i
  ];
  return patterns.some((regex) => regex.test(errorMessage));
}

function clearVisualErrorIndicators() {
  diagnosticCollection.clear();
  lastHighlightState = null;
  activeHighlightDocumentVersion = null;

  const lineDecoration = errorLineDecoration;
  const columnDecoration = errorColumnDecoration;
  const pointerDecoration = errorPointerDecoration;
  const bannerDecoration = syntaxBannerDecoration;

  vscode.window.visibleTextEditors.forEach((activeEditor) => {
    if (lineDecoration) {
      activeEditor.setDecorations(lineDecoration, []);
    }
    if (columnDecoration) {
      activeEditor.setDecorations(columnDecoration, []);
    }
    if (pointerDecoration) {
      activeEditor.setDecorations(pointerDecoration, []);
    }
    if (bannerDecoration) {
      activeEditor.setDecorations(bannerDecoration, []);
    }
  });
}

function applyInlineErrorHighlight(stderr: string, filePath: string, editor: vscode.TextEditor): HighlightMetadata | null {
  const frames = parsePythonTraceback(stderr);
  if (!frames.length) {
    return null;
  }

  const normalizedPath = normalizePathForComparison(filePath);
  const relevantFrame = [...frames]
    .reverse()
    .find((frame) => normalizePathForComparison(frame.file) === normalizedPath);
  if (!relevantFrame) {
    return null;
  }

  let resolvedLineNumber = relevantFrame.line;
  let resolvedColumnNumber = typeof relevantFrame.column === 'number' ? relevantFrame.column : undefined;

  const runtimeSummary = extractRuntimeError(stderr) ?? 'Runtime error';
  const isSyntaxError = /SyntaxError/i.test(relevantFrame.errorMessage ?? '') || /SyntaxError/i.test(runtimeSummary);

  if (isSyntaxError) {
    const caretMissing = resolvedColumnNumber === undefined || shouldIgnoreCaret(relevantFrame.errorMessage);
    if (caretMissing) {
      const fallback = findLikelySyntaxOrigin(editor.document, resolvedLineNumber - 1, relevantFrame.errorMessage);
      if (fallback) {
        const fallbackLineNumber = fallback.line + 1;
        if (fallbackLineNumber <= resolvedLineNumber) {
          resolvedLineNumber = fallbackLineNumber;
          resolvedColumnNumber = fallback.column;
        }
      }
    }
  }

  const actualLine = Math.max(resolvedLineNumber - 1, 0);
  if (actualLine >= editor.document.lineCount) {
    return null;
  }

  const actualLineText = editor.document.lineAt(actualLine).text;
  const diagnosticRange = new vscode.Range(actualLine, 0, actualLine, actualLineText.length);
  const diagnostic = new vscode.Diagnostic(diagnosticRange, runtimeSummary, vscode.DiagnosticSeverity.Error);
  diagnostic.source = 'IRA';
  diagnosticCollection.set(editor.document.uri, [diagnostic]);

  const lineDecoration = errorLineDecoration;
  const columnDecoration = errorColumnDecoration;
  const pointerDecoration = errorPointerDecoration;
  let pointerOption: vscode.DecorationOptions | undefined;
  let columnRange: vscode.Range | undefined;
  let syntaxBannerRange: vscode.Range | undefined;
  let highlightRange = diagnosticRange;
  if (isSyntaxError) {
    const bannerLine = Math.min(actualLine + 1, editor.document.lineCount - 1);
    const bannerText = editor.document.lineAt(bannerLine).text;
    highlightRange = new vscode.Range(bannerLine, 0, bannerLine, bannerText.length);
    syntaxBannerRange = highlightRange;
    applySyntaxBanner(editor, syntaxBannerRange, relevantFrame.errorMessage ?? runtimeSummary);
    if (columnDecoration) {
      editor.setDecorations(columnDecoration, []);
    }
    if (pointerDecoration) {
      editor.setDecorations(pointerDecoration, []);
    }
  } else {
    applySyntaxBanner(editor, undefined, undefined);
    const rawColumn = typeof resolvedColumnNumber === 'number' && resolvedColumnNumber >= 0
      ? Math.min(resolvedColumnNumber, actualLineText.length)
      : undefined;

    if (columnDecoration) {
      if (rawColumn !== undefined) {
        const columnStart = new vscode.Position(actualLine, rawColumn);
        const columnEnd = rawColumn < actualLineText.length
          ? new vscode.Position(actualLine, rawColumn + 1)
          : columnStart;
        columnRange = new vscode.Range(columnStart, columnEnd);
        editor.setDecorations(columnDecoration, [columnRange]);
      } else {
        editor.setDecorations(columnDecoration, []);
      }
    }

    if (pointerDecoration) {
      const anchorPosition = columnRange?.end ?? new vscode.Position(actualLine, actualLineText.length);
      const pointerRange = new vscode.Range(anchorPosition, anchorPosition);
      const pointerData: vscode.DecorationOptions = {
        range: pointerRange,
        renderOptions: {
          after: {
            contentText: ` ← ${runtimeSummary}`,
            color: '#16a34a',
            backgroundColor: 'rgba(22, 163, 74, 0.15)',
            margin: '0 0 0 8px',
            fontWeight: '600',
            textDecoration: 'none'
          }
        }
      };
      pointerOption = pointerData;
      editor.setDecorations(pointerDecoration, [pointerData]);
    }
  }

  if (lineDecoration) {
    editor.setDecorations(lineDecoration, [highlightRange]);
  }

  editor.revealRange(highlightRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  lastHighlightState = {
    uri: editor.document.uri,
    lineRange: highlightRange,
    columnRange,
    pointerOption,
    syntaxBannerRange,
    syntaxBannerMessage: syntaxBannerRange ? relevantFrame.errorMessage ?? runtimeSummary : undefined
  };
  activeHighlightDocumentVersion = editor.document.version;

  return {
    line: resolvedLineNumber,
    column: columnRange ? columnRange.start.character + 1 : undefined,
    displayText: `Line ${resolvedLineNumber}: ${actualLineText.trim() || '<empty>'}`,
    pointerText: runtimeSummary,
    isSyntaxError
  };
}

// ---------------------- RUN WITH IRA ----------------------
function extractPatchedCode(answerStr?: string): string | undefined {
  if (!answerStr) {
    return undefined;
  }

  // Match "Patched code:" and capture all lines until a line that starts with "Patch" or "Confidence"
  const match = answerStr.match(/Patched code:\r?\n([\s\S]*?)(?=\r?\n(Patch|Confidence))/);

  if (match && match[1]) {
    // prepend "Patched code:" to match your desired output
    return 'Patched code:\n' + match[1].trim();
  }

  return undefined;
}

export async function runCodeWithIra(filePath: string, language: string, mode: 'full' | 'baseline' = 'full') {
  const editor = vscode.window.activeTextEditor;
  if (!editor){
    return;
  }

  if (editor.document.isDirty) {
    await editor.document.save();
  }

  clearVisualErrorIndicators();

  const py = await resolvePythonCmd();

  const code = editor.document.getText();
  const runningIndicator = showAnalysisStatus('$(sync~spin) IRA is analyzing this run...');

  exec(`${py} "${filePath}"`, async (error, stdout, stderr) => {
    const cleanup = () => {
      runningIndicator.dispose();
    };
    if (stdout){
      console.log(`[stdout]: ${stdout}`);
    }

    const normalizedStderr = stderr ?? '';
    const effectiveStderr = normalizedStderr.trim().length ? normalizedStderr : (error ? `${error.message}` : '');
    if (!effectiveStderr.trim()) {
      cleanup();
      return;
    }

    const highlightInfo = applyInlineErrorHighlight(effectiveStderr, filePath, editor);

    const pem = `[RUNTIME ERROR] ${effectiveStderr}`;
    const pemType = extractPemType(effectiveStderr);
    const pemSkeleton = await getPemSkeletonFromPython(pem);
      const envInfo = await getEnvInfo();

      // Build log entry for coordinator
      const pemLogEntry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        pem,
        pemType,
        pemSkeleton,
        code,
        username: process.env.USER || process.env.USERNAME || vscode.env.machineId,
        activeFile: filePath,
        workingDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        directoryTree: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
        pythonVersion: envInfo.pythonVersion,
        packages: envInfo.packages,
        isFirstOccurrence: false, // will be updated by coordinator
        llm: {}
      };

      // Send to coordinator and get enriched response (HRA + firstOccurrence + context)
    const coordinatorResponse = await logPemToCoordinator(pemLogEntry, mode);
    const patchedCode = extractPatchedCode(coordinatorResponse.answer) ?? '';

    const combinedContext = highlightInfo
      ? [highlightInfo.pointerText, coordinatorResponse.context].filter(Boolean).join('\n\n')
      : coordinatorResponse.context;

    const focusMessage = highlightInfo && !highlightInfo.isSyntaxError ? highlightInfo.displayText : undefined;

    createHraWebview(
      'IRA Guidance',
      coordinatorResponse.isFirstOccurrence,
      coordinatorResponse.hint,
      coordinatorResponse.reasoning,
      patchedCode,
      combinedContext,
      focusMessage,
      pemLogEntry.id,
      mode
    );

    const lineHint = highlightInfo
      ? ` on line ${highlightInfo.line}${highlightInfo.column ? `, column ${highlightInfo.column}` : ''}`
      : '';
    vscode.window.showErrorMessage(`Runtime error (${pemType})${lineHint}. HRA panel opened.`);
    cleanup();
  });
}

// ---------------------- EXTENSION ACTIVATION ----------------------
export function activate(context: vscode.ExtensionContext) {
  const modeEnv = 'baseline'; // 'baseline' or 'full'
  const mode: 'full' | 'baseline' = modeEnv as 'full' | 'baseline';

  // Register the "Run with Ira" command
  const runAndCaptureErrors = vscode.commands.registerCommand('IRA.runPythonAndCaptureErrors', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Open a Python file to run.');
      return;
    }

    if (editor.document.isDirty) {
      await editor.document.save();
    }

    const py = await resolvePythonCmd();

    const filePath = editor.document.uri.fsPath;
    const language = editor.document.languageId;

    // Run in VS Code integrated terminal (normal user-facing behavior)
    const terminal = vscode.window.createTerminal('IRA Python');
    terminal.sendText(`${py} "${filePath}"`);
    terminal.show();

    runCodeWithIra(filePath, language, mode);
  });

  context.subscriptions.push(runAndCaptureErrors);

  // Create a status bar button (bottom-left) for "Run with Ira"
  const runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runButton.command = 'IRA.runPythonAndCaptureErrors'; // must match the command registered above
  runButton.text = '$(flag) Run with IRA'; // codicon flag to mimic Scratch's green flag
  runButton.color = '#16a34a'; // green flag vibe
  runButton.tooltip = 'Green flag: run current Python file and capture runtime errors';
  runButton.show();

  context.subscriptions.push(runButton);
  if (!analysisStatusItem) {
    analysisStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    analysisStatusItem.color = '#16a34a';
    analysisStatusItem.hide();
  }
  context.subscriptions.push(analysisStatusItem);
  context.subscriptions.push(diagnosticCollection);

  if (!errorLineDecoration) {
    errorLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      light: {
        backgroundColor: 'rgba(167, 243, 208, 0.55)',
        border: '1px solid rgba(21, 128, 61, 0.7)'
      },
      dark: {
        backgroundColor: 'rgba(22, 163, 74, 0.25)',
        border: '1px solid rgba(74, 222, 128, 0.45)'
      },
      borderRadius: '4px',
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
  }

  if (!errorColumnDecoration) {
    errorColumnDecoration = vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: 'rgba(187, 247, 208, 0.95)',
        border: '1px solid rgba(21, 128, 61, 0.6)'
      },
      dark: {
        backgroundColor: 'rgba(34, 197, 94, 0.55)',
        border: '1px solid rgba(187, 247, 208, 0.6)'
      },
      borderRadius: '3px'
    });
  }

  if (!errorPointerDecoration) {
    errorPointerDecoration = vscode.window.createTextEditorDecorationType({});
  }

  if (!syntaxBannerDecoration) {
    syntaxBannerDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true
    });
  }

  if (errorLineDecoration) {
    context.subscriptions.push(errorLineDecoration);
  }

  if (errorColumnDecoration) {
    context.subscriptions.push(errorColumnDecoration);
  }

  if (errorPointerDecoration) {
    context.subscriptions.push(errorPointerDecoration);
  }

  if (syntaxBannerDecoration) {
    context.subscriptions.push(syntaxBannerDecoration);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((activeEditor) => {
      const lineDecoration = errorLineDecoration;
      const columnDecoration = errorColumnDecoration;
      const pointerDecoration = errorPointerDecoration;
      const bannerDecoration = syntaxBannerDecoration;
      const state = lastHighlightState;
      if (!activeEditor || !state) {
        return;
      }

      if (activeEditor.document.uri.toString() !== state.uri.toString()) {
        return;
      }

      if (lineDecoration) {
        activeEditor.setDecorations(lineDecoration, [state.lineRange]);
      }

      if (columnDecoration) {
        const columnData = state.columnRange ? [state.columnRange] : [];
        activeEditor.setDecorations(columnDecoration, columnData);
      }

      if (pointerDecoration) {
        const pointerData = state.pointerOption ? [state.pointerOption] : [];
        activeEditor.setDecorations(pointerDecoration, pointerData);
      }
      if (bannerDecoration) {
        if (state.syntaxBannerRange && state.syntaxBannerMessage) {
          applySyntaxBanner(activeEditor, state.syntaxBannerRange, state.syntaxBannerMessage);
        } else {
          activeEditor.setDecorations(bannerDecoration, []);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!lastHighlightState) {
        return;
      }
      if (event.document.uri.toString() !== lastHighlightState.uri.toString()) {
        return;
      }
      if (
        activeHighlightDocumentVersion !== null &&
        event.document.version === activeHighlightDocumentVersion
      ) {
        return;
      }
      clearVisualErrorIndicators();
    })
  );
}

export function deactivate() {
  clearVisualErrorIndicators();
}
