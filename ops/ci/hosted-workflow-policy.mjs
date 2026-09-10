import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const assert = (condition, message) => {
  if (!condition) throw new Error(`CI_META_FAILED: ${message}`);
};

export function validateHostedWorkflows(workflow, scheduled) {
  const inventory = readdirSync(".github/workflows", { withFileTypes: true })
    .map((entry) => {
      const type = entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "other";
      return `${entry.name}:${type}`;
    })
    .sort();
  validateWorkflowFileInventory(inventory);
  validateHostedWorkflow(workflow, false);
  validateHostedWorkflow(scheduled, true);
  for (const command of ["npx playwright test", "tuiwright record",
    ...["rendered", "family", "nightly", "packaged-farmd"].map((lane) => "bash scripts/ci-local.sh " + lane)]) {
    assertThrows(() => refuseHostedRenderedTools(workflow + "\n# " + command),
      "hosted rendered tool or local lane accepted", "HOSTED_RENDERED_LANE_FORBIDDEN");
  }
  runRequiredHostiles(workflow);
  runUploadEncodingHostiles(workflow, false);
  runUploadEncodingHostiles(scheduled, true);
  runAppendedJobHostile(workflow, false);
  runAppendedJobHostile(scheduled, true);
  runWorkflowFileInventoryHostiles(inventory);
}

function validateWorkflowFileInventory(inventory) {
  assert(
    JSON.stringify(inventory) ===
      JSON.stringify(["ci.yml:file", "scheduled.yml:file"]),
    "workflow file inventory drifted",
  );
}

export function refuseHostedRenderedTools(definition) {
  assert(!/\b(?:playwright|tuiwright)\b|scripts\/ci-local\.sh\s+(?:rendered|family|nightly|packaged-farmd)\b/i.test(definition),
    "HOSTED_RENDERED_LANE_FORBIDDEN");
}

function validateHostedWorkflow(definition, isScheduled) {
  refuseHostedRenderedTools(definition);
  const beforeJobs = definition.split(/^jobs:$/m, 1)[0].trimEnd();
  const defaultsIndex = beforeJobs.lastIndexOf("\ndefaults:");
  if (isScheduled) {
    assert(defaultsIndex >= 0, "scheduled workflow defaults are absent");
    assert(
      beforeJobs.slice(defaultsIndex + 1) ===
        "defaults:\n  run:\n    shell: bash",
      "scheduled workflow default shell is not exact",
    );
  } else {
    assert(defaultsIndex < 0, "required workflow declares execution defaults");
  }
  assert(
    !/^    defaults:/m.test(definition),
    "a job declares execution defaults",
  );
  assert(
    !/^\s+(?:BASH_ENV|ENV|PATH):/m.test(definition),
    "hazardous execution environment present",
  );
  assert(
    !/^    (?:container|services):/m.test(definition),
    "job container or services present",
  );
  const jobsDefinition = definition.slice(definition.search(/^jobs:$/m));
  const actualJobIds = [
    ...jobsDefinition.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm),
  ].map((match) => match[1]);
  const expectedJobIds = isScheduled
    ? ["hygiene", "coverage", "portable"]
    : ["fast", "lint", "contract", "security", "docs", "required"];
  assert(
    JSON.stringify(actualJobIds) === JSON.stringify(expectedJobIds),
    "hosted workflow job inventory drifted",
  );
  const uploadCount = [...definition.matchAll(/actions\/upload-artifact@/g)]
    .length;
  const downloadCount = [...definition.matchAll(/actions\/download-artifact@/g)]
    .length;
  assert(
    uploadCount === (isScheduled ? 3 : 5),
    "hosted upload action inventory drifted",
  );
  assert(
    downloadCount === (isScheduled ? 0 : 1),
    "hosted download action inventory drifted",
  );
  const jobs = isScheduled
    ? [
        [
          "hygiene",
          "scheduled-hygiene",
          "Full-history, link, and dependency hygiene",
        ],
        ["coverage", "coverage", "Coverage lane"],
        [
          "portable",
          "portable",
          "Compile, test, and prove typed mutation refusal",
        ],
      ]
    : [
        ["fast", "fast", "Fast lane"],
        ["lint", "lint", "Lint lane"],
        ["contract", "contract", "Contract lane"],
        ["security", "security", "Security lane"],
        ["docs", "docs", "Docs lane"],
      ];
  for (const [jobName, lane, laneStepName] of jobs) {
    const job = exactJob(definition, jobName);
    const steps = splitSteps(job);
    exactNamedStep(steps, "Scan source and lockfiles before installation", [
      "      - name: Scan source and lockfiles before installation",
      "        run: node ops/ci/preinstall-scan.mjs",
    ]);
    if (!isScheduled && jobName === "lint") {
      exactNamedStep(steps, "Install checksum-pinned actionlint 1.7.8", [
        "      - name: Install checksum-pinned actionlint 1.7.8",
        "        run: bash ops/ci/install-actionlint.sh",
      ]);
    }
    if (!isScheduled && jobName === "docs") {
      exactNamedStep(steps, "Install locked dependencies without lifecycle scripts", [
        "      - name: Install locked dependencies without lifecycle scripts",
        "        run: npm ci --ignore-scripts --no-audit --no-fund",
      ]);
    }
    exactNamedStep(steps, laneStepName, laneStep(lane, laneStepName));
    exactNamedStep(
      steps,
      "Emit unsigned observation",
      observationStep(lane, !isScheduled),
    );
    exactNamedStep(steps, "Sanitize diagnostics", sanitizeStep(lane));
    exactNamedStep(
      steps,
      "Upload sanitized diagnostics",
      uploadStep(lane, isScheduled, jobName),
    );
    assert(
      steps.filter((step) => step.includes("actions/upload-artifact@"))
        .length === 1,
      `${jobName} must contain exactly one upload action`,
    );
    const scanIndex = steps.findIndex((step) =>
      step.includes("run: node ops/ci/preinstall-scan.mjs"),
    );
    const installerIndexes = steps
      .map((step, index) =>
        /npm install --global|npm ci |install-(?:gitleaks|actionlint)\.sh|taiki-e\/install-action@|playwright install/.test(
          step,
        )
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    assert(
      installerIndexes.length === 0 ||
        scanIndex < Math.min(...installerIndexes),
      `${jobName} installs before source admission`,
    );
  }
  if (!isScheduled) validateRequiredConvergence(definition);
  const expectedHash = isScheduled
    ? "83e80d3f981ef39d4f7a84fbf06b6ffb9d05254c491525eed6c8941bb697da22"
    : "6637ec9e3d1ba4d971c229ca0aa04dd022d8ec86b67188680a355ff81b595dc1";
  assert(
    createHash("sha256").update(definition).digest("hex") === expectedHash,
    "hosted workflow source digest drifted",
  );
}

