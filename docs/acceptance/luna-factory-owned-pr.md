# Owned PR lifecycle qualification

This manual fixture combines the native OMP worker/acceptance path with #177's owned-PR lifecycle. It drives the real `BatchService`, provider-facing OMP sessions, local Git workspaces, and a bare Git remote. The GitHub hosted-check and publication boundary is scripted; it makes no live GitHub request or merge.

Run the host OMP profile with `OMP_BINARY=/path/to/omp tests/fixtures/luna-factory-owned-pr-acceptance-run.sh native`. To qualify the exact packaged image, set `REVIEW_APPLIANCE_IMAGE` and run `tests/fixtures/luna-factory-owned-pr-acceptance-run.sh oci`. The driver requires the image source label and packaged OMP version to match the checkout.

The scenario creates one PR-ready item and one independent inspection. It observes pending CI, persists a concrete source-bound failure, gives its complete evidence handles to a same-PR repair worker, reruns deterministic checks and independent acceptance against the committed repair SHA/tree, and observes passing checks. The result records the unchanged attempt appetite, one PR identity, two local bare-remote pushes, zero follow-ups or merges, and independent progress during hosted waiting.

Source preparation does not run either profile. Packaged runtime acceptance remains unproved until the fixture is executed against the exact OMP 18.5 image; this scripted GitHub boundary is not live GitHub acceptance.
