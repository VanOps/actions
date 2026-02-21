const core = require("@actions/core");
const github = require("@actions/github");
const { Octokit } = require("@octokit/rest");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

// ─── Configuración ──────────────────────────────────────────────────────────

const MCP_TIMEOUT_MS = 15_000;
const MODELS_API_BASE = "https://models.inference.ai.azure.com";

// ─── Utilidades ─────────────────────────────────────────────────────────────

/** Mide duración de ejecución en segundos */
function createTimer() {
  const start = Date.now();
  return () => ((Date.now() - start) / 1000).toFixed(2);
}

/** Máscara parcial de un token para logs seguros */
function maskToken(token) {
  if (!token || token.length < 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

// ─── 1. Detección del step fallido ──────────────────────────────────────────

/**
 * Obtiene los jobs del workflow_run y localiza el primer step con status 'failure'.
 * Retorna { job, step, jobId } o lanza error si no hay step fallido.
 */
async function findFailedStep(
  octokit,
  owner,
  repo,
  runId,
  retries = 3,
  delayMs = 3000,
) {
  core.info(`Buscando steps fallidos en run ${runId}...`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      filter: "latest",
    });

    core.info(
      `Intento ${attempt}/${retries}: ${data.jobs.length} jobs encontrados`,
    );

    for (const job of data.jobs) {
      core.info(
        `  Job "${job.name}" - status: ${job.status}, conclusion: ${job.conclusion}, steps: ${job.steps?.length ?? 0}`,
      );

      if (job.conclusion !== "failure" && job.status !== "in_progress")
        continue;

      // Loggear estado de cada step para diagnóstico
      if (job.steps) {
        for (const s of job.steps) {
          core.info(
            `    Step #${s.number} "${s.name}" - status: ${s.status}, conclusion: ${s.conclusion}`,
          );
        }
      }

      const failedStep = job.steps?.find((s) => s.conclusion === "failure");
      if (failedStep) {
        core.info(`Step fallido: "${failedStep.name}" en job "${job.name}"`);
        return { job, step: failedStep, jobId: job.id };
      }
    }

    if (attempt < retries) {
      core.info(
        `No se encontró step fallido aún. Reintentando en ${delayMs / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `No se encontró ningún step fallido en workflow run ${runId}`,
  );
}

// ─── 2. Recuperación de contexto (logs) ─────────────────────────────────────

/**
 * Descarga los logs completos del workflow run (ZIP) y los retorna como texto.
 * GitHub API retorna un redirect a un archivo ZIP; usamos la respuesta raw.
 */
async function getWorkflowLogs(octokit, owner, repo, runId) {
  core.info("Descargando logs del workflow...");
  try {
    const { data } = await octokit.rest.actions.downloadWorkflowRunLogs({
      owner,
      repo,
      run_id: runId,
    });
    // data es un ArrayBuffer del ZIP; lo convertimos a string para resumen
    return Buffer.from(data).toString("utf-8").slice(0, 50_000);
  } catch (err) {
    core.warning(`No se pudieron obtener logs completos: ${err.message}`);
    return "[Logs no disponibles]";
  }
}

/**
 * Extrae la salida RAW exclusiva del step fallido usando la API de logs por job.
 * Parsea el log del job buscando las líneas del step específico.
 */
async function getFailedStepLog(
  octokit,
  owner,
  repo,
  jobId,
  stepName,
  stepNumber,
) {
  core.info(`Extrayendo log del step "${stepName}"...`);
  try {
    const { data } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });

    const logText =
      typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
    const lines = logText.split("\n");

    // Los logs de GitHub Actions marcan cada step con un timestamp y grupo.
    // Buscamos el bloque del step fallido por nombre o número.
    const stepLines = extractStepLines(lines, stepName, stepNumber);
    return stepLines.length > 0
      ? stepLines.join("\n").slice(0, 30_000)
      : logText.slice(0, 30_000); // fallback: devolver todo el job log truncado
  } catch (err) {
    core.warning(`No se pudo extraer log del step: ${err.message}`);
    return "[Log del step no disponible]";
  }
}

/**
 * Parsea las líneas del log de un job y extrae solo las del step indicado.
 * GitHub Actions usa marcadores como "##[group]Run <step>" en los logs.
 */
function extractStepLines(lines, stepName, stepNumber) {
  const result = [];
  let capturing = false;

  for (const line of lines) {
    // Detectar inicio del step por nombre en marcadores de grupo
    if (line.includes(`##[group]`) && line.includes(stepName)) {
      capturing = true;
      continue;
    }
    // Detectar fin del step (siguiente grupo o fin de log)
    if (capturing && line.includes("##[group]")) {
      break;
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result;
}

/**
 * Obtiene las anotaciones (errores/warnings) de un job usando la Check Runs API.
 * Funciona incluso cuando el job/run está en progreso (modo inline).
 */
async function getJobAnnotations(octokit, owner, repo, jobId) {
  try {
    const { data } = await octokit.rest.checks.listAnnotations({
      owner,
      repo,
      check_run_id: jobId,
    });
    if (data.length === 0) return null;
    return data
      .map(
        (a) =>
          `${a.annotation_level}: ${a.path}:${a.start_line} - ${a.message}`,
      )
      .join("\n")
      .slice(0, 15_000);
  } catch {
    return null;
  }
}

// ─── 3. Integración MCP ────────────────────────────────────────────────────

/**
 * Conecta al servidor MCP y envía el prompt de análisis.
 * Usa @modelcontextprotocol/sdk para la comunicación.
 */
async function analyzeWithMCP(mcpUrl, prompt, authToken) {
  core.info(`Conectando a MCP Server: ${mcpUrl}...`);

  const transportOpts = authToken
    ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } }
    : {};
  const transport = new StreamableHTTPClientTransport(
    new URL(mcpUrl),
    transportOpts,
  );
  const client = new Client({ name: "ai-workflow-analyzer", version: "1.0.0" });

  // Conectar con timeout
  const connectPromise = client.connect(transport);
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("MCP connection timeout")),
      MCP_TIMEOUT_MS,
    ),
  );
  await Promise.race([connectPromise, timeout]);

  core.info("Conectado a MCP. Enviando prompt de análisis...");

  // Listar herramientas disponibles para diagnóstico
  const { tools } = await client.listTools();
  core.info(`MCP tools disponibles: ${tools.map((t) => t.name).join(", ")}`);

  // Buscar y usar una herramienta de análisis/chat si existe
  const analysisTool = tools.find(
    (t) =>
      t.name === "create_issue" ||
      t.name === "search_code" ||
      t.name.includes("chat"),
  );

  let result;
  if (analysisTool) {
    result = await client.callTool({
      name: analysisTool.name,
      arguments: { prompt, context: "workflow-failure-analysis" },
    });
  } else {
    // Fallback: usar la primera herramienta disponible o enviar como recurso
    result = await client.callTool({
      name: tools[0]?.name || "analyze",
      arguments: { query: prompt },
    });
  }

  await client.close();

  const content = result.content
    ?.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");

  return content || "[MCP no devolvió contenido]";
}