function validateRequiredConvergence(definition) {
  const job = exactJob(definition, "required");
  const header = `  required:
    name: required
    if: \${{ always() }}
    needs: [fast, lint, contract, security, docs]
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    env:
      EXPECTED_COMMIT: \${{ github.sha }}
    steps:`;
  assert(job.startsWith(header), "required job header is not exact");
  const steps = splitSteps(job);
  exactNamedStep(
    steps,
    "Download exact-run observations and sanitized artifacts",
    [
      "      - name: Download exact-run observations and sanitized artifacts",
      "        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0",
      "        with:",
      "          pattern: portal-${{ github.run_id }}-${{ github.run_attempt }}-*",
      "          path: .ci-artifacts/atomic",
      "          merge-multiple: true",
    ],
  );
  exactNamedStep(steps, "Converge required jobs", [
    "      - name: Converge required jobs",
    "        if: ${{ always() }}",
    "        env:",
    "          NEEDS_JSON: ${{ toJSON(needs) }}",
    '        run: node ops/ci/aggregate.mjs .ci-artifacts/atomic "$EXPECTED_COMMIT"',
  ]);
  assert(
    steps.filter((step) => step.includes("actions/download-artifact@"))
      .length === 1,
    "required must contain exactly one download action",
  );
}

function exactJob(definition, name) {
  const matches = [...definition.matchAll(new RegExp(`^  ${name}:$`, "gm"))];
  assert(matches.length === 1, `job ${name} is missing or duplicated`);
  const start = matches[0].index;
  const rest = definition.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z0-9_-]*:$/m);
  return definition
    .slice(start, next < 0 ? definition.length : start + 1 + next)
    .trimEnd();
}

function splitSteps(job) {
  const starts = [...job.matchAll(/^      - /gm)].map((match) => match.index);
  return starts.map((start, index) =>
    job.slice(start, starts[index + 1] ?? job.length).trimEnd(),
  );
}

function exactNamedStep(steps, name, expectedLines) {
  const header = `      - name: ${name}`;
  const matches = steps.filter((step) => step.split("\n", 1)[0] === header);
  assert(matches.length === 1, `step ${name} is missing or duplicated`);
  assert(
    matches[0] === expectedLines.join("\n"),
    `step ${name} is not the exact admitted block`,
  );
}

function laneStep(lane, name) {
  return [
    `      - name: ${name}`,
    "        id: lane",
    "        run: |",
    "          set +e",
    `          bash scripts/ci-local.sh ${lane}`,
    "          status=$?",
    '          printf \'exit_code=%s\\n\' "$status" >>"$GITHUB_OUTPUT"',
    '          exit "$status"',
  ];
}

