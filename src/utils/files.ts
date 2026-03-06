// File utilities for report output

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import tmp from "tmp";

// Enable automatic cleanup on process exit
tmp.setGracefulCleanup();

// Lazy temp directory — only created on first writeReport() call
let reportsDir: string | null = null;

function getReportsDir(): string {
  if (!reportsDir) {
    const envDir = process.env.QBO_REPORTS_DIR;
    if (envDir) {
      if (!existsSync(envDir)) {
        mkdirSync(envDir, { recursive: true });
      }
      reportsDir = envDir;
    } else {
      const tmpDir = tmp.dirSync({ prefix: "qb-reports-", unsafeCleanup: true });
      reportsDir = tmpDir.name;
    }
  }
  return reportsDir;
}

// Handle signals for graceful cleanup
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

export function writeReport(reportType: string, data: unknown): string {
  const dir = getReportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${reportType}-${timestamp}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}
