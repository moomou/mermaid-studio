import { examples } from '../../src/examples.ts';

export interface RenderingCase {
  id: string;
  source: string;
}

export const renderingCases: RenderingCase[] = [
  ...examples.map(({ id, source }) => ({ id, source })),
  ...['TB', 'BT', 'LR', 'RL'].map(direction => ({
    id: `chain-${direction.toLowerCase()}`,
    source: `flowchart ${direction}\n A[Start] --> B[Process] --> C[Finish]`,
  })),
  ...['TB', 'BT', 'LR', 'RL'].map(direction => ({
    id: `branch-${direction.toLowerCase()}`,
    source: `flowchart ${direction}
      A([Request]) --> B{Valid?}
      B -->|Yes| C[Process]
      B -->|No| D[Explain error]
      C --> E([Done])
      D --> E`,
  })),
  {
    id: 'cycle',
    source: `flowchart LR
      A[Draft] --> B[Review] --> C{Approved?}
      C -->|No| A
      C -->|Yes| D[Publish]
      D -. Update .-> A`,
  },
  {
    id: 'self-loops',
    source: `flowchart TB
      A[Waiting] --> A
      A --> B[Running]
      B -->|Retry| B
      B --> C[Complete]`,
  },
  {
    id: 'parallel-edges',
    source: `flowchart LR
      A[Client] -->|Read| B[Service]
      A -->|Write| B
      B -->|Response| A
      A -. Heartbeat .-> B`,
  },
  {
    id: 'disconnected',
    source: `flowchart TB
      A[First] --> B[Second]
      C[Independent] --> D[Result]
      E[Standalone]
      F[Another standalone]`,
  },
  {
    id: 'fan-out',
    source: `flowchart TB\n A[Dispatcher]\n${Array.from({ length: 10 }, (_, i) =>
      ` A -->|Job ${i + 1}| W${i}[Worker ${i + 1}]`).join('\n')}`,
  },
  {
    id: 'fan-in',
    source: `flowchart LR\n${Array.from({ length: 8 }, (_, i) =>
      ` S${i}[Source ${i + 1}] -->|Batch ${i + 1}| M[Merge]`).join('\n')}\n M --> V{Valid?}\n V -->|Yes| D[(Store)]\n V -->|No| R[Review]`,
  },
  {
    id: 'dense-layers',
    source: `flowchart LR\n${Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => ` A${i}[Input ${i + 1}] --> B${j}[Stage ${j + 1}]`).join('\n')).join('\n')}\n B0 & B1 & B2 & B3 --> C[Result]`,
  },
  {
    id: 'nested-groups',
    source: `flowchart TB
      subgraph outer[Platform]
        subgraph front[Frontend]
          A[Browser] --> B[Web app]
        end
        subgraph back[Backend]
          C[API] --> D[(Database)]
        end
        B --> C
      end
      U[User] --> A
      C -. Status .-> B`,
  },
  {
    id: 'mixed-directions',
    source: `flowchart TB
      subgraph one[First stage]
        direction LR
        A --> B --> C
      end
      subgraph two[Second stage]
        direction RL
        D --> E --> F
      end
      C --> D`,
  },
  {
    id: 'group-endpoints',
    source: `flowchart LR
      subgraph workers[Workers]
        A[Queue] --> B[Worker]
      end
      S[Submit] --> workers
      workers --> X[Audit] & Y[Metrics] & Z[Results]`,
  },
  {
    id: 'long-group-title',
    source: `flowchart TB
      subgraph g[A long declared boundary title that needs multiple lines without overlapping its children]
        A[First] --> B[Second]
      end
      B --> C[Finish]`,
  },
  {
    id: 'long-labels',
    source: `flowchart LR
      A["Receive a document with a descriptive label<br/>Retain all supporting details"] --> B{"Does this document contain<br/>all required information?"}
      B -->|The information is complete| C["Store the validated document<br/>and create a searchable index"]
      B -->|More information is needed| D["Explain what is missing<br/>and request another submission"]
      D -. Resubmit the corrected document .-> A`,
  },
  {
    id: 'shapes',
    source: `flowchart LR
      A([Start]) --> B[/Input/] --> C{Ready?}
      C -->|Yes| D[[Subprocess]] --> E[(Database)]
      C -->|No| F{{Prepare}}
      F --> G((Wait)) --> H(((End)))`,
  },
  {
    id: 'source-styles',
    source: `flowchart TB
      A[Read] --> B{Check}
      B ==>|Pass| C[Accept]
      B -. Fail .-> D[Reject]
      classDef good fill:#e6f4ea,stroke:#28733e,color:#173e24
      classDef bad fill:#fde9e7,stroke:#a53730,color:#66201c
      class C good
      class D bad
      linkStyle 1 stroke:#28733e,stroke-width:3px`,
  },
  {
    id: 'unicode',
    source: 'flowchart LR\n A["\u63a5\u6536\u8acb\u6c42"] --> B{"\u8cc7\u6599\u5b8c\u6574\uff1f"}\n B -->|\u662f| C["\u5132\u5b58\u8cc7\u6599"]\n B -->|\u5426| D["\u88dc\u5145\u8cc7\u8a0a"]\n D --> A',
  },
  {
    id: 'markdown-labels',
    source: 'flowchart TB\n A["`**Receive** a document`"] --> B["`Validate and **keep** every detail`"] --> C["`Save the result`"]',
  },
  {
    id: 'invisible-constraints',
    source: `flowchart TB
      A --> B --> C
      D --> E --> F
      A ~~~ D
      C -. Observe .-> F`,
  },
  {
    id: 'edge-markers',
    source: `flowchart LR
      A <--> B
      B o--o C
      C x--x D
      D --- E
      E ==> F`,
  },
  {
    id: 'feedback-network',
    source: `flowchart TB
      A[Receive] --> B[Validate] --> C[Transform] --> D[Store]
      D --> E[Query] --> F[Rank] --> G[Respond]
      B -->|Invalid| H[Reject]
      C -. Retry .-> B
      F -. Improve .-> C
      G -. Feedback .-> E
      H -. Correct .-> A`,
  },
  {
    id: 'native-shape',
    source: 'flowchart LR\n A@{ shape: cloud, label: "Cloud" } --> B[Application] --> C[(Data)]',
  },
  {
    id: 'state',
    source: `stateDiagram-v2
      [*] --> Idle
      Idle --> Running: Start
      Running --> Failed: Error
      Failed --> Running: Retry
      Running --> Complete: Finish
      Complete --> [*]`,
  },
  {
    id: 'class',
    source: `classDiagram
      class Order {
        +String id
        +submit()
      }
      class Item {
        +String name
        +Number quantity
      }
      Order "1" *-- "many" Item`,
  },
  {
    id: 'entity-relationship',
    source: `erDiagram
      CUSTOMER ||--o{ ORDER : places
      ORDER ||--|{ LINE_ITEM : contains
      PRODUCT ||--o{ LINE_ITEM : includes`,
  },
  {
    id: 'mindmap',
    source: `mindmap
      root((Project))
        Plan
          Scope
          Schedule
        Build
          Code
          Test
        Release`,
  },
  {
    id: 'gantt',
    source: `gantt
      title Release plan
      dateFormat YYYY-MM-DD
      section Build
      Implementation :a, 2026-01-01, 4d
      Tests :after a, 2d
      section Release
      Deploy :2026-01-07, 1d`,
  },
  {
    id: 'journey',
    source: `journey
      title Support request
      section Report
        Open a ticket: 3: User
        Add details: 4: User
      section Resolve
        Investigate: 3: Support
        Confirm fix: 5: User, Support`,
  },
  {
    id: 'pie',
    source: `pie title Work allocation
      "Build" : 50
      "Test" : 30
      "Review" : 20`,
  },
];