// ─── 4. Fallback: GitHub Models API ─────────────────────────────────────────

/**
 * Si MCP no está disponible, usa GitHub Models API como fallback.
 * Envía el prompt al endpoint /chat/completions (compatible con OpenAI).
 * Usa el GITHUB_TOKEN estándar para autenticación.
 */
async function analyzeWithModels(githubToken, prompt) {
  core.info("Usando fallback: GitHub Models API...");

  if (!githubToken) {
    throw new Error("github-token no proporcionado y MCP no disponible");
  }

  const response = await fetch(`${MODELS_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content:
            "Eres un experto en GitHub Actions y CI/CD. Analiza errores de workflows y sugiere soluciones precisas.",
        },
        { role: "user", content: prompt },
      ],
      model: "gpt-4o",
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub Models API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return (
    data.choices?.[0]?.message?.content ||
    "[GitHub Models no devolvió contenido]"
  );
}

// ─── 5. Comentario en PR ───────────────────────────────────────────────────

/**
 * Busca la PR asociada al head_sha del workflow_run y publica un comentario
 * con el análisis y la sugerencia de solución.
 * Intenta múltiples estrategias: por commit, por branch, y por PRs abiertas recientes.
 */
async function commentOnPR(
  octokit,
  owner,
  repo,
  headSha,
  headBranch,
  analysisBody,
) {
  core.info(`Buscando PR asociada al commit ${headSha.slice(0, 7)}...`);

  let prs = [];

  // Estrategia 1: Buscar PRs que contengan este commit
  try {
    const { data } =
      await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: headSha,
      });
    prs = data;
  } catch (err) {
    core.warning(`Error buscando PR por commit: ${err.message}`);
  }

  // Estrategia 2: Si no se encontró, buscar PRs abiertas por branch
  if (prs.length === 0 && headBranch) {
    core.info(`Buscando PR por branch: ${headBranch}...`);
    try {
      const { data: openPrs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${headBranch}`,
      });
      prs = openPrs;
    } catch (err) {
      core.warning(`Error buscando PR por branch: ${err.message}`);
    }
  }

  // Estrategia 3: Buscar en todas las PRs abiertas recientes
  if (prs.length === 0) {
    core.info("Buscando en PRs abiertas recientes...");
    try {
      const { data: openPrs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        per_page: 10,
      });

      // Verificar si alguna contiene el commit
      for (const pr of openPrs) {
        try {
          const { data: commits } = await octokit.rest.pulls.listCommits({
            owner,
            repo,
            pull_number: pr.number,
          });
          if (commits.some((c) => c.sha === headSha)) {
            prs = [pr];
            core.info(`Encontrada PR #${pr.number} con el commit`);
            break;
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      core.warning(`Error buscando en PRs abiertas: ${err.message}`);
    }
  }

  if (prs.length === 0) {
    core.warning(
      "No se encontró PR asociada. El análisis se emitirá solo como output.",
    );
    return null;
  }

  const pr = prs[0];
  core.info(`Comentando en PR #${pr.number}...`);

  const comment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: [
      "## 🔍 Análisis de Workflow Fallido",
      "",
      analysisBody,
      "",
      "---",
      "*Generado automáticamente por [AI Workflow Failure Analyzer](../blob/main/action.yml)*",
    ].join("\n"),
  });

  return { prNumber: pr.number, commentUrl: comment.data.html_url };
}

