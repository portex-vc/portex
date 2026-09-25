/** Fictional product copy for the local demo; no performance claims describe live companies. */
export const PROJECTS = {
  PING: {
    name: 'Pinger', valuation: 600_000, monogram: 'Pi', color: '2F4A6B',
    tagline: 'Uptime agents that page you before your users do',
    description: 'Pinger watches contracts, oracles and APIs from five regions. Its agents compare failures, group related alerts and attach a runbook so a small team can respond without sorting through hundreds of pages.',
    website: 'https://pinger.example.dev', twitter: 'https://x.com/pingeragents',
    updates: [
      ['Five-region watcher network is live', 'Regional probes now compare results before opening an incident. The first pilot covers RPC endpoints, oracle updates and scheduled jobs.'],
      ['Runbook links added to alerts', 'Each incident now includes the last deploy and an editable runbook. We are testing quiet hours with three infrastructure teams.'],
    ],
    feedback: ['Caught a stalled oracle update in our staging environment. The alert included the failing check and a useful runbook link.', 'Regional comparisons cut the duplicate pages during our failover drill. I would like longer alert retention.'],
  },
  REYE: {
    name: 'RelayEye', valuation: 480_000, monogram: 'RE', color: '8A542E',
    tagline: 'Cross-chain MEV alerts with a transaction trail',
    description: 'RelayEye follows transaction bundles across bridges and sequencers to help teams investigate suspicious execution. Its agents collect the transaction trail behind each alert so an operator can reproduce the finding.',
    website: 'https://relayeye.example.dev', twitter: 'https://x.com/relayeye',
    updates: [
      ['Bridge bundle tracing shipped', 'The pilot traces bundles across two test bridges. Each alert links the source bundle, bridge message and destination execution.'],
      ['Funding review in progress', 'The analyst found shared funding sources among early backers and placed a temporary delay on this raise. We have published the pilot traces while the team reviews those relationships.'],
    ],
    feedback: ['Reproduced the sandwich trace from the sample transactions. The receipts make it easier to check an alert independently.', 'Bridge coverage is still narrow. I want to see traces from another sequencer before expanding our trial.'],
  },
  QORM: {
    name: 'Quorum', valuation: 420_000, monogram: 'Q', color: '5550A5',
    tagline: 'Five code reviewers, one focused review',
    description: 'Quorum runs specialist AI reviewers for security, concurrency, tests, performance and maintainability on each pull request. It compares their findings and brings the supporting code to the reviewer, keeping speculative comments out of the main thread.',
    website: 'https://quorum.example.dev', twitter: 'https://x.com/quorumreviews',
    updates: [
      ['Consensus review available to pilot teams', 'The five reviewers now share evidence before publishing a finding. Pilot teams can inspect disagreements in a separate review panel.'],
      ['Generated files can be excluded', 'Repository rules now exclude generated code and vendor directories. We also added per-review timing so teams can track large pull requests.'],
    ],
    feedback: ['Found a race in our job retry handler and pointed to both conflicting writes. The disagreement panel was more useful than another confidence score.', 'Good signal on backend changes. Reviews of generated clients still need tighter filtering.'],
  },
  FORGE: {
    name: 'BenchmarkForge', valuation: 300_000, monogram: 'BF', color: '8C4147',
    tagline: 'Adversarial tests for agents before customers find the gaps',
    description: 'BenchmarkForge generates difficult tasks from an agent application’s tools and failure logs. Teams can replay failures against each release and compare the evidence before expanding what an agent is allowed to do.',
    website: 'https://benchmarkforge.example.dev', twitter: 'https://x.com/benchforge',
    updates: [
      ['Evaluation dataset budget executed', 'Backers voted to release 3,000 USDG for the adversarial task dataset. The Budget Launch applied the corresponding proportional reduction to remaining principal claims.'],
      ['Replay bundles added to the pilot', 'Each failed task now exports the tool calls, fixture inputs and scoring notes. The next dataset focuses on ambiguous customer support requests.'],
    ],
    feedback: ['Replayed a tool permission failure that our normal tests missed. I voted for the dataset budget after reviewing the sample tasks.', 'The exported fixtures work in our CI job. Scoring explanations need more detail for partially correct answers.'],
  },
  DOCK: {
    name: 'Dockminder', valuation: 360_000, monogram: 'D', color: '346887',
    tagline: 'Incident response agents that follow your runbooks',
    description: 'Dockminder connects container logs, metrics and deployment changes into a single incident timeline. It proposes rollback, scaling and isolation steps under a policy that keeps production actions subject to human approval.',
    website: 'https://dockminder.example.dev', twitter: 'https://x.com/dockminder',
    updates: [
      ['Staging incident drills completed', 'The pilot completed rollback and isolation drills across three container services. Every production action still requires the operator approval defined in the runbook.'],
      ['Series A buffer has ended', 'The raise is ready for its listing transaction. Cost exits remain available until listing succeeds; open-market trading then carries market risk.'],
    ],
    feedback: ['Connected our failed deploy to a configuration change within the incident timeline. The rollback approval showed exactly which services would restart.', 'Useful during a staging drill. We still need support for our custom health checks.'],
  },
  CART: {
    name: 'Cartographer', valuation: 300_000, monogram: 'C', color: '426444',
    tagline: 'A living dependency map of your protocol risk',
    description: 'Cartographer maps the contracts, price feeds and bridges that a protocol depends on. Its agents simulate failure paths and keep the evidence attached to each dependency so teams can review changing exposure.',
    website: 'https://cartographer.example.dev', twitter: 'https://x.com/cartographerai',
    updates: [
      ['Dependency simulator released', 'The pilot now follows dependencies through lending markets and shared oracle feeds. Teams can replay an oracle outage against a saved graph.'],
      ['Open-market listing completed', 'Listing is complete and an original holder has claimed the first Diamond Hand allocation. The allocation follows token holding rules; open-market prices can rise or fall.'],
    ],
    feedback: ['The graph exposed an indirect oracle dependency we had missed in our integration checklist. Saved scenarios make the review reproducible.', 'Helpful for incident planning. Some smaller protocols still require manual dependency labels.'],
  },
  VAPR: {
    name: 'VaporMind', valuation: 240_000, monogram: 'VM', color: '716877',
    tagline: 'Trading hypotheses with a record of what actually happened',
    description: 'VaporMind turns market research into trading hypotheses and tracks each one against live observations. The pilot did not reproduce its backtest results. The project did not graduate and was dissolved; the team plans to return with a revised version.',
    website: 'https://vapormind.example.dev', twitter: 'https://x.com/vapormind',
    updates: [
      ['Live signal trial completed', 'The trial recorded forecasts before outcomes were known. Live results fell short of the backtest, and Stage 1 closed without meeting its graduation conditions.'],
      ['Project dissolved', "Every backer's deposit is set aside at its original cost. Four backers have not yet claimed it or rolled it into another project."],
    ],
    feedback: ['The live trial was much less convincing than the backtest. I appreciate being able to review the original forecasts before taking my capital back.', 'The forecast log is readable, but the signals did not help our paper trading trial.'],
  },
} as const;
export type DemoSymbol = keyof typeof PROJECTS;
