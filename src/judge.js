import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeCommand } from "./runner.js";
import { average, finiteNumber, id } from "./utils.js";

export async function judgeRuns({ runs, judges, cases, outputDir, allowExec, profile }) {
  if (!judges?.length) {
    return runs.map((run) => ({
      ...run,
      judgments: [],
      score: combineScore(run.score, [], profile)
    }));
  }
  const caseMap = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const judged = [];
  for (const run of runs) {
    const testCase = caseMap.get(run.case_id);
    const judgments = [];
    for (const judge of judges) {
      judgments.push(await executeJudge({
        judge,
        run,
        testCase,
        outputDir,
        allowExec
      }));
    }
    judged.push({
      ...run,
      judgments,
      score: combineScore(run.score, judgments, profile)
    });
  }
  return judged;
}

async function executeJudge({ judge, run, testCase, outputDir, allowExec }) {
  if (judge.adapter === "fixture") {
    const outcome = testCase.fixture_judgments?.[judge.id]?.[run.condition]
      ?? testCase.fixture_judgments?.[run.condition];
    if (!outcome) {
      return invalidJudgment(judge.id, "No fixture judgment configured");
    }
    return normalizeJudgment(judge.id, outcome);
  }
  if (!allowExec) return invalidJudgment(judge.id, "Judges require --allow-exec");
  const judgeRoot = join(outputDir, "judge-inputs", id("blind"));
  await mkdir(judgeRoot, { recursive: true });
  const caseFile = join(judgeRoot, "case.json");
  const resultFile = join(judgeRoot, "result.json");
  await writeFile(caseFile, `${JSON.stringify({
    candidate: run.artifact.blinded_label,
    prompt: testCase.prompt,
    rubric: testCase.rubric ?? [],
    profile: testCase.profile ?? null
  }, null, 2)}\n`, "utf8");
  const replacements = {
    artifact: run.artifact.path,
    candidate: run.artifact.blinded_label,
    case_file: caseFile,
    result_file: resultFile,
    judge_id: judge.id
  };
  let processResult;
  try {
    processResult = await executeCommand(
      replace(judge.command, replacements),
      (judge.args ?? []).map((value) => replace(value, replacements)),
      {
        cwd: judgeRoot,
        env: {
          ...process.env,
          SKILLPROOF_ARTIFACT: run.artifact.path,
          SKILLPROOF_CANDIDATE: run.artifact.blinded_label,
          SKILLPROOF_CASE_FILE: caseFile,
          SKILLPROOF_JUDGE_RESULT: resultFile
        },
        timeoutMs: judge.timeout_ms ?? 300000
      },
    );
  } catch (error) {
    return invalidJudgment(judge.id, error.message);
  }
  if (processResult.exitCode !== 0) {
    return invalidJudgment(judge.id, processResult.stderr || `Judge exited ${processResult.exitCode}`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(resultFile, "utf8"));
  } catch {
    try {
      value = JSON.parse(processResult.stdout);
    } catch {
      return invalidJudgment(judge.id, "Judge returned no valid JSON result");
    }
  }
  return normalizeJudgment(judge.id, value);
}

function normalizeJudgment(judgeId, value) {
  const score = finiteNumber(value.score);
  const maximum = finiteNumber(value.maximum ?? 100);
  if (score === null || maximum === null || maximum === 0 || score > maximum) {
    return invalidJudgment(judgeId, "Judgment score must be between zero and maximum");
  }
  return {
    judge_id: judgeId,
    status: "completed",
    score,
    maximum,
    percent: (score / maximum) * 100,
    criteria: Array.isArray(value.criteria) ? value.criteria : [],
    rationale: String(value.rationale ?? ""),
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    blinding_compromised: Boolean(value.blinding_compromised)
  };
}

function invalidJudgment(judgeId, error) {
  return {
    judge_id: judgeId,
    status: "error",
    score: null,
    maximum: null,
    percent: null,
    criteria: [],
    rationale: "",
    evidence: [],
    blinding_compromised: false,
    error
  };
}

function combineScore(score, judgments, profile) {
  const judgmentPercent = average(
    judgments.filter((judgment) => judgment.status === "completed").map((judgment) => judgment.percent),
  );
  const deterministic = score.deterministic_percent;
  let quality = null;
  let evidence = "unmeasured";
  if (profile.require_deterministic && !Number.isFinite(deterministic)) {
    return {
      ...score,
      judgment_percent: judgmentPercent,
      quality_percent: null,
      evidence: "missing_required_deterministic_evidence"
    };
  }
  if (profile.require_judgment && !Number.isFinite(judgmentPercent)) {
    return {
      ...score,
      judgment_percent: judgmentPercent,
      quality_percent: null,
      evidence: "missing_required_judgment"
    };
  }
  if (Number.isFinite(deterministic) && Number.isFinite(judgmentPercent)) {
    const totalWeight = profile.deterministic_weight + profile.judgment_weight;
    quality = (
      deterministic * profile.deterministic_weight
      + judgmentPercent * profile.judgment_weight
    ) / totalWeight;
    evidence = "deterministic_and_judged";
  } else if (Number.isFinite(deterministic)) {
    quality = deterministic;
    evidence = "deterministic_only";
  } else if (Number.isFinite(judgmentPercent)) {
    quality = judgmentPercent;
    evidence = "judged_only";
  }
  return {
    ...score,
    judgment_percent: judgmentPercent,
    quality_percent: quality,
    evidence
  };
}

function replace(value, replacements) {
  return String(value).replace(/\{([a-z_]+)\}/g, (match, key) => (
    Object.hasOwn(replacements, key) ? replacements[key] : match
  ));
}
