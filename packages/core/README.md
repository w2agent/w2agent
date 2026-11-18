# @w2agent/core

The audit engine, generators and platform adapters behind the [`w2agent`](https://www.npmjs.com/package/w2agent) CLI. Use it to audit a site for AI-agent readiness or generate agent-readiness files from your own code.

Most users want the CLI instead.

## Install

```bash
npm install @w2agent/core
```

## Use

```typescript
import { runAudit, runGenerate } from "@w2agent/core";

const report = await runAudit("https://example.com");
console.log(report.overallScore, report.grade);

const result = await runGenerate("https://example.com", { maxPages: 20 });
for (const file of result.files) {
  console.log(file.filename, file.size);
}
```

Generation reference: [docs/GENERATE.md](https://github.com/w2agent/w2agent/blob/main/docs/GENERATE.md). Scoring rubric: [docs/CHECKS.md](https://github.com/w2agent/w2agent/blob/main/docs/CHECKS.md).

Source: https://github.com/w2agent/w2agent

MIT License.
