import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import * as path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logPemToCoordinator } from "./coordinator-service";

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
  answer?: string;
  context?: string;
  initialMessage?: string;
}

// ---------------------- CONFIG ----------------------
const COORDINATOR_URL = 'http://YOUR_VM_IP:PORT';

// ---------------------- HELPER FUNCTIONS ----------------------
async function getEnvInfo(): Promise<{ pythonVersion?: string; packages?: any[] }> {
  return new Promise((resolve) => {
    exec('python --version', (err, stdout) => {
      const pythonVersion = stdout?.trim();
      exec('pip list --format=json', (err2, stdout2) => {
        let packages: any[] = [];
        try {
          if (stdout2?.trim()){
            packages = JSON.parse(stdout2);
          }
        } catch {}
        resolve({ pythonVersion, packages });
      });
    });
  });
}

function extractPemType(errorMessage: string): string {
  const match = errorMessage.match(/([a-zA-Z]+Error)/);
  return match ? match[1] : 'UnknownError';
}

function getPemSkeletonFromPython(pem: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'pem_parser.py');
    const python = spawn('python', [scriptPath]);

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

function createLLMPanel(title: string, content: string) {
  const panel = vscode.window.createWebviewPanel(
    'pemLLM',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  panel.webview.html = `
    <html>
      <body>
        <h2>${title}</h2>
        <pre>${content}</pre>
      </body>
    </html>
  `;
}

function getHraWebviewHtml(state: WebviewState) {
  const { stage, isFirstOccurrence, hint, reasoning, answer, context, initialMessage } = state;

  let content = '';
  let buttons = '';

  switch (stage) {
    case 'initial':
      content = initialMessage + (context && !isFirstOccurrence ? `<pre>${context}</pre>` : '');
      buttons = `
        <button onclick="sendMessage('nextStage', { stage: 'hint', isFirstOccurrence: ${isFirstOccurrence}, hint: '${hint}', reasoning: '${reasoning}', answer: '${answer}' })">Yes</button>
        <button onclick="sendMessage('close')">No</button>
      `;
      break;
    case 'hint':
      content = `<b>Hint:</b> ${hint}`;
      buttons = `
        <button onclick="sendMessage('nextStage', { stage: 'reasoning', isFirstOccurrence: ${isFirstOccurrence}, hint: '${hint}', reasoning: '${reasoning}', answer: '${answer}' })">Show More</button>
        <button onclick="sendMessage('close')">Got It</button>
      `;
      break;
    case 'reasoning':
      content = `<b>Reasoning:</b> ${reasoning}`;
      buttons = `
        <button onclick="sendMessage('nextStage', { stage: 'answer', isFirstOccurrence: ${isFirstOccurrence}, hint: '${hint}', reasoning: '${reasoning}', answer: '${answer}' })">Show More</button>
        <button onclick="sendMessage('close')">Got It</button>
      `;
      break;
    case 'answer':
      content = `<b>Answer:</b> ${answer}`;
      buttons = `<button onclick="sendMessage('close')">Got It</button>`;
      break;
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>HRA Panel</title>
    </head>
    <body>
      <div>${content}</div>
      <div style="margin-top: 15px;">${buttons}</div>

      <script>
        const vscode = acquireVsCodeApi();
        function sendMessage(command, data = {}) {
          vscode.postMessage({ command, data });
        }
      </script>
    </body>
    </html>
  `;
}

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

  const initialMessage = isFirstOccurrence
    ? 'Need any help with the error?'
    : 'Hey, we have seen this before! Here is what happened:';

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

  const code = editor.document.getText();

  exec(`python "${filePath}"`, async (error, stdout, stderr) => {
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
        'PEM Assistant',
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
  // Register the "Run with Ira" command
  const runAndCaptureErrors = vscode.commands.registerCommand('ira.runWithIra', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Open a Python file to run.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const language = editor.document.languageId;

    runCodeWithIra(filePath, language);
  });

  context.subscriptions.push(runAndCaptureErrors);

  // Create a status bar button (bottom-left) for "Run with Ira"
  const runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runButton.command = 'ira.runWithIra'; // must match the command registered above
  runButton.text = '▶ Run with Ira';
  runButton.tooltip = 'Run current Python file and capture runtime errors';
  runButton.show();

  context.subscriptions.push(runButton);
}

export function deactivate() {}