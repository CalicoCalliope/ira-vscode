import { spawn } from "child_process";
import os from "os";
import path from "path";

// ===== Configuration =====
const VM_HOST = "172.23.78.42";       // Replace with your VM IP for evaluation
const VM_USER = "ubuntu";             // VM username
const LOCAL_PORT = 3000;              // Port on local machine
const REMOTE_PORT = 3000;             // Port on VM to forward
const PRIVATE_KEY_PATH = path.join(__dirname, "eval_id_rsa"); // Path to bundled private key

// ===== Start SSH tunnel =====
export function startSSHTunnel() {
  // Build SSH command args
  const args = [
    "-N", // Do not execute remote command
    "-L", `${LOCAL_PORT}:localhost:${REMOTE_PORT}`,
    `${VM_USER}@${VM_HOST}`,
    "-i", PRIVATE_KEY_PATH,
  ];

  // Windows-specific: use 'ssh.exe' from PATH
  const sshCommand = os.platform() === "win32" ? "ssh.exe" : "ssh";

  const sshProcess = spawn(sshCommand, args, {
    detached: true, // allow process to run independently
    stdio: "ignore" // hide output
  });

  sshProcess.unref(); // detach from parent process so it keeps running

  sshProcess.on("error", (err) => {
    console.error("Failed to start SSH tunnel:", err.message);
  });

  console.log(`SSH tunnel started: localhost:${LOCAL_PORT} -> ${VM_HOST}:${REMOTE_PORT}`);
  return sshProcess;
}