function observationStep(lane, hasId) {
  const lines = ["      - name: Emit unsigned observation"];
  if (hasId) lines.push("        id: observe");
  lines.push(
    "        if: ${{ always() }}",
    "        env:",
    "          LANE_OUTCOME: ${{ steps.lane.outcome }}",
    "          LANE_EXIT_CODE: ${{ steps.lane.outputs.exit_code }}",
    `        run: bash scripts/ci-observation.sh ${lane} \"$LANE_OUTCOME\" \"\${LANE_EXIT_CODE:-1}\"`,
  );
  return lines;
}

function sanitizeStep(lane) {
  return [
    "      - name: Sanitize diagnostics",
    "        id: sanitize",
    "        if: ${{ always() }}",
    `        run: node ops/ci/sanitize-artifacts.mjs ${lane}`,
  ];
}

function uploadStep(lane, isScheduled, jobName) {
  let name;
  if (!isScheduled) {
    name = `portal-\${{ github.run_id }}-\${{ github.run_attempt }}-${lane}`;
  } else if (jobName === "portable") {
    name = "portal-${{ github.run_id }}-${{ matrix.os }}";
  } else {
    name = `portal-\${{ github.run_id }}-${lane}`;
  }
  return [
    "      - name: Upload sanitized diagnostics",
    "        if: ${{ always() && steps.sanitize.outcome == 'success' }}",
    "        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
    "        with:",
    `          name: ${name}`,
    `          path: target/ci-upload/${lane}/`,
    "          include-hidden-files: true",
    "          if-no-files-found: error",
    "          retention-days: 14",
  ];
}

function runRequiredHostiles(definition) {
  const expectInvalid = (mutated, label, expectedReason) =>
    assertThrows(() => validateHostedWorkflow(mutated, false), label, expectedReason);
  expectInvalid(
    definition.replace(
      "          bash scripts/ci-local.sh fast",
      "          true # bash scripts/ci-local.sh fast",
    ),
    "comment-preserved lane no-op was accepted",
  );
  expectInvalid(
    definition
      .replace(
        "        id: lane\n        run: |",
        "        id: lane\n        if: ${{ false }}\n        run: |",
      )
      .replace("${LANE_EXIT_CODE:-1}", "${LANE_EXIT_CODE:-0}"),
    "skipped lane with a zero fallback was accepted",
  );
  expectInvalid(
    definition.replace(
      "        id: lane\n        run: |",
      "        id: lane\n        shell: bash -c 'printf exit_code=0 >>\"$GITHUB_OUTPUT\"' {0}\n        run: |",
    ),
    "custom shell that ignores the lane body was accepted",
  );
  expectInvalid(
    definition.replace(
      '        run: bash scripts/ci-observation.sh fast "$LANE_OUTCOME" "${LANE_EXIT_CODE:-1}"',
      '        run: |\n          printf forged=true >>"$GITHUB_OUTPUT"\n          bash scripts/ci-observation.sh fast "$LANE_OUTCOME" "${LANE_EXIT_CODE:-1}"',
    ),
    "prefixed observation body was accepted",
  );
  for (const path of [
    '"target/ci-upload/fast/"',
    "./target/ci-upload/fast/",
    "target/ci-upload/fast/**",
    "|\n            target/ci-upload/fast/\n            .ci-artifacts/",
  ]) {
    expectInvalid(
      definition.replace("target/ci-upload/fast/", path),
      `hostile upload path was accepted: ${path}`,
    );
  }
  expectInvalid(
    definition.replace(
      "      - name: Upload sanitized diagnostics",
      "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: .ci-artifacts/\n      - name: Upload sanitized diagnostics",
    ),
    "second broad upload action was accepted",
  );
  expectInvalid(
    definition.replace(
      "        run: node ops/ci/preinstall-scan.mjs",
      "        run: true # node ops/ci/preinstall-scan.mjs",
    ),
    "comment-preserved source scan no-op was accepted",
  );
  expectInvalid(
    definition.replace(
      "    timeout-minutes: 15",
      "    timeout-minutes: 15\n    defaults:\n      run:\n        shell: bash -c 'true' {0}",
    ),
    "job default shell was accepted",
  );
  expectInvalid(
    definition.replace(
      "    timeout-minutes: 15",
      "    timeout-minutes: 15\n    env:\n      BASH_ENV: hostile",
    ),
    "hazardous job environment was accepted",
  );
  expectInvalid(
    definition.replace(
      '        run: node ops/ci/aggregate.mjs .ci-artifacts/atomic "$EXPECTED_COMMIT"',
      '        run: true # node ops/ci/aggregate.mjs .ci-artifacts/atomic "$EXPECTED_COMMIT"',
    ),
    "comment-preserved convergence no-op was accepted",
  );
  expectInvalid(
    definition.replace(
      '        run: node ops/ci/aggregate.mjs .ci-artifacts/atomic "$EXPECTED_COMMIT"',
      "        shell: bash -c 'true' {0}\n        run: node ops/ci/aggregate.mjs .ci-artifacts/atomic \"$EXPECTED_COMMIT\"",
    ),
    "custom shell that ignores convergence was accepted",
  );
  const docs = exactJob(definition, "docs");
  const install = "      - name: Install locked dependencies without lifecycle scripts\n" +
    "        run: npm ci --ignore-scripts --no-audit --no-fund";
  for (const replacement of ["", install.replace("--ignore-scripts ", ""),
    install.replace("run: npm ci", "run: true # npm ci")]) {
    expectInvalid(definition.replace(docs, docs.replace(install, replacement)),
      "docs dependency installation was removed or weakened",
      `step Install locked dependencies without lifecycle scripts is ${replacement === "" ? "missing or duplicated" : "not the exact admitted block"}`);
  }
  const lint = exactJob(definition, "lint");
  const actionlint = "      - name: Install checksum-pinned actionlint 1.7.8\n" +
    "        run: bash ops/ci/install-actionlint.sh";
  const scan = "      - name: Scan source and lockfiles before installation\n" +
    "        run: node ops/ci/preinstall-scan.mjs";
  expectInvalid(definition.replace(lint, lint.replace(actionlint, "")
    .replace(scan, `${actionlint}\n${scan}`)), "actionlint installed before source admission",
    "lint installs before source admission");
  expectInvalid(definition.replace(actionlint, actionlint.replace("run: bash", "run: true # bash")),
    "actionlint installation was replaced by a no-op",
    "step Install checksum-pinned actionlint 1.7.8 is not the exact admitted block");
  const single = modeledArchiveEntries("file", "observations/lint.json", [
    "observations/lint.json",
  ]);
  const directory = modeledArchiveEntries("directory", "stage", [
    "stage/observations/lint.json",
  ]);
  assert(single.join() === "lint.json", "single-file flattening model drifted");
  assert(
    directory.join() === "observations/lint.json",
    "directory archive model drifted",
  );
}