// ─── 6. Autoremediación ────────────────────────────────────────────────────

/**
 * Si auto-remediate=true y el análisis sugiere cambios, intenta aplicar
 * la corrección via GitHub API (crear commit en rama nueva + PR).
 * Soporta tanto archivos de workflow como código fuente.
 */
async function autoRemediate(
  octokit,
  owner,
  repo,
  headSha,
  headBranch,
  analysis,
  mcpClient,
) {
  core.info("Evaluando autoremediación...");

  // Buscar archivos mencionados y sus cambios sugeridos
  const fileChanges = extractFileChanges(analysis);

  if (fileChanges.length === 0) {
    core.info(
      "No se encontraron cambios específicos de archivos en el análisis. Omitiendo autoremediación.",
    );
    return null;
  }

  core.info(
    `Archivos a modificar: ${fileChanges.map((fc) => fc.path).join(", ")}`,
  );

  // Crear rama para el fix basada en la rama actual
  const fixBranch = `auto-fix/${headBranch || "main"}-${Date.now()}`;

  try {
    // Obtener referencia de la rama base
    const baseBranch = headBranch || getDefaultBranch();
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    const baseSha = ref.object.sha;

    // Crear nueva rama
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${fixBranch}`,
      sha: baseSha,
    });

    core.info(`Rama creada: ${fixBranch}`);

    // Aplicar cambios a cada archivo
    const appliedChanges = [];
    for (const fileChange of fileChanges) {
      try {
        // Obtener contenido actual del archivo
        let fileData;
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: fileChange.path,
            ref: fixBranch,
          });
          fileData = data;
        } catch (err) {
          if (err.status === 404) {
            // Archivo no existe, será creado
            core.info(`Archivo nuevo: ${fileChange.path}`);
            fileData = null;
          } else {
            throw err;
          }
        }

        // Actualizar o crear archivo
        await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: fileChange.path,
          message: `fix: auto-remediate ${fileChange.path}`,
          content: Buffer.from(fileChange.content).toString("base64"),
          sha: fileData?.sha,
          branch: fixBranch,
        });

        appliedChanges.push(fileChange.path);
        core.info(`✓ Aplicado: ${fileChange.path}`);
      } catch (err) {
        core.warning(
          `✗ Error aplicando cambio a ${fileChange.path}: ${err.message}`,
        );
      }
    }

    if (appliedChanges.length === 0) {
      core.warning("No se pudo aplicar ningún cambio.");
      return null;
    }

    // Crear PR con los cambios
    const prBody = [
      "## 🤖 Auto-remediación de Workflow Fallido",
      "",
      "Este PR fue creado automáticamente por el AI Workflow Failure Analyzer.",
      "",
      "### Cambios aplicados",
      ...appliedChanges.map((path) => `- \`${path}\``),
      "",
      "### Análisis original",
      analysis.slice(0, 2000),
      "",
      "> **⚠️ Revisar antes de mergear.** Esta es una corrección automática generada por IA.",
    ].join("\n");

    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: `🤖 Auto-fix: ${appliedChanges.join(", ")}`,
      body: prBody,
      head: fixBranch,
      base: baseBranch,
    });

    core.info(`✓ PR de remediación creada: ${pr.html_url}`);
    return pr.html_url;
  } catch (err) {
    core.warning(`Error en autoremediación: ${err.message}`);
    return null;
  }
}

