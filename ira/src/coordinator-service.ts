// import * as vscode from 'vscode';
// import axios from 'axios';
// import { PemLogEntry } from './types';

// /**
//  * Sends a full PemLogEntry to the coordinator backend.
//  */
// export async function logPemToCoordinator(entry: PemLogEntry) {
//   const config = vscode.workspace.getConfiguration('ira');
//   const endpoint: string = config.get('coordinatorEndpoint', 'http://localhost:5000');
//   const apiKey: string = config.get('apiKey', '');

//   try {
//     const response = await axios.post(
//       `${endpoint}/log-error`,
//       entry,
//       {
//         headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
//         timeout: 8000,
//       }
//     );

//     console.log('[IRA] Logged PEM successfully:', response.data);
//     return response.data;

//   } catch (err: any) {
//     const msg = err.response?.data?.message || err.message || 'Unknown error';
//     vscode.window.showErrorMessage(`[IRA] Failed to log PEM: ${msg}`);
//     console.error('[IRA] Coordinator request failed:', err);
//     return null;
//   }
// }

import { PemLogEntry } from './types';

/**
 * Mock coordinator function for local testing.
 * Simulates backend response.
 */
export async function logPemToCoordinator(entry: PemLogEntry) {
  console.log('[MOCK] Logging PEM to coordinator:', entry);

  // Simulate first or repeated occurrence randomly
  const isFirstOccurrence = Math.random() > 0.5;

  return {
    isFirstOccurrence,
    hint: 'This is a mock hint for testing.',
    reasoning: 'This is a mock reasoning explanation.',
    answer: 'This is a mock answer solution.',
    context: isFirstOccurrence ? undefined : 'Mock previous error context.'
  };
}
