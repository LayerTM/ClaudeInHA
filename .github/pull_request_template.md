## Summary

<!-- What does this change and why? -->

## Related issue

<!-- e.g. Closes #123 -->

## Checklist

- [ ] `npm test` passes (run in `claude-code/app`)
- [ ] `npm run lint` (eslint) and `npm run typecheck` (tsc --checkJs) pass
- [ ] `npm run test:alerts` passes if the alerts loop changed
- [ ] `python .github/scripts/secret_scan.py .` is clean — no tokens/secrets committed
- [ ] Add-on linter (frenck/action-addon-linter) + Dockerfile hadolint pass — check CI if `claude-code/config.yaml` or `claude-code/Dockerfile` changed
- [ ] `claude-code/config.yaml` version + `claude-code/CHANGELOG.md` bumped if behaviour changed
- [ ] `claude-code/DOCS.md` / `README.md` updated if behaviour changed
- [ ] Wire-format changes (if any) were agreed on the integration contract first
