export interface Example {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const examples: Example[] = [
  {
    id: 'deployment',
    name: 'KidsMealToys deployment',
    description: 'Transcribed from the reference image',
    source: `---
title: KidsMealToys deployment flow
config:
  theme: base
  themeVariables:
    background: "#f7f2e6"
---
flowchart TB
  subgraph discord["Discord control plane"]
    user("Allowlisted Discord user<br/>runs /deploy")
    confirm("Ephemeral confirmation<br/>expires after 60 seconds")
    user --> confirm
  end

  subgraph bot["Hardened bot container"]
    service("kidsmealtoys-deploy-bot<br/>UID 2001 / read-only rootfs<br/>0 capabilities / no Docker socket")
    checks("Checks guild + exact user ID<br/>single-flight + cooldown")
    service --> checks
  end

  subgraph host["Host privilege boundary"]
    ssh("OpenSSH restricted key<br/>source IP 172.31.252.2<br/>no PTY or forwarding")
    command("Forced command only<br/>sudo NOSETENV + 12m timeout")
    helper("Root-owned deploy helper<br/>flock / fixed repo / fixed master<br/>installed outside Git")
    ssh --> command --> helper
  end

  confirm -->|"Discord Gateway"| service
  checks -->|"SSH command: deploy"| ssh
  helper -->|"git fetch"| repo

  repo("GitHub twhh/regle<br/>protected master<br/>read-only deploy key")
  fetch("Fetch into root-only bare mirror<br/>resolve exact 40-char SHA<br/>reject non-fast-forward history")
  deployed{"SHA already<br/>deployed?"}
  archive("Archive exact SHA into<br/>immutable release directory")
  noop("No-op path<br/>verify current production health<br/>return changed=false")
  repo --> fetch --> deployed
  deployed -->|"yes"| noop
  deployed -->|"no"| archive

  subgraph validation["Isolated validation image"]
    image("Pinned Node + Chromium image<br/>(no production secrets)")
    tests("npm ci<br/>unit/API tests - lint - build<br/>Playwright E2E (mobile + desktop)")
    image --> tests
  end
  archive --> image
  tests -->|"all pass"| backup

  backup("Consistent SQLite backup<br/>retain newest 10")
  build("docker compose build<br/>creates toyscout:latest<br/>old container still serving")
  restart("docker compose up<br/>--no-build --force-recreate")
  healthy{"Healthy + API + mount<br/>+ DB + secrets?"}
  rollback("Retag previous image<br/>recreate previous container<br/>verify health")
  success("Record deployed SHA/current<br/>remove rollback tag<br/>reply success to Discord")
  backup --> build --> restart --> healthy
  healthy -->|"no"| rollback
  healthy -->|"yes"| success

  subgraph production["Production traffic (separate from deploy control)"]
    browser("User browser<br/>https://kidsmealtoys.com")
    tunnel("Cloudflare DNS + Tunnel")
    port("Host :9123")
    app("toyscout container<br/>host network / UID 1001<br/>/opt/toyscout bind mount")
    browser --> tunnel --> port --> app
  end
  restart -->|"replaces image"| app
  noop -. "result" .-> service
  rollback -. "failure + rollback status" .-> service
  success -. "result" .-> service

  classDef control fill:#eee9ff,stroke:#34473c
  classDef infra fill:#e8f7fc,stroke:#34473c
  classDef repository fill:#efefed,stroke:#34473c
  classDef boundary fill:#fff3ef,stroke:#34473c
  classDef check fill:#fff8dc,stroke:#34473c
  classDef good fill:#ebf7e3,stroke:#34473c
  classDef bad fill:#fff0ee,stroke:#34473c
  class user,confirm control
  class service,checks,backup,build,restart infra
  class repo repository
  class ssh,command,helper boundary
  class deployed,healthy,image,tests check
  class browser,tunnel,port,app,noop,success good
  class rollback bad
  style discord fill:none,stroke:#aa91f5,stroke-dasharray:6 6
  style bot fill:none,stroke:#78cdeb,stroke-dasharray:6 6
  style host fill:none,stroke:#ea9c8c,stroke-dasharray:6 6
  style validation fill:none,stroke:#dfc16e,stroke-dasharray:6 6
  style production fill:none,stroke:#b1d883,stroke-dasharray:6 6
`,
  },
  {
    id: 'checkout',
    name: 'Checkout & fulfillment',
    description: 'Explicit subgraphs, branching, and return paths',
    source: `---
title: From checkout to doorstep
---
flowchart LR
  subgraph storefront["Storefront"]
    cart([Shopping cart]) --> checkout[Checkout]
    checkout --> valid{Address valid?}
    valid -->|No| checkout
  end
  subgraph payments["Payment processing"]
    authorize[Authorize payment] --> approved{Approved?}
    approved -->|Yes| capture[Capture payment]
    approved -->|No| declined[Explain decline]
  end
  subgraph fulfillment["Fulfillment"]
    reserve[Reserve inventory] --> pack[Pick & pack]
    pack --> ship[Create shipment]
    ship --> delivered([Delivered])
  end
  valid -->|Yes| authorize
  capture --> reserve
  declined -.-> checkout
  delivered -. Receipt .-> checkout
`,
  },
  {
    id: 'data',
    name: 'Data platform',
    description: 'Nested boundaries and multiple independent sources',
    source: `---
title: A small, observable data platform
---
flowchart TB
  subgraph ingest["Ingestion"]
    events[/Product events/] --> queue[(Event queue)]
    webhook[/Partner webhooks/] --> queue
    queue --> validate{Schema valid?}
    validate -->|No| quarantine[(Quarantine)]
    validate -->|Yes| raw[(Raw storage)]
  end
  subgraph transform["Transformation"]
    subgraph batch["Batch compute"]
      schedule[Scheduled run] --> clean[Normalize & deduplicate]
      clean --> aggregate[Build aggregates]
    end
    quality{Quality gate}
    aggregate --> quality
    quality -->|Reject| review[Data review]
  end
  subgraph serve["Serving"]
    warehouse[(Warehouse)] --> api[Query API]
    warehouse --> dashboard[Dashboards]
    api --> clients([Clients])
  end
  raw --> clean
  quality -->|Pass| warehouse
  review -. Reprocess .-> clean
  quarantine -. Alert .-> review
`,
  },
  {
    id: 'ungrouped',
    name: 'Without any subgraphs',
    description: 'Sections inferred from topology, not special labels',
    source: `---
title: Document processing
---
flowchart TB
  upload([Upload]) --> scan[Scan file]
  scan --> safe{Safe?}
  safe -->|No| reject[Reject file]
  safe -->|Yes| extract[Extract text]
  extract --> normalize[Normalize text]
  normalize --> split[Split into passages]
  split --> embed[Generate embeddings]
  embed --> store[(Search index)]
  query([Search query]) --> encode[Encode query]
  encode --> retrieve[Retrieve passages]
  store --> retrieve
  retrieve --> rank[Rank results]
  rank --> answer[Compose answer]
  answer --> cite[Attach citations]
  cite --> response([Response])
  response -. Feedback .-> rank
`,
  },
  {
    id: 'sequence',
    name: 'Sequence diagram',
    description: 'Other diagram types keep native Mermaid rendering',
    source: `---
title: A request, end to end
---
sequenceDiagram
  actor User
  participant App
  participant API
  participant DB as Database
  User->>App: Search
  App->>API: GET /search
  API->>DB: Query
  DB-->>API: Results
  API-->>App: JSON
  App-->>User: Show results
`,
  },
];