/**
 * Extrae cambios de archivos del análisis de IA.
 * Busca patrones como:
 * - "**Archivo:** `path/to/file.ext`" seguido de un bloque de código (formato prompt)
 * - "`path/to/file.ext`" seguido de un bloque de código
 * - Bloques de código con comentarios indicando el archivo
 */
function extractFileChanges(analysis) {
  const changes = [];

  // Patrón 0: Formato del prompt - "**Archivo:** `path/to/file.ext`" seguido de código
  const pattern0 =
    /\*\*(?:Archivo|File)\*\*:\s*`([^`]+)`\s*```[\w]*\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = pattern0.exec(analysis)) !== null) {
    changes.push({
      path: match[1].trim(),
      content: match[2].trim(),
    });
  }

  // Patrón 1: "archivo: path/to/file.ext" seguido de código (variantes sin negrita)
  const pattern1 =
    /(?:archivo|file|path):\s*`?([^\s`\n]+\.\w+)`?\s*```[\w]*\s*\n([\s\S]*?)```/gi;
  while ((match = pattern1.exec(analysis)) !== null) {
    const path = match[1];
    const content = match[2].trim();
    if (!changes.some((c) => c.path === path)) {
      changes.push({ path, content });
    }
  }

  // Patrón 2: Rutas mencionadas explícitamente antes de bloques de código
  const pattern2 =
    /`([^\s`]+\.[a-z]{2,5})`[^\n]*\n+```[\w]*\s*\n([\s\S]*?)```/gi;
  while ((match = pattern2.exec(analysis)) !== null) {
    const path = match[1];
    const content = match[2].trim();
    // Evitar duplicados
    if (!changes.some((c) => c.path === path)) {
      changes.push({ path, content });
    }
  }

  // Patrón 3: Comentarios dentro del código indicando archivo
  const pattern3 =
    /```[\w]*\s*\n(?:\/\/|#)\s*(?:file|archivo):\s*([^\n]+)\n([\s\S]*?)```/gi;
  while ((match = pattern3.exec(analysis)) !== null) {
    const path = match[1].trim();
    const content = match[2].trim();
    if (!changes.some((c) => c.path === path)) {
      changes.push({ path, content });
    }
  }

  core.info(`Patrones detectados: ${changes.length} cambios encontrados`);
  if (changes.length > 0) {
    core.info(`Archivos a modificar: ${changes.map((c) => c.path).join(", ")}`);
  }

  return changes;
}

/** Extrae la rama por defecto (simplificado; usa head_sha como referencia) */
function getDefaultBranch() {
  return "main";
}

// ─── 7. Logs finales ───────────────────────────────────────────────────────

/**
 * Emite resumen de ejecución: proveedor usado, costes estimados, duración.
 */
function logSummary(provider, duration, tokenUsed) {
  const costs = {
    mcp: { label: "MCP (GitHub)", cost: "$0.00 (incluido)" },
    models: { label: "GitHub Models API", cost: "~1 request (rate-limited)" },
  };

  const info = costs[provider] || { label: provider, cost: "desconocido" };

  core.info("═══════════════════════════════════════════");
  core.info("         RESUMEN DE EJECUCIÓN");
  core.info("═══════════════════════════════════════════");
  core.info(`  Proveedor IA:  ${info.label}`);
  core.info(`  Token usado:   ${maskToken(tokenUsed)}`);
  core.info(`  Coste:         ${info.cost}`);
  core.info(`  Duración:      ${duration}s`);
  core.info("═══════════════════════════════════════════");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const elapsed = createTimer();

  try {
    // ── Leer inputs ──
    const githubToken = core.getInput("github-token", { required: true });
    const mcpUrl = core.getInput("mcp-url");
    const autoRemediateEnabled = core.getInput("auto-remediate") === "true";

    // ── Validar contexto del evento ──
    const { context } = github;
    const { owner, repo } = context.repo;

    let runId;
    let headSha;
    let headBranch;

    const workflowRun = context.payload.workflow_run;

    if (workflowRun) {
      // Modo workflow_run trigger
      if (workflowRun.conclusion !== "failure") {
        core.info(
          `Workflow run ${workflowRun.id} no falló (${workflowRun.conclusion}). Saliendo.`,
        );
        return;
      }
      runId = workflowRun.id;
      headSha = workflowRun.head_sha;
      headBranch = workflowRun.head_branch;
      core.info(
        `Modo workflow_run: analizando run ${runId} (${workflowRun.name})...`,
      );
    } else {
      // Modo inline (if: failure()) — usar el run actual
      runId = context.runId;
      headSha = context.sha;
      headBranch = context.ref?.replace("refs/heads/", "");
      core.info(`Modo inline: analizando run actual ${runId}...`);
    }

    // ── Inicializar Octokit ──
    const octokit = new Octokit({ auth: githubToken });

    // ── Paso 1: Detectar step fallido ──
    const { job, step, jobId } = await findFailedStep(
      octokit,
      owner,
      repo,
      runId,
    );

    // ── Paso 2: Recuperar contexto (logs) ──
    const isInlineMode = !workflowRun;
    if (isInlineMode) {
      core.warning(
        "Modo inline: el run está en progreso, los logs completos pueden no estar disponibles. " +
          "Para logs completos, usa el trigger workflow_run en un workflow separado.",
      );
    }

    const [workflowLogs, stepLog, annotations] = await Promise.all([
      getWorkflowLogs(octokit, owner, repo, runId),
      getFailedStepLog(octokit, owner, repo, jobId, step.name, step.number),
      getJobAnnotations(octokit, owner, repo, jobId),
    ]);

    // En modo inline, si los logs no están disponibles, usar annotations como contexto
    const effectiveStepLog =
      stepLog === "[Log del step no disponible]" && annotations
        ? `[Annotations del check run]\n${annotations}`
        : stepLog;

    // ── Construir prompt para IA ──
    const prompt = [
      `Analiza este step fallido y sugiere una solución precisa.`,
      ``,
      `## Información del workflow`,
      `- Workflow: ${workflowRun?.name || context.workflow}`,
      `- Job: ${job.name}`,
      `- Step fallido: ${step.name} (paso #${step.number})`,
      `- Conclusión: ${step.conclusion}`,
      `- Repositorio: ${owner}/${repo}`,
      `- Commit: ${headSha}`,
      ``,
      `## Log RAW del step fallido`,
      "```",
      effectiveStepLog,
      "```",
      ``,
      `## Resumen del workflow completo`,
      "```",
      workflowLogs.slice(0, 10_000),
      "```",
      ``,
      `Proporciona:`,
      `1. Causa raíz del error`,
      `2. Solución específica con código/config si aplica`,
      `3. Para cada archivo que necesite ser modificado, usa este formato EXACTO:`,
      ``,
      `   **Archivo:** \`ruta/al/archivo.ext\``,
      `   \`\`\`lenguaje`,
      `   contenido completo corregido del archivo`,
      `   \`\`\``,
      ``,
      `4. Si el fix es en .github/workflows/*.yml, muestra el YAML corregido completo`,
      `5. Si el fix es en código fuente (scripts, aplicaciones), proporciona el código corregido completo`,
      ``,
      `IMPORTANTE: Siempre especifica la ruta completa del archivo antes del bloque de código para permitir auto-remediación.`,
    ].join("\n");

    // ── Paso 3/4: Análisis IA (MCP con fallback a Copilot) ──
    let analysis;
    let provider;
    let tokenUsed;

    try {
      analysis = await analyzeWithMCP(mcpUrl, prompt, githubToken);
      provider = "mcp";
      tokenUsed = githubToken;
    } catch (mcpError) {
      core.warning(
        `MCP no disponible: ${mcpError.message}. Usando fallback GitHub Models...`,
      );
      analysis = await analyzeWithModels(githubToken, prompt);
      provider = "models";
      tokenUsed = githubToken;
    }

    core.info("Análisis completado.");

    // ── Paso 5: Comentar en PR ──
    const prResult = await commentOnPR(
      octokit,
      owner,
      repo,
      headSha,
      headBranch,
      analysis,
    );

    // ── Paso 6: Autoremediación (si habilitado) ──
    let remediationUrl = null;
    if (autoRemediateEnabled) {
      remediationUrl = await autoRemediate(
        octokit,
        owner,
        repo,
        headSha,
        headBranch,
        analysis,
        null,
      );
    }

    // ── Emitir outputs ──
    core.setOutput("analysis", analysis);
    core.setOutput("provider", provider);
    if (remediationUrl) {
      core.setOutput("remediation-pr", remediationUrl);
    }

    // ── Paso 7: Logs finales ──
    logSummary(provider, elapsed(), tokenUsed);

    if (prResult) {
      core.info(`Comentario publicado: ${prResult.commentUrl}`);
    }
  } catch (error) {
    core.setFailed(`Error en AI Workflow Analyzer: ${error.message}`);
    core.error(error.stack);
  }
}

run();
