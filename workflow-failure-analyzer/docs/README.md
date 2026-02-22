# AI Workflow Failure Analyzer

GitHub Action que analiza automáticamente workflows fallidos  usando IA (MCP Server / Copilot fallback) y sugiere soluciones.

## Flujo

```mermaid
flowchart TD
    A[workflow_run completed + failure] --> B[Detectar step fallido]
    B --> C[Obtener logs del workflow]
    C --> D[Extraer log RAW del step fallido]
    D --> E{MCP Server disponible?}
    E -->|Sí| F[Analizar con MCP]
    E -->|No / Timeout| G[Fallback: GitHub Models API]
    F --> H[Generar análisis IA]
    G --> H
    H --> I{Existe PR asociada?}
    I -->|Sí| J[Comentar análisis en PR]
    I -->|No| K[Emitir solo como output]
    J --> L{auto-remediate = true?}
    K --> L
    L -->|Sí| M{Cambios solo en workflows?}
    L -->|No| N[Log resumen final]
    M -->|Sí| O[Crear rama + commit fix]
    M -->|No| N
    O --> P[Crear PR de remediación]
    P --> N
    N --> Q[Fin: outputs + métricas]
```

```mermaid
sequenceDiagram
    participant WF as GitHub Actions<br/>(workflow_run trigger)
    participant Main as run()
    participant Core as @actions/core
    participant GH as GitHub API<br/>(Octokit)
    participant MCP as MCP Server
    participant Copilot as GitHub Models API

    WF->>Main: Evento workflow_run (conclusion=failure)
    Main->>Core: getInput(github-token, mcp-url, auto-remediate)
    Core-->>Main: inputs

    Main->>Main: Validar payload workflow_run
    alt workflow_run.conclusion ≠ failure
        Main->>Core: info("No falló. Saliendo.")
    end

    Note over Main: Paso 1 — Detectar step fallido
    Main->>GH: listJobsForWorkflowRun(runId)
    GH-->>Main: jobs[]
    Main->>Main: findFailedStep() → { job, step, jobId }

    Note over Main: Paso 2 — Recuperar logs (en paralelo)
    par Logs del workflow
        Main->>GH: downloadWorkflowRunLogs(runId)
        GH-->>Main: workflowLogs (ZIP → texto)
    and Log del step fallido
        Main->>GH: downloadJobLogsForWorkflowRun(jobId)
        GH-->>Main: jobLog
        Main->>Main: extractStepLines(stepName, stepNumber)
    end

    Main->>Main: Construir prompt con info del workflow + logs

    Note over Main: Paso 3/4 — Análisis IA
    Main->>MCP: connect(mcpUrl) + listTools()
    alt MCP disponible
        MCP-->>Main: tools[]
        Main->>MCP: callTool(analysisTool, prompt)
        MCP-->>Main: analysis
        Main->>MCP: close()
    else MCP falla (timeout / error)
        Main->>Core: warning("MCP no disponible, usando fallback")
        Main->>Copilot: POST /chat/completions (prompt)
        Copilot-->>Main: analysis
    end

    Note over Main: Paso 5 — Comentar en PR
    Main->>GH: listPullRequestsAssociatedWithCommit(headSha)
    GH-->>Main: prs[]
    alt PR encontrada
        Main->>GH: createComment(pr.number, analysis)
        GH-->>Main: commentUrl
    else Sin PR asociada
        Main->>Core: warning("No se encontró PR")
    end

    Note over Main: Paso 6 — Autoremediación
    alt auto-remediate = true Y análisis sugiere cambios en workflows
        Main->>Main: Extraer archivos .github/workflows/*.yml del análisis
        Main->>GH: getRef(main) → baseSha
        Main->>GH: createRef(auto-fix/workflow-*) → nueva rama
        Main->>GH: getContent(targetFile)
        Main->>GH: createOrUpdateFileContents(targetFile, fix)
        Main->>GH: pulls.create(fixBranch → main)
        GH-->>Main: remediationUrl
    end

    Note over Main: Paso 7 — Outputs y resumen
    Main->>Core: setOutput(analysis, provider, remediation-pr)
    Main->>Main: logSummary(provider, duración, token)
    Main->>Core: info("Resumen de ejecución")
```

## Inputs

| Input            | Requerido | Default                 | Descripción                                                                |
| ---------------- | --------- | ----------------------- | -------------------------------------------------------------------------- |
| `github-token`   | Sí        | —                       | Token con permisos `actions:read`, `contents:write`, `pull-requests:write` |
| `mcp-url`        | No        | `http://localhost:3000` | URL del GitHub MCP Server                                                  |
| `copilot-token`  | No        | `''`                    | **[OBSOLETO]** Ya no es necesario. El fallback usa `github-token`          |
| `auto-remediate` | No        | `false`                 | Habilitar auto-corrección de workflows                                     |

## Outputs

| Output           | Descripción                                |
| ---------------- | ------------------------------------------ |
| `analysis`       | Texto del análisis generado por IA         |
| `provider`       | `mcp` o `copilot` según el proveedor usado |
| `remediation-pr` | URL del PR de auto-remediación (si aplica) |

## Uso rápido

```yaml
on:
  workflow_run:
    workflows: ["CI", "Deploy"]
    types: [completed]

jobs:
  analyze:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: ./workflow-failure-analyzer
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }} # Usa GITHUB_TOKEN, no PAT
          mcp-url: ${{ secrets.MCP_URL }} # Opcional
          auto-remediate: "true" # Opcional
```

## Seguridad

- Tokens nunca se loguean completos (máscara `xxxx...xxxx`)
- `auto-remediate` solo modifica archivos en `.github/workflows/*.yml`
- Valida que los cambios sugeridos sean exclusivamente de workflow antes de commitear
- Usa `fine-grained PAT` con scopes mínimos necesarios

## Costes

| Proveedor         | Coste                                              |
| ----------------- | -------------------------------------------------- |
| MCP (GitHub)      | $0 (incluido con GitHub MCP Server)                |
| GitHub Models API | $0 (incluido con GitHub Actions, sujeto a límites) |

## Arquitectura

```
IA-actions/
├── workflow-failure-analyzer/   # Este action
│   ├── action.yml
│   ├── package.json
│   ├── dist/              # Bundle autocontenido (ncc)
│   │   └── index.js
│   ├── src/
│   │   └── index.js
│   └── docs/
│       └── README.md
├── .github/workflows/
│   └── analyze-failure.yml      # Workflow (raíz del repo)
└── otro-action/                 # Futuras actions
```

## Desarrollo

```bash
cd workflow-failure-analyzer
npm install           # Instalar dependencias (solo desarrollo)
npm run build         # Generar dist/index.js (commitear el resultado)
```

> **Importante:** Ejecutar `npm run build` y commitear `dist/` tras cada cambio en `src/`.
> El action usa `dist/index.js` directamente — los consumidores no necesitan `npm ci`.

## Requisitos del token

Para consultas cross-repo con MCP, usar un **fine-grained PAT** con:

- `actions:read` en los repos objetivo
- `contents:read+write` (si auto-remediate)
- `pull-requests:write` para comentar
- Scope de organización si se necesita acceso multi-repo
