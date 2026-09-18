# GitHub Actions: nexus-bot

The `nexus-bot` workflow turns `/nexus` comments on pull requests into one-line
CLI invocations. Drop it into any repo to give reviewers a fast feedback loop
without leaving the PR.

## Setup

Copy the template into your consuming repo:

```bash
mkdir -p .github/workflows
curl -L https://raw.githubusercontent.com/asynx6/nexus/main/.github/templates/nexus-bot.yml \
  -o .github/workflows/nexus-bot.yml
git add .github/workflows/nexus-bot.yml
git commit -m "ci: add nexus-bot workflow"
```

The bot requires **write** on pull-requests and issues (to reply). If your
repo enforces strict token permissions, add a workflow-level override:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

## Commands

| Comment             | Action                                                  |
| ------------------- | ------------------------------------------------------- |
| `/nexus doctor`     | Run `nexus doctor --fix` — environment health + repair. |
| `/nexus test`       | Run the NEXUS test suite.                               |
| `/nexus status`     | Print project status.                                   |
| `/nexus help`       | List available commands.                                |

Anything else prints help and exits 0.

## Behaviour

- Triggers only on **pull request** comments (`github.event.issue.pull_request != null`).
- Comment body **must start** with `/nexus`.
- The bot replies to the same comment thread using `marocchino/sticky-pull-request-comment`
  so subsequent runs update the same sticky card.
- Runs on `ubuntu-latest` with Node 22.

## Security

The workflow installs the public `@asynx6/nexus-cli` package. Pin a version
in production:

```yaml
- run: npm install -g @asynx6/nexus-cli@0.2.0 --no-audit --no-fund
```

Limit who can trigger it by adding an actor allowlist at the top of the job:

```yaml
if: |
  github.event.issue.pull_request != null &&
  startsWith(github.event.comment.body, '/nexus') &&
  contains(fromJSON('["dependabot[bot]","my-org-bot"]'), github.actor)
```

## Example

PR comment:

```
/nexus test
```

Reply (sticky):

```
🤖 Nexus bot ran `test ` — Result: success
```

## Limitations

- One command per comment. To run multiple, post multiple comments.
- Output is bounded to ~64KB per sticky reply. Long test logs get truncated.
- The workflow is unauthenticated against the NEXUS gateway — use a
  `NEXUS_GATEWAY_KEY` repo secret if you need write access.
