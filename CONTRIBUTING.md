# Contributing

SkillProof turns benchmark output into public claims. Correctness and provenance matter more than adding another metric.

## Before a change

Open an issue for:

- result schema changes;
- new runner or provider presets;
- statistical method changes;
- price catalog format changes;
- changes to verdict semantics.

Small fixes and new tests can go directly to a pull request.

## Local checks

```bash
npm ci
npm run check
npm run demo
```

Inspect the generated demo HTML in light, dark, narrow, and print layouts.

## Design rules

- Keep Node 20 as the minimum and avoid runtime dependencies unless they remove more risk than they add.
- Never use `shell: true`.
- Missing telemetry is null, not zero.
- Keep provider-observed and catalog-estimated costs separate.
- Do not aggregate model results if doing so hides disagreement.
- Preserve failed runs and infrastructure errors.
- Derive HTML and badge verdicts from JSON.
- Escape all untrusted report content.
- Add a test for every repaired parsing or scoring defect.

## Price changes

Use an official provider source. Record the snapshot date and source URL. Do not update prices live during a benchmark, because that makes the same evidence produce a different result later.

## Pull requests

Explain:

- which validity or usability problem changes;
- how it was tested;
- whether the result schema changes;
- whether existing reports remain readable;
- any new security boundary.
