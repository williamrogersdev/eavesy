# Contributing to Eavesy

Thanks for helping. Issues and pull requests are welcome; for anything larger
than a small fix, open an issue first so we can agree on the approach.

## License of contributions

Eavesy is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms
(inbound = outbound), and that you have the right to submit it. Please sign off
your commits (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/).

## Before opening a pull request

See the README for local setup. CI runs the same checks:

```bash
cd web
bun run build
bunx tsc --noEmit
bunx eslint .
bun test src
bun run test:workers
```

Desktop changes also need `cargo test` in `desktop/src-tauri` and
`swift test` in `desktop/swift-audio`.

## Security

Please don't report vulnerabilities in a public issue. See
[SECURITY.md](SECURITY.md) for how to report them privately.
