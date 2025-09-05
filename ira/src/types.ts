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