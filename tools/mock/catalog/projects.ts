/**
 * Prepared AI-startup projects for testnet mock activity. Every name is invented; websites use the reserved
 * `.example` TLD. Copy is written as a builder would describe early work: specific, modest, no performance claims
 * about real companies.
 */
import type { CatalogProject, Category } from './types';

export const PROJECTS: CatalogProject[] = [
  {
    slug: 'veltmark',
    name: 'Veltmark',
    ticker: 'VELT',
    category: 'Evaluation & safety',
    template: 'ESCROW_LAUNCH',
    pitch: 'Behaviour regression suites for AI agents, run on every release',
    description: [
      'Veltmark turns an agent’s past incidents, support tickets and tool logs into replayable test cases. Each release runs against the suite before it ships, and the report shows which behaviours changed rather than whether an aggregate score moved.',
      'Teams write expectations in plain language and pin them to real traces. When a model or prompt update changes how the agent issues a refund or escalates a ticket, the diff points to the exact step where the behaviour diverged.',
      'The suite runs in the customer’s own CI. Nothing leaves their infrastructure unless they choose to share a report.',
    ],
    raise: 42_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Trace replay runs in CI',
        body: 'Replays now run as a CI step against a cached tool sandbox. Median suite time for our three pilot teams is under six minutes.',
      },
      {
        kind: 'update',
        title: 'Plain-language expectations',
        body: 'Expectations can be written as short sentences and are checked by a separate grader model. Each report includes the grader’s agreement rate with human reviewers.',
      },
      {
        kind: 'update',
        title: 'Aligned tool-call diffs',
        body: 'Reports now align tool calls across releases, so a changed argument or a skipped confirmation shows up as a single highlighted step.',
      },
    ],
  },
  {
    slug: 'silthaven',
    name: 'Silthaven',
    ticker: 'SLTH',
    category: 'Data infrastructure',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Versioned geoscience datasets that models can actually train on',
    description: [
      'Silthaven collects public well logs, core photos and seismic surveys and turns them into consistently labelled, versioned datasets. Every record keeps its source, licence and the transformations applied to it.',
      'Geoscience teams spend most of a modelling project cleaning inputs. Silthaven publishes the cleaning steps as code, so any dataset version can be rebuilt from the originals and audited line by line.',
      'Budget draws fund labelling work in fixed milestones. Each draw is tied to a named dataset release that backers can inspect before voting on the next one.',
    ],
    raise: 60_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Release 0.1: 4,100 labelled well logs',
        body: 'The first release covers well logs from three public archives, with lithology labels reviewed by two geologists. The rebuild script and licence manifest ship with it.',
      },
      {
        kind: 'update',
        title: 'Core photo pipeline',
        body: 'Core photos are now tiled, colour-corrected and matched to depth intervals. We found and documented 212 depth mismatches in the source archive.',
      },
    ],
  },
  {
    slug: 'mosswick',
    name: 'Mosswick',
    ticker: 'MSWK',
    category: 'Climate',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 3000,
    pitch: 'Forest carbon monitoring from satellite passes and field plots',
    description: [
      'Mosswick estimates above-ground biomass for small forestry projects by combining radar and optical satellite passes with a modest number of field plots. The aim is a monitoring report a verifier can reproduce, at a cost small landholders can carry.',
      'Each estimate ships with its uncertainty and the plots that constrain it. Where the satellite signal saturates in dense canopy, the report says so instead of extrapolating.',
      'Budget draws pay for field campaigns. Each campaign is proposed with its plot locations and published with the measurements once the crews return.',
    ],
    raise: 75_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Two community forests enrolled',
        body: 'The first two pilots cover 1,800 hectares. Field crews measured 64 plots, and the error on held-out plots is published in the report.',
      },
      {
        kind: 'update',
        title: 'Radar and optical fusion',
        body: 'Adding radar passes reduced error in dense canopy by roughly a third. Saturation above 250 tonnes per hectare remains, and the report flags those areas.',
      },
    ],
  },
  {
    slug: 'saltglass',
    name: 'Saltglass',
    ticker: 'SGLS',
    category: 'Inference & compute',
    template: 'ESCROW_LAUNCH',
    pitch: 'Private inference inside attested enclaves, with a receipt for every answer',
    description: [
      'Saltglass runs open-weight models inside hardware enclaves and returns a signed attestation with every response. A customer can check which model, which build and which hardware produced an answer without trusting the operator.',
      'The service is for teams handling medical notes, legal files or internal code who want hosted inference but cannot send plaintext to a shared cluster.',
      'Receipts are small, verifiable offline, and can be stored alongside the output they describe.',
    ],
    raise: 90_000,
    supply: 21_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Attested receipts in public preview',
        body: 'Every response now carries a receipt with the model hash, enclave measurement and timestamp. Verifier scripts are published for three languages.',
      },
      {
        kind: 'update',
        title: 'Throughput within 12% of plain hosting',
        body: 'After batching changes, enclave throughput on our reference model is within 12% of the same GPUs running without attestation.',
      },
    ],
  },
  {
    slug: 'fernwatch',
    name: 'Fernwatch',
    ticker: 'FRNW',
    category: 'Climate',
    template: 'ESCROW_LAUNCH',
    pitch: 'Early wildfire smoke detection from existing tower cameras',
    description: [
      'Fernwatch analyses video from the lookout and telecom tower cameras that already cover fire-prone valleys. When it sees a likely smoke plume it sends the frame, bearing and confidence to the dispatch team, who make the call.',
      'The system is tuned for few false alarms: a dispatcher paged for every low cloud stops trusting the pager. Every alert includes the preceding frames so a person can judge it in seconds.',
    ],
    raise: 36_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Dry-season pilot on 14 cameras',
        body: 'The pilot ran through the dry season on 14 cameras. Dispatchers confirmed 9 early detections and dismissed 31 alerts; both lists are published.',
      },
      {
        kind: 'update',
        title: 'Two-camera triangulation',
        body: 'When two cameras see the same plume, alerts now include an estimated location with an error ellipse.',
      },
    ],
  },
  {
    slug: 'quillmate',
    name: 'Quillmate',
    ticker: 'QLMT',
    category: 'Legal',
    template: 'ESCROW_LAUNCH',
    pitch: 'Clause-level drafting assistant for in-house counsel',
    description: [
      'Quillmate works inside the word processor lawyers already use. It suggests fallback language from the team’s own playbook, explains why a counterparty’s edit matters, and never rewrites a clause without showing the change.',
      'Playbooks are written by the legal team, not inferred. Quillmate cites the playbook entry behind every suggestion, so a reviewer can see whether it reflects policy or preference.',
    ],
    raise: 30_000,
    supply: 1_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Playbook import',
        body: 'Teams can import an existing playbook from a spreadsheet. Each entry becomes a rule with preferred, acceptable and walk-away positions.',
      },
      {
        kind: 'update',
        title: 'One-sentence redline summaries',
        body: 'Counterparty edits are summarised in one sentence each, with a link to the playbook position they move away from.',
      },
    ],
  },
  {
    slug: 'keelworks',
    name: 'Keelworks',
    ticker: 'KLWK',
    category: 'Logistics',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2000,
    pitch: 'Port-call scheduling agents for short-sea shipping',
    description: [
      'Keelworks coordinates berth windows, pilotage and cargo readiness for short-sea operators who still run port calls over email and phone. Its agents read the messages, propose a schedule and flag conflicts to a human planner.',
      'Planners approve every change. Keelworks keeps the reasoning behind each proposal, so a planner can see which constraint moved a vessel’s window.',
      'Budget draws fund integrations with individual port systems, one port at a time, each proposed with its expected scope.',
    ],
    raise: 54_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Two ports connected',
        body: 'Berth availability from two regional ports now flows into the planner view. Manual re-entry of berth windows dropped to zero for the pilot operator.',
      },
      {
        kind: 'update',
        title: 'Weather-aware windows',
        body: 'Proposed windows now account for forecast wind limits at the pilot boarding point, with the forecast source shown next to each change.',
      },
    ],
  },
  {
    slug: 'bramblecode',
    name: 'Bramblecode',
    ticker: 'BRMB',
    category: 'Developer tools',
    template: 'ESCROW_LAUNCH',
    pitch: 'Legacy code migration led by tests, not guesses',
    description: [
      'Bramblecode migrates old services, from COBOL batch jobs to unmaintained Python 2 scripts, by first capturing their behaviour as characterisation tests and then translating the code until every test passes.',
      'Engineers review the migration as a series of small pull requests. Anything the tests cannot pin down is listed as an open question instead of being silently rewritten.',
    ],
    raise: 48_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Characterisation test generator',
        body: 'The generator records inputs and outputs from a running service and turns them into readable tests. Pilot teams kept 81% of generated tests after review.',
      },
      {
        kind: 'update',
        title: 'First batch job migrated end to end',
        body: 'A nightly reconciliation job moved from COBOL to Java in 23 pull requests. Seven open questions were resolved by the team that owns the job.',
      },
    ],
  },
  {
    slug: 'pebblestack',
    name: 'Pebblestack',
    ticker: 'PBST',
    category: 'Inference & compute',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Spot GPU scheduling for small inference fleets',
    description: [
      'Pebblestack places inference workloads on spot and reserved GPUs across several providers and moves them before an interruption lands. Small teams get most of the savings of spot capacity without writing their own failover.',
      'Every placement decision is logged with the prices and interruption rates it used, so a team can check the scheduler’s reasoning against its bill.',
      'Budget draws fund provider integrations; each proposal names the provider and the regions it adds.',
    ],
    raise: 66_000,
    supply: 250_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Live migration between providers',
        body: 'Model replicas now migrate between two providers with a median gap of 40 seconds, served from a warm standby in the meantime.',
      },
      {
        kind: 'update',
        title: 'Interruption forecasts',
        body: 'The scheduler now forecasts interruption risk per zone from the last 30 days of notices and publishes the forecast next to each placement.',
      },
    ],
  },
  {
    slug: 'wickline',
    name: 'Wickline',
    ticker: 'WKLN',
    category: 'Security',
    template: 'ESCROW_LAUNCH',
    pitch: 'A prompt-injection firewall for tool-using agents',
    description: [
      'Wickline sits between an agent and its tools. It tracks where every piece of text came from, and blocks or asks for confirmation when untrusted content tries to trigger a sensitive action such as sending mail or moving money.',
      'Policies are short and readable: which tools are sensitive, which sources are trusted, and who approves exceptions. Every decision is logged with the text span that caused it.',
    ],
    raise: 57_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Provenance tracking for tool outputs',
        body: 'Text returned by web, mail and file tools is now labelled with its source through the whole agent loop, including summaries of summaries.',
      },
      {
        kind: 'update',
        title: 'Public red-team set',
        body: 'We published 420 injection attempts used in our tests, with the policy decision for each. Nineteen still pass and are listed as open issues.',
      },
    ],
  },
  {
    slug: 'quiverly',
    name: 'Quiverly',
    ticker: 'QVRL',
    category: 'Education',
    template: 'ESCROW_LAUNCH',
    pitch: 'Practice problems that explain the next step, not the answer',
    description: [
      'Quiverly gives secondary-school students practice problems in algebra and geometry and responds to each attempt with a hint about the next step. It does not reveal the final answer until the student has worked through the problem.',
      'Teachers see where a class gets stuck, grouped by the misconception behind the error rather than by question number.',
    ],
    raise: 24_000,
    supply: 1_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Classroom pilot in four schools',
        body: 'Eleven teachers used Quiverly for a term. Students attempted a median of 38 problems a week, and teachers reviewed the misconception report weekly.',
      },
      {
        kind: 'update',
        title: 'Hints checked by teachers',
        body: 'Every hint template was reviewed by two maths teachers. We removed 64 hints that gave away too much.',
      },
    ],
  },
  {
    slug: 'emberline',
    name: 'Emberline',
    ticker: 'EMBL',
    category: 'Health',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2000,
    pitch: 'Structured triage notes drafted from nurse-line calls',
    description: [
      'Emberline listens to nurse advice-line calls, with consent, and drafts a structured triage note: symptoms, duration, red flags asked about and the disposition given. The nurse edits and signs the note before it is filed.',
      'The draft never recommends a disposition on its own. It highlights red-flag questions that were not asked, so the nurse can follow up before the call ends.',
      'Budget draws fund clinical safety reviews for each new protocol set, published with the reviewer’s findings.',
    ],
    raise: 84_000,
    supply: 21_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Clinical safety review completed',
        body: 'An external clinical reviewer assessed the drafting for the first 40 protocols. Findings and our responses are published.',
      },
      {
        kind: 'update',
        title: 'Missed red-flag prompts',
        body: 'During the call, the nurse now sees a short list of red-flag questions not yet asked. Nurses in the pilot accepted the prompt about half the time.',
      },
    ],
  },
  {
    slug: 'sableworks',
    name: 'Sableworks',
    ticker: 'SBLW',
    category: 'Creative tools',
    template: 'ESCROW_LAUNCH',
    pitch: 'Storyboards that keep characters consistent from shot to shot',
    description: [
      'Sableworks helps small animation and advertising teams turn a script into rough storyboards. Characters, props and locations are defined once, and every panel reuses them, so a jacket does not change colour between shots.',
      'Artists stay in control: panels are starting points to draw over, and every generated element can be locked, replaced or removed.',
    ],
    raise: 33_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Character sheets',
        body: 'Teams can now define a character from three reference drawings. Consistency across a 40-panel board improved markedly in our internal review.',
      },
      {
        kind: 'update',
        title: 'Export to editing timelines',
        body: 'Boards export as an animatic with shot durations read from the script, ready to drop into common editing tools.',
      },
    ],
  },
  {
    slug: 'heronwise',
    name: 'Heronwise',
    ticker: 'HRNW',
    category: 'Science',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Lab agents that plan, schedule and log bench experiments',
    description: [
      'Heronwise turns a scientist’s experimental intent into a step-by-step protocol, checks it against the lab’s equipment and reagent stock, and schedules the instruments. Results are logged against the protocol version that produced them.',
      'The scientist approves every protocol before it runs. When a result looks off, the log shows exactly which lot, instrument and deviation were involved.',
      'Budget draws fund instrument integrations proposed one lab at a time.',
    ],
    raise: 72_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Plate reader and liquid handler connected',
        body: 'Protocols now run on a liquid handler and plate reader in our partner lab, with every transfer logged against its protocol step.',
      },
      {
        kind: 'update',
        title: 'Reagent lot tracking',
        body: 'Reagent lots are scanned at the bench and attached to results automatically, which removed most of the manual notebook entries.',
      },
    ],
  },
  {
    slug: 'cobaltine',
    name: 'Cobaltine',
    ticker: 'CBLT',
    category: 'Science',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 3000,
    pitch: 'Battery cathode screening with active learning',
    description: [
      'Cobaltine proposes cathode compositions to synthesise next, using a model that learns from every cell the partner lab builds. The goal is to reach a target cycle life with fewer synthesis rounds.',
      'Each proposal comes with the model’s expected result and uncertainty. After testing, the prediction and the measurement are published together, including the misses.',
      'Budget draws fund synthesis rounds at partner labs; each round is proposed with its candidate list.',
    ],
    raise: 120_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Round one: 24 compositions tested',
        body: 'The first round tested 24 compositions. Five reached the capacity-retention target at 200 cycles; the full table is published.',
      },
      {
        kind: 'update',
        title: 'Uncertainty calibration',
        body: 'Predicted intervals now cover the measured result in 78% of cases against a nominal 80%. We will keep reporting this every round.',
      },
    ],
  },
  {
    slug: 'tessary',
    name: 'Tessary',
    ticker: 'TSRY',
    category: 'Data infrastructure',
    template: 'ESCROW_LAUNCH',
    pitch: 'Synthetic tabular data with a privacy budget you can audit',
    description: [
      'Tessary generates synthetic versions of sensitive tables, such as claims, transactions or patient records, under a differential-privacy budget that is set by the data owner and recorded with every release.',
      'Each release includes a utility report comparing the synthetic data with the original on the queries the owner cares about, so analysts know which questions it can answer.',
    ],
    raise: 39_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Audit log for privacy budgets',
        body: 'Every generation run now writes its privacy parameters and spent budget to an append-only log the data owner controls.',
      },
      {
        kind: 'update',
        title: 'Utility reports on custom queries',
        body: 'Data owners can register their own benchmark queries. The report shows the error on each one next to the privacy budget spent.',
      },
    ],
  },
  {
    slug: 'loamtrace',
    name: 'Loamtrace',
    ticker: 'LMTR',
    category: 'Climate',
    template: 'ESCROW_LAUNCH',
    pitch: 'Soil health estimates from phone photos and local weather',
    description: [
      'Loamtrace gives smallholder farmers a rough soil-organic-matter estimate from a photo of a soil sample, a colour card and local weather history. It is meant to decide where a lab test is worth paying for, not to replace one.',
      'Estimates come with a range. When the photo is poor or the soil type is outside what the model has seen, the app asks for a lab sample instead.',
    ],
    raise: 27_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Calibration against 900 lab samples',
        body: 'The model was calibrated against 900 lab-tested samples from two regions. The published error bands are wider for clay soils, as expected.',
      },
      {
        kind: 'update',
        title: 'Works offline',
        body: 'The app now runs estimates on the phone and syncs when a connection returns, which matters for most of our pilot farmers.',
      },
    ],
  },
  {
    slug: 'gridwhistle',
    name: 'Gridwhistle',
    ticker: 'GRDW',
    category: 'Climate',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Demand-response agents for commercial buildings',
    description: [
      'Gridwhistle connects to a building’s management system and shifts flexible loads, such as pre-cooling, water heating and EV charging, when the grid asks for relief. Comfort limits are set by the facilities team and never crossed.',
      'After each event, the building gets a plain report: how much load moved, what it earned, and whether any limit came close.',
      'Budget draws fund integrations with building management systems, one vendor at a time.',
    ],
    raise: 96_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'First demand-response season',
        body: 'Six office buildings took part in 17 grid events. Average curtailment was 14% of load, with no comfort-limit breaches.',
      },
      {
        kind: 'update',
        title: 'Pre-cooling planner',
        body: 'The planner now starts pre-cooling based on the next day’s forecast and occupancy, instead of a fixed schedule.',
      },
    ],
  },
  {
    slug: 'tallyfern',
    name: 'Tallyfern',
    ticker: 'TLYF',
    category: 'Finance',
    template: 'ESCROW_LAUNCH',
    pitch: 'Month-end close agents for small finance teams',
    description: [
      'Tallyfern prepares the routine parts of a month-end close: bank reconciliations, accrual suggestions and variance explanations. Everything lands as a proposed journal entry with its supporting documents attached.',
      'Nothing posts to the ledger without a person approving it. Controllers can see which rule or document produced each proposal.',
    ],
    raise: 45_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Reconciliations for three banks',
        body: 'Bank feeds from three banks now reconcile automatically, with unmatched items grouped by likely cause.',
      },
      {
        kind: 'update',
        title: 'Variance explanations',
        body: 'Budget-versus-actual variances above a threshold get a draft explanation that cites the transactions behind it.',
      },
    ],
  },
  {
    slug: 'cairnpoint',
    name: 'Cairnpoint',
    ticker: 'CRNP',
    category: 'Robotics',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 3000,
    pitch: 'Inspection drones that write their own flight reports',
    description: [
      'Cairnpoint flies pre-planned inspection routes over solar farms and substations, flags defects such as hot spots, cracked panels and damaged insulators, and drafts the inspection report for a technician to confirm.',
      'Each finding links to the raw thermal and visual frames, the GPS position and the model’s confidence, so the technician can dismiss a false positive in seconds.',
      'Budget draws fund new airframe integrations and regulatory approvals, proposed per site type.',
    ],
    raise: 108_000,
    supply: 21_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Solar farm inspections in production',
        body: 'Two operators now use Cairnpoint for monthly solar inspections. Technicians confirmed 91% of flagged hot spots.',
      },
      {
        kind: 'update',
        title: 'Substation route planner',
        body: 'The planner now keeps the required clearance around live equipment and shows it on the route before flight.',
      },
    ],
  },
  {
    slug: 'kitefin',
    name: 'Kitefin',
    ticker: 'KTFN',
    category: 'Robotics',
    template: 'ESCROW_LAUNCH',
    pitch: 'Hull inspection with a tethered underwater robot and a vision model',
    description: [
      'Kitefin inspects ship hulls in port with a small tethered robot, replacing much of the diver time a routine inspection needs. A vision model maps fouling, coating damage and anodes, and the surveyor reviews the map.',
      'The output is a hull map the surveyor can annotate and sign, with every mark linked to the underlying video.',
    ],
    raise: 63_000,
    supply: 21_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'First class-observed inspection',
        body: 'A classification surveyor observed a full inspection of a bulk carrier. The annotated hull map was accepted as supporting evidence.',
      },
      {
        kind: 'update',
        title: 'Low-visibility mode',
        body: 'In turbid water the robot now slows down and switches to sonar-assisted positioning, which kept the hull map continuous in our last two dives.',
      },
    ],
  },
  {
    slug: 'umberline',
    name: 'Umberline',
    ticker: 'UMBR',
    category: 'Creative tools',
    template: 'ESCROW_LAUNCH',
    pitch: 'A colour-grading assistant that learns a studio’s look',
    description: [
      'Umberline learns a post-production studio’s grading style from its past projects and proposes a first-pass grade for new footage. Colourists refine from there instead of starting from a flat image.',
      'Proposed grades are ordinary node trees in the colourist’s own software, so nothing is hidden inside a model.',
    ],
    raise: 21_000,
    supply: 1_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Node-tree export',
        body: 'Grades now export as editable node trees. Colourists in the pilot kept the proposed structure on most shots and adjusted the values.',
      },
      {
        kind: 'update',
        title: 'Shot matching',
        body: 'The assistant now matches grades across cameras within a scene before proposing the look.',
      },
    ],
  },
  {
    slug: 'tillgate',
    name: 'Tillgate',
    ticker: 'TLGT',
    category: 'Data infrastructure',
    template: 'ESCROW_LAUNCH',
    pitch: 'A vector index with time travel for audit-ready retrieval',
    description: [
      'Tillgate is a vector index that keeps every version of every document. A retrieval-augmented answer can be replayed later against the exact index state that produced it, which auditors and regulated teams increasingly ask for.',
      'Deletions are honoured for new queries while the audit trail records that a document existed and when it was removed.',
    ],
    raise: 51_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Point-in-time queries',
        body: 'Any query can now be run as of a past timestamp. Storage overhead for a year of daily changes stayed under 30% in our benchmark corpus.',
      },
      {
        kind: 'update',
        title: 'Deletion receipts',
        body: 'Deleting a document returns a receipt that records what was removed and when, without keeping the content.',
      },
    ],
  },
  {
    slug: 'weftline',
    name: 'Weftline',
    ticker: 'WFTL',
    category: 'Logistics',
    template: 'ESCROW_LAUNCH',
    pitch: 'Fabric defect detection on the cutting table',
    description: [
      'Weftline mounts a camera above garment factory cutting tables and flags weaving defects, stains and shade variation before the fabric is cut. Operators mark each flag as real or not with one tap.',
      'The system learns each factory’s fabrics over the first weeks. Defect rates per roll are reported back to the mill with photos.',
    ],
    raise: 30_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Running on six cutting tables',
        body: 'Two factories run Weftline on six tables. Operators confirmed 83% of flags in the last month.',
      },
      {
        kind: 'update',
        title: 'Roll reports for mills',
        body: 'Each roll now gets a defect report with photos and positions, which one mill has started using to adjust its looms.',
      },
    ],
  },
  {
    slug: 'nimbleweave',
    name: 'Nimbleweave',
    ticker: 'NMBL',
    category: 'Agents',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2000,
    pitch: 'Browser agents for back-office forms, with human sign-off',
    description: [
      'Nimbleweave automates repetitive back-office work in web portals that have no API: supplier onboarding, insurance claims, permit applications. An agent fills the forms from source documents and stops before submitting.',
      'A person reviews a side-by-side view of the document and the filled form and approves the submission. Every field records where its value came from.',
      'Budget draws fund portal-specific reliability work, proposed with the portals they cover.',
    ],
    raise: 69_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Supplier onboarding in production',
        body: 'One distributor now onboards suppliers through Nimbleweave across four portals. Reviewers approve most submissions without edits.',
      },
      {
        kind: 'update',
        title: 'Field provenance view',
        body: 'Each field now shows the document excerpt its value came from, which roughly halved review time in the pilot.',
      },
      {
        kind: 'update',
        title: 'Portal change detection',
        body: 'When a portal changes its layout, the agent pauses and asks for a new walkthrough instead of guessing.',
      },
    ],
  },
  {
    slug: 'arbelo',
    name: 'Arbelo',
    ticker: 'ARBL',
    category: 'Legal',
    template: 'ESCROW_LAUNCH',
    pitch: 'Obligation tracking from signed contracts',
    description: [
      'Arbelo reads signed contracts and extracts dated obligations: renewal notices, reporting duties, price reviews, audit rights. Each obligation becomes a calendar item with the clause attached.',
      'A contract manager confirms every extracted obligation before it is tracked, and the confirmation is kept with the record.',
    ],
    raise: 36_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Renewal notices tracked for 1,200 contracts',
        body: 'Our first customer loaded 1,200 supplier contracts. Contract managers confirmed 3,400 obligations in the first month.',
      },
      {
        kind: 'update',
        title: 'Amendment chains',
        body: 'Amendments are now linked to the contracts they change, and the obligation calendar reflects the latest amended terms.',
      },
    ],
  },
  {
    slug: 'stilbe',
    name: 'Stilbe',
    ticker: 'STLB',
    category: 'Health',
    template: 'ESCROW_LAUNCH',
    pitch: 'A fitting assistant for audiologists',
    description: [
      'Stilbe suggests hearing-aid fitting adjustments from a patient’s audiogram, their descriptions of problem situations and the device’s logs. The audiologist reviews every suggestion before it reaches the device.',
      'Patients can describe problems in their own words between appointments, and the audiologist sees a structured summary at the next visit.',
    ],
    raise: 42_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Pilot in three clinics',
        body: 'Nine audiologists used Stilbe for follow-up fittings. They accepted about two thirds of suggested adjustments, usually with small changes.',
      },
      {
        kind: 'update',
        title: 'Patient diary',
        body: 'Patients can now log difficult listening situations by voice. The clinic sees them grouped by situation type.',
      },
    ],
  },
  {
    slug: 'querystone',
    name: 'Querystone',
    ticker: 'QRYS',
    category: 'Developer tools',
    template: 'ESCROW_LAUNCH',
    pitch: 'Database query review before it reaches production',
    description: [
      'Querystone reviews the SQL in every pull request against a snapshot of the production schema and statistics. It flags missing indexes, unbounded scans and migrations that will lock busy tables.',
      'Findings come with the estimated plan and the table sizes behind it, so a reviewer can judge the risk without running anything.',
    ],
    raise: 39_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Migration lock analysis',
        body: 'Schema migrations are now checked for the locks they take and how long similar migrations held them on the same tables.',
      },
      {
        kind: 'update',
        title: 'ORM query extraction',
        body: 'Queries generated by two common ORMs are now extracted from the code and reviewed like hand-written SQL.',
      },
    ],
  },
  {
    slug: 'latchwell',
    name: 'Latchwell',
    ticker: 'LTCH',
    category: 'Security',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Access reviews that explain every permission',
    description: [
      'Latchwell prepares quarterly access reviews by explaining each permission in plain language: what it allows, when it was last used and who granted it. Reviewers approve or revoke with the context in front of them.',
      'Unused and risky permissions are listed first. Every decision is recorded for the auditor, with the explanation the reviewer saw.',
      'Budget draws fund connectors to identity and cloud providers, proposed with the systems they cover.',
    ],
    raise: 78_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'First audited access review',
        body: 'A customer completed its quarterly review in Latchwell and passed its audit with the exported evidence pack.',
      },
      {
        kind: 'update',
        title: 'Last-used data for cloud roles',
        body: 'Cloud roles now show when each permission was last exercised, which surfaced a large set of unused administrator grants in the pilot.',
      },
    ],
  },
  {
    slug: 'harrowline',
    name: 'Harrowline',
    ticker: 'HRWL',
    category: 'Robotics',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 3000,
    pitch: 'Weed maps for precision sprayers',
    description: [
      'Harrowline builds weed maps from drone flights early in the season and converts them into prescription files that existing precision sprayers can read. Farmers spray the patches, not the whole field.',
      'Each map shows detection confidence by zone. Low-confidence zones default to normal spraying, so a missed patch never becomes an uncontrolled one.',
      'Budget draws fund crop-specific model training, proposed per crop with the field trials planned.',
    ],
    raise: 90_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Two seasons of maize trials',
        body: 'Across 38 fields, sprayed area fell by 41% on average. Yields in trial strips matched the control strips within measurement error.',
      },
      {
        kind: 'update',
        title: 'Prescription export',
        body: 'Maps now export to the prescription formats used by three sprayer makers.',
      },
    ],
  },
  {
    slug: 'orrinet',
    name: 'Orrinet',
    ticker: 'ORNT',
    category: 'Agents',
    template: 'ESCROW_LAUNCH',
    pitch: 'Meeting follow-ups that file the tickets for you',
    description: [
      'Orrinet turns meeting notes into follow-up work: tickets in the tracker, owners assigned, due dates proposed. The meeting organiser reviews the list in one screen before anything is filed.',
      'Each ticket links back to the moment in the notes where it was agreed, so nobody has to remember who said what.',
    ],
    raise: 27_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Tracker integrations',
        body: 'Follow-ups can now be filed in two popular issue trackers, with owners matched from the attendee list.',
      },
      {
        kind: 'update',
        title: 'Decision log',
        body: 'Decisions are now captured separately from tasks and collected in a searchable log per team.',
      },
    ],
  },
  {
    slug: 'vitreous',
    name: 'Vitreous Labs',
    ticker: 'VITR',
    category: 'Evaluation & safety',
    template: 'ESCROW_LAUNCH',
    pitch: 'Interpretability probes packaged for model audits',
    description: [
      'Vitreous Labs packages interpretability techniques, such as linear probes, activation patching and feature attribution, into repeatable audit checks for open-weight models.',
      'An audit report states what each check measures, how it was run and what it cannot show. The code and random seeds are included so another team can reproduce it.',
      'The first checks target behaviours auditors ask about most often: memorised personal data, refusal consistency and sensitivity to irrelevant prompt changes.',
    ],
    raise: 81_000,
    supply: 21_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Audit kit 0.1',
        body: 'The first kit runs five checks on models up to 13B parameters on a single node, with a reproducibility manifest.',
      },
      {
        kind: 'update',
        title: 'Limitations section',
        body: 'Every report now opens with what the checks cannot detect. Reviewers asked for this first.',
      },
    ],
  },
  {
    slug: 'foldmere',
    name: 'Foldmere',
    ticker: 'FLDM',
    category: 'Science',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Enzyme stability predictions for protein engineers',
    description: [
      'Foldmere predicts how mutations change an enzyme’s thermal stability and proposes small sets of variants worth testing. It is built for protein engineers who want fewer, better rounds in the lab.',
      'Predictions are scored against the partner lab’s measurements after every round, and the running accuracy is public.',
      'Budget draws fund wet-lab validation rounds, each proposed with its variant list.',
    ],
    raise: 102_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Validation round one',
        body: 'Of 48 predicted stabilising variants, 29 raised the melting temperature by more than one degree. Results are published with the misses.',
      },
      {
        kind: 'update',
        title: 'Combining mutations',
        body: 'The model now proposes combinations of stabilising mutations and flags pairs likely to interfere.',
      },
    ],
  },
  {
    slug: 'sparrowlight',
    name: 'Sparrowlight',
    ticker: 'SPRW',
    category: 'Education',
    template: 'ESCROW_LAUNCH',
    pitch: 'A reading-fluency coach that listens and adapts',
    description: [
      'Sparrowlight listens to early readers read aloud, marks words they struggle with and picks the next passage at the right level. Teachers get a weekly fluency summary per child.',
      'Audio stays on the classroom device by default. Teachers choose whether any recording is kept.',
    ],
    raise: 24_000,
    supply: 1_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'On-device speech model',
        body: 'Word-level scoring now runs on classroom tablets without a network connection.',
      },
      {
        kind: 'update',
        title: 'Teacher summaries',
        body: 'Weekly summaries now show words-per-minute trends and the sounds each child finds hardest.',
      },
    ],
  },
  {
    slug: 'tidewright',
    name: 'Tidewright',
    ticker: 'TDWR',
    category: 'Climate',
    template: 'BUDGET_LAUNCH',
    budgetCeilingBps: 2500,
    pitch: 'Coastal flood forecasts for small municipalities',
    description: [
      'Tidewright produces street-level coastal flood forecasts for towns that cannot run their own models. It combines tide gauges, surge forecasts and local drainage maps into a 72-hour outlook.',
      'Forecasts are delivered as a map and a short briefing for the emergency manager, with the uncertainty stated plainly.',
      'Budget draws fund onboarding for each new municipality, including the drainage survey the model needs.',
    ],
    raise: 66_000,
    supply: 100_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Three towns onboarded',
        body: 'Three coastal towns receive daily outlooks. The last spring tide flooding matched the forecast extent on 11 of 13 streets.',
      },
      {
        kind: 'update',
        title: 'Drainage-aware flooding',
        body: 'Outlooks now account for blocked outfalls reported by public works crews.',
      },
    ],
  },
  {
    slug: 'ottermill',
    name: 'Ottermill',
    ticker: 'OTML',
    category: 'Finance',
    template: 'ESCROW_LAUNCH',
    pitch: 'Invoice fraud screening for accounts-payable teams',
    description: [
      'Ottermill screens incoming invoices for signs of fraud: changed bank details, look-alike supplier names, duplicate amounts and unusual timing. Suspicious invoices are held with a short explanation.',
      'The accounts-payable clerk decides. Every hold and release is logged, and confirmed fraud attempts improve the screening for that customer.',
    ],
    raise: 48_000,
    supply: 10_000_000,
    updates: [
      {
        kind: 'milestone',
        title: 'Bank-detail change checks',
        body: 'Any change to a supplier’s bank details now triggers a hold and a call-back task. Pilot customers caught two attempted redirects in the first month.',
      },
      {
        kind: 'update',
        title: 'Duplicate detection across entities',
        body: 'Duplicate invoices are now detected across a customer’s legal entities, not just within one ledger.',
      },
    ],
  },
];

/** Short signed-feedback texts backers post; grouped by category so they stay plausible. */
export const FEEDBACK: Record<Category, string[]> = {
  Agents: [
    'The approval step before anything is submitted is what made our operations lead comfortable trying this.',
    'Useful on routine cases. I would like clearer handling when a source document is ambiguous.',
  ],
  'Developer tools': [
    'Ran it on two of our services. The findings were specific enough to act on without a meeting.',
    'Good signal overall; generated code paths still produce some noise.',
  ],
  'Evaluation & safety': [
    'The limitations section is more honest than most vendor reports I have read.',
    'I would back more once the checks cover larger models, but the methodology is sound.',
  ],
  'Data infrastructure': [
    'Being able to rebuild a dataset version from source is exactly what our auditors ask for.',
    'Promising. Documentation for the rebuild process could be more detailed.',
  ],
  'Inference & compute': [
    'The per-decision logs made it easy to reconcile against our bill.',
    'Latency is acceptable for batch work; interactive use needs another round of tuning.',
  ],
  Security: [
    'Every decision links to the text that caused it, which makes reviews much faster.',
    'Solid start. I would like to see the open issues list shrink over the next releases.',
  ],
  Health: [
    'Clinicians stay in control of every decision, which is the right design for this area.',
    'The published safety review is reassuring. Integration with our records system is the next hurdle.',
  ],
  Science: [
    'Publishing the misses alongside the hits is what convinced me to back this.',
    'Good early results. I will watch the calibration numbers over the next rounds.',
  ],
  Climate: [
    'The uncertainty is stated plainly, which is rare in this field.',
    'Pilot numbers look credible. Coverage outside the pilot region is still an open question.',
  ],
  Robotics: [
    'The technician review step keeps false positives cheap. Sensible design.',
    'Field results look real. Regulatory approvals will decide the pace from here.',
  ],
  Finance: [
    'Nothing posts without approval, and each proposal shows its evidence. That is the bar for finance tools.',
    'Worked well on our main entity; multi-currency needs more work.',
  ],
  Legal: [
    'Citations back to the playbook make the suggestions easy to trust or reject.',
    'Accurate on standard agreements. Heavily negotiated contracts still need close review.',
  ],
  Education: [
    'Teachers in our pilot liked the misconception grouping more than any score.',
    'Good engagement. I would like to see results across a full school year.',
  ],
  'Creative tools': [
    'Output stays editable in the tools artists already use. That matters more than the model.',
    'Consistency is much better than earlier tools I tried. Style range is still narrow.',
  ],
  Logistics: [
    'Planners keep the final say, and the reasoning is visible. That is why our team is willing to try it.',
    'Two integrations is a good start; coverage will decide whether this scales.',
  ],
};