function runUploadEncodingHostiles(definition, isScheduled) {
  const marker = "      - name: Upload sanitized diagnostics";
  for (const [step, label] of [
    [
      "      - uses : actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: .ci-artifacts/",
      "spaced uses key with a broad upload was accepted",
    ],
    [
      '      - uses: "actions/upload-artifact\\u0040ea165f8d65b6e75b540449e92b4886f43607fa02"\n        with:\n          path: .ci-artifacts/',
      "escaped action identity with a broad upload was accepted",
    ],
  ]) {
    assertThrows(
      () =>
        validateHostedWorkflow(
          definition.replace(marker, `${step}\n${marker}`),
          isScheduled,
        ),
      label,
    );
  }
}

function runAppendedJobHostile(definition, isScheduled) {
  const suffix =
    "\n  broad-upload:\n    runs-on: ubuntu-24.04\n    steps:\n" +
    "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n" +
    "        with:\n          name: broad-root\n          path: .ci-artifacts/\n";
  assertThrows(
    () =>
      validateHostedWorkflow(`${definition.trimEnd()}${suffix}`, isScheduled),
    `${isScheduled ? "scheduled" : "required"} accepted an appended broad-upload job`,
  );
}

function runWorkflowFileInventoryHostiles(inventory) {
  for (const hostile of [
    [...inventory, "broad.yml:file"],
    [...inventory, "broad.yaml:file"],
    [...inventory, ".exfil.yml:file"],
    [...inventory, ".exfil.yaml:file"],
    [...inventory, "broad.yml:directory"],
    [...inventory, "broad.yaml:symlink"],
    ["ci.yml:file", "scheduled.yml:symlink"],
  ]) {
    assertThrows(
      () => validateWorkflowFileInventory(hostile.sort()),
      "extra or non-regular workflow entry was accepted",
    );
  }
}

function modeledArchiveEntries(kind, input, files) {
  if (kind === "file") return [input.split("/").at(-1)];
  return files.map((path) => path.slice(`${input}/`.length));
}

function assertThrows(callback, message, expectedReason) {
  try {
    callback();
  } catch (error) {
    if (expectedReason !== undefined) {
      assert(error instanceof Error && error.message === `CI_META_FAILED: ${expectedReason}`, message);
    }
    return;
  }
  throw new Error(`CI_META_FAILED: ${message}`);
}
