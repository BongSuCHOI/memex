import fs from 'fs';
import { analyzeHistory, formatAnalysisMarkdown } from './analyze.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: memex analyze [options]

Analyze the ENTIRE indexed conversation history and print an organized
report: coverage (extraction/summaries), fact breakdowns, knowledge
domains, per-project rollups, monthly activity, and backfill
recommendations. Read-only — never modifies the database.

OPTIONS:
  --json            Output the raw report as JSON instead of Markdown
  --out <file>      Write the report to a file instead of stdout
  --top <n>         Number of projects in the rollup (default: 15)
  --months <n>      Number of months in the activity timeline (default: 12)

EXAMPLES:
  # Markdown report to stdout
  memex analyze

  # JSON for scripting
  memex analyze --json

  # Save full report with top 30 projects
  memex analyze --top 30 --out ~/conversation-report.md
`);
  process.exit(0);
}

function intFlag(name: string, fallback: number): number {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const parsed = parseInt(args[idx + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function strFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

const asJson = args.includes('--json');
const outFile = strFlag('--out');
const topProjects = intFlag('--top', 15);
const timelineMonths = intFlag('--months', 12);

analyzeHistory({ topProjects, timelineMonths })
  .then(report => {
    const output = asJson ? JSON.stringify(report, null, 2) : formatAnalysisMarkdown(report);
    if (outFile) {
      fs.writeFileSync(outFile, output, 'utf-8');
      console.log(`Report written to ${outFile}`);
    } else {
      console.log(output);
    }
  })
  .catch(error => {
    console.error('Error analyzing history:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
