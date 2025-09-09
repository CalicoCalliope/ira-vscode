import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import * as path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logPemToCoordinator } from "./coordinator-service";
import { startSSHTunnel } from './ssh-tunnel';

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
  initialMessage?: string;
}

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
  `No stress. We'll go one tiny step at a time 🧩`
];

const SEEN_BEFORE_MESSAGES: string[] = [
  `Hey, we've seen this before. Want a quick refresh? 🔁`,
  `Welcome back. Familiar error. Shall we try the fast path? 🚀`,
  `Good news, this one has a known fix. Want the recap? 📘`,
  `Deja vu! Let's apply what worked last time ✅`,
  `We recognize this pattern. Want the shortcut summary? 🎯`,
  `Same vibes as earlier. Want a guided reminder? 🧭`
];

function friendlyIntro(isFirst: boolean): string {
  const arr = isFirst ? FIRST_TIME_MESSAGES : SEEN_BEFORE_MESSAGES;
  return arr[Math.floor(Math.random() * arr.length)];
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
function getHraWebviewHtml(state: WebviewState) {
  const { stage, isFirstOccurrence, hint, reasoning, answer, context, initialMessage } = state;

  let content = '';
  let buttons = '';

  console.log('Coordinator raw response:', answer);

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

  // Generate content and buttons per stage
  switch (stage) {
    case 'initial':
      content = escapeHtml(initialMessage) + (context && !isFirstOccurrence ? `<pre class="context">${escapeHtml(context)}</pre>` : '');
      buttons = `
        ${createButton("Yes, I am lost. Show me please 😬", { stage: "hint", isFirstOccurrence, hint, reasoning, answer }, "primary")}
        ${createButton("Hmmmm. Walk me through step by step 🧭", { stage: "reasoning", isFirstOccurrence, hint, reasoning, answer })}
        ${createButton("I can do this! I do not need help right now 💪")}
      `;
      break;
    case 'hint':
      content = `<h3>Hint</h3><p>${escapeHtml(hint)}</p>`;
      buttons = `
        ${createButton("Give me a bit more 🔎", { stage: "reasoning", isFirstOccurrence, hint, reasoning, answer })}
        ${createButton("Actually, show me a fix ✅", { stage: "answer", isFirstOccurrence, hint, reasoning, answer }, "primary")}
        ${createButton("Okay, I got it 👍")}
      `;
      break;
    case 'reasoning':
      content = `<h3>Reasoning</h3><p>${escapeHtml(reasoning)}</p>`;
      buttons = `
        ${createButton("Show me a fix ✅", { stage: "answer", isFirstOccurrence, hint, reasoning, answer }, "primary")}
        ${createButton("Back to the hint 🔙", { stage: "hint", isFirstOccurrence, hint, reasoning, answer })}
        ${createButton("I want to try this myself ✨")}
      `;
      break;
    case 'answer':
      content = `<h3>Fix</h3><p>${escapeHtml(answer)}</p>`;
      buttons = `
        ${createButton("Got it 👍")}
        ${createButton("Explain how it works 🧠", { stage: "reasoning", isFirstOccurrence, hint, reasoning, answer })}
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
          --btn-border: var(--vscode-contrastActiveBorder, var(--vscode-button-background));
          --btn-secondary-bg: var(--vscode-button-secondaryBackground, #2a2e3a);
          --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
          --input-bg: var(--vscode-input-background);
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; }
        .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
        h3 { margin: 0 0 8px; font-size: 14px; }
        p { margin: 0; white-space: pre-wrap; }
        .context { background: var(--input-bg); border: 1px solid var(--border); padding: 10px; border-radius: 8px; overflow: auto; max-height: 220px; margin-top: 8px; }
        .actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
        .btn { appearance: none; border: 1px solid var(--btn-border); background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); padding: 8px 12px; border-radius: 8px; cursor: pointer; user-select: none; transition: filter .12s ease, background .12s ease, transform .02s ease-in-out; }
        .btn:hover { filter: brightness(1.08); }
        .btn:active { transform: translateY(1px); }
        .btn.primary { background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg); }
        .btn.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="content">${content}</div>
        <div class="actions">${buttons}</div>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
        function sendMessage(command, data = {}) { vscode.postMessage({ command, data }); }

        // Helper to read payload from button data attribute
        function sendMessageFromButton(btn) {
          const payload = btn.getAttribute('data-payload');
          if (!payload) return;
          try {
            const data = JSON.parse(payload);
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
  context?: string
) {
  const panel = vscode.window.createWebviewPanel(
    'hraPanel',
    title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true
    }
  );

  const initialMessage = friendlyIntro(isFirstOccurrence);

  panel.webview.html = getHraWebviewHtml({
    stage: 'initial',
    isFirstOccurrence,
    hint,
    reasoning,
    answer,
    context,
    initialMessage
  });

  // Handle messages from the Webview
  panel.webview.onDidReceiveMessage(
    message => {
      switch (message.command) {
        case 'nextStage':
          panel.webview.html = getHraWebviewHtml({
            ...message.data
          });
          break;
        case 'close':
          panel.dispose();
          break;
      }
    },
    undefined
  );
}

// ---------------------- RUNTIME ERROR HANDLING ----------------------
function extractRuntimeError(stderr: string): string | null {
  const match = stderr.match(/Exception:.*|Error:.*|Traceback \(most recent call last\):/i);
  return match ? match[0] : null;
}

// ---------------------- RUN WITH IRA ----------------------
export async function runCodeWithIra(filePath: string, language: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor){
    return;
  }

  const py = await resolvePythonCmd();

  const code = editor.document.getText();

  exec(`${py} "${filePath}"`, async (error, stdout, stderr) => {
    if (stdout){
      console.log(`[stdout]: ${stdout}`);
    }

    if (stderr) {
      const pem = `[RUNTIME ERROR] ${stderr}`;
      const pemType = extractPemType(stderr);
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
      const coordinatorResponse = await logPemToCoordinator(pemLogEntry);

      // coordinatorResponse should include:
      // { isFirstOccurrence, hint, reasoning, answer, context? }

      createHraWebview(
        'IRA Guidance',
        coordinatorResponse.isFirstOccurrence,
        coordinatorResponse.hint,
        coordinatorResponse.reasoning,
        coordinatorResponse.answer,
        coordinatorResponse.context
      );

      vscode.window.showErrorMessage(`Runtime error (${pemType}) occurred. HRA panel opened.`);
    }
  });
}

// ---------------------- EXTENSION ACTIVATION ----------------------
export function activate(context: vscode.ExtensionContext) {
  // --- Start the SSH tunnel in the background ---
  try {
    startSSHTunnel();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to start SSH tunnel: ${errorMessage}`);
  }

  // Register the "Run with Ira" command
  const runAndCaptureErrors = vscode.commands.registerCommand('IRA.runPythonAndCaptureErrors', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Open a Python file to run.');
      return;
    }

    const py = await resolvePythonCmd();

    const filePath = editor.document.uri.fsPath;
    const language = editor.document.languageId;

    // Run in VS Code integrated terminal (normal user-facing behavior)
    const terminal = vscode.window.createTerminal('IRA Python');
    terminal.sendText(`${py} "${filePath}"`);
    terminal.show();

    runCodeWithIra(filePath, language);
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
}

export function deactivate() {}