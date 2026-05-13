# Contributing to sera-mcp

Thanks for taking the time. This is the multi-currency settlement Model Context Protocol server for AI agents — built on [Sera Protocol](https://docs.sera.cx). Contributions are welcome from anyone, in any timezone, at any experience level.

## What kind of contributions help

- **New tools.** If you've found a Sera operation an agent ought to be able to do that we don't expose, file an issue or open a PR. The bar is "this is a primitive multiple agents will need," not "this is a full feature."
- **Host integrations.** Tested setup for an MCP host we haven't written up yet (Cody, Claude Desktop edge cases, IDE extensions, etc.).
- **Tool description improvements.** Agents are LLMs — better tool descriptions make the MCP more capable without code changes.
- **Bug reports + fixes.** Especially anything that breaks the security model (uuid binding, prompt-arg sanitization, base URL allowlist, etc.).
- **Examples.** A reference flow that uses the MCP for a real workflow we don't already cover.
- **Documentation.** README polish, typo fixes, clarity improvements.

## Getting set up

```bash
git clone https://github.com/Josh-sera/sera-mcp
cd sera-mcp
npm install
npm run build
```

## Smoke-testing your changes

The fastest signal that things still work:

```bash
# Build clean
npm run build

# Run the MCP via stdio + verify the tool count + doctor output
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sera.doctor","arguments":{}}}' \
| SERA_NETWORK=mainnet POLICY_PRESET=standard LOG_LEVEL=warn node dist/index.js
```

Expect: 32 tools listed and `overall_ok: true` from doctor.

## Code style

- TypeScript, ES modules.
- Match the existing file structure in `src/tools/`.
- Each new tool: handler in its own file (or a topical group), Zod schema in `src/tools/schemas.ts`, registration in `src/index.ts`.
- Tool descriptions are first-class: write them like docs for an LLM, not for a human reading code.
- Don't break the security model — if you add anything that can take user input and reach an external system or sign anything, document the threat model.

## Pull requests

- Keep PRs focused. One tool per PR, one bug fix per PR.
- Update the in-MCP `sera://help/tools` resource (in `src/resources.ts`) when adding tools.
- Update the README tool count when adding/removing tools.
- If touching anything signing-related, security-related, or policy-related: explain in the PR body what the threat model is.

## Reporting security issues

Don't open a public issue for security findings. Email the maintainer (see GitHub profile) or use [GitHub's private security advisory](https://github.com/Josh-sera/sera-mcp/security/advisories/new).

## License

By contributing, you agree your contributions are licensed under MIT (the same as the project).
