# An invalid document must not partially import

```mermaid
flowchart LR
  First --> Second
```

```mermaid
flowchart TB
  A["Unclosed label
```
