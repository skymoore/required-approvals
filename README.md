# Required Approvals GitHub Action
Checks if the required codeowners have approved a PR and requires a minimum number of approvals

### Inputs:
- `token`
  - **required**
  - The PR token, accessible at `secrets.GITHUB_TOKEN`.
- `read_org_scoped_token`
  - **required**
  - A Personal Access Token (PAT) that has the `read:org` scope for the organization `org_name`.
- `org_name`
  - **required**
  - The github organization to search for teams and team members.
- `min_approvals`
  - **required**
  - The minimum number of approvals, regardless of codeowners team membership.
- `pr_number`
  - _optional_
  - Pull request number, mutually exclusive with branch, will check approvals on this PR if supplied. If not supplied, will check approvals on the PR that triggered the workflow. If both pr_number and branch are supplied it will default to the latest pr on the branch, and check approvals on that PR.
- `branch`
  - _optional_
  - Branch name, mutually exclusive with pr_number, will look for prs from this branch if supplied, select the newest one if there are multiple, and check approvals on that PR. If not supplied, will check approvals on the PR that triggered the workflow.  If both pr_number and branch are supplied it will default to the latest pr on the branch.
- `require_all_approvals_latest_commit`
  - _optional_
  - default: `true`
  - Require all approvals to be on the latest commit of the PR, ignore approvals on previous commits.
- `limit_org_teams_to_codeowners_file`
  - _optional_
  - default: `false`
  - Enable to limit a user's team membership check to only those specified in the `CODEOWNERS` file. This overrides the default behavior of checking all teams in the organization `org_name`. Consider enabling for environments with a large number of teams to reduce execution time.
- `approval_mode`
  - _optional_
  - default: `ALL`
  - Determines the approval requirement for codeowners. If set to "ALL", all codeowners must approve. If set to "ANY", at least one approval from a codeowner is sufficient. If not provided, the default is "ALL".

### Outputs:
- `approved`
  - `true` if all required approvals are met, `false` otherwise

### How to use this GitHub Action:
1. Ensure your repo has a codeowners file at `/.github/CODEOWNERS` or `/CODEOWNERS`
    example `CODEOWNERS`:
    ```
    .github/** @YourOrg/some_team_name
    some_dir/** @YourOrg/some_other_team_name
    ```
2. Create a PAT that has the `read:org` scope enabled for your organization, and add it as a secret to your organization, repo, or environment.
3. Create a workflow that uses the action:
    example workflow:
    ```yaml
    name: PR Approval Workflow

    on:
      pull_request:
        branches:
          - main
      pull_request_review:
        types: [submitted]

    jobs:
      check-approvals:
        runs-on: ubuntu-latest
        permissions:
          id-token: write
          contents: read
          pull-requests: read
        steps:
          - name: Check for required approvals
            id: check-approvals
            uses: skymoore/required-approvals@main
            with:
              token: ${{ secrets.GITHUB_TOKEN }}
              read_org_scoped_token: ${{ secrets.READ_ORG_SCOPED_TOKEN }}
              org_name: yourorg
              min_approvals: 1

          - name: Run action if all required approvals are met
            if: ${{ steps.check-approvals.outputs.approved == 'true' }}
            run: |
              echo "All required approvals are met. Running the action."
    ```