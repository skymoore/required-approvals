#!/usr/bin/env python3

import os, logging, re, fnmatch
from github import Github


def get_newest_pr_number_by_branch(gh, branch_name, repo):
    pull_requests = repo.get_pulls(state="all", head=branch_name)
    if pull_requests.totalCount == 0:
        logging.info(f"No PRs found for branch {branch_name}")
        exit(1)
    pull_requests = list(pull_requests)
    pull_requests = sorted(pull_requests, key=lambda pr: pr.created_at, reverse=True)
    newest_pr = pull_requests[0].number
    return newest_pr


def get_required_codeowners(changed_files, repo, pr):

    codeowners_content = repo.get_contents(".github/CODEOWNERS", ref=pr.base.ref)
    if codeowners_content is None:
        codeowners_content = repo.get_contents("CODEOWNERS", ref=pr.base.ref)
    if codeowners_content is None:
        logging.info("No CODEOWNERS file found")
        exit(1)

    logging.debug(
        f"Codeowners content:\n{codeowners_content.decoded_content.decode('utf-8')}"
    )

    codeowners_lines = codeowners_content.decoded_content.decode("utf-8").split("\n")

    codeowners = {}
    for line in codeowners_lines:
        if not line.strip() or line.startswith("#"):
            continue

        pattern, *owners = re.split(r"\s+", line.strip())

        for changed_file in changed_files:
            if fnmatch.fnmatch(changed_file, pattern):
                for owner in owners:
                    owner = re.sub(r"[<>\(\)\[\]\{\},;+*?=]", "", owner)
                    owner = owner.replace("@", "").split("/")[-1]
                    if owner not in codeowners:
                        codeowners[owner] = False

    return codeowners


def get_user_teams(gh, username, org_name):
    logging.debug(f"Getting teams for {username}")
    user = gh.get_user(username)
    org = gh.get_organization(org_name)
    org_teams = org.get_teams()
    logging.debug(f"Found teams for {org.login}: {list(org_teams)}")
    teams = []

    for team in org_teams:
        org_team_members = [member.login for member in team.get_members()]
        logging.debug(
            f"Found members for {org.login}/{team.name}: {list(org_team_members)}"
        )
        if user.login in org_team_members:
            teams.append(team)

    return teams


def main():
    token = os.environ["INPUT_TOKEN"]
    read_org_token = os.environ["INPUT_READ_ORG_SCOPED_TOKEN"]
    org_name = os.environ["INPUT_ORG_NAME"]
    min_approvals = int(os.environ["INPUT_MIN_APPROVALS"])
    require_all_approvals_latest_commit = os.environ[
        "INPUT_REQUIRE_ALL_APPROVALS_LATEST_COMMIT"
    ]
    gh_ref = os.environ["GITHUB_REF"]
    gh_repo = os.environ["GITHUB_REPOSITORY"]

    gh = Github(token)
    gh_org = Github(read_org_token)
    repo = gh.get_repo(gh_repo)
    logging.debug(gh_ref)

    gh_ref_parts = gh_ref.split("/")
    logging.debug(gh_ref_parts)

    if "INPUT_BRANCH" in os.environ and os.environ["INPUT_BRANCH"] != "":
        pr_number = get_newest_pr_number_by_branch(gh, os.environ["INPUT_BRANCH"], repo)
    elif "INPUT_PR_NUMBER" in os.environ and os.environ["INPUT_PR_NUMBER"] != "":
        pr_number = int(os.environ["INPUT_PR_NUMBER"])
    else:
        pr_number = int(gh_ref_parts[-2])

    pr = repo.get_pull(pr_number)
    reviews = pr.get_reviews()
    changed_files = [f.filename for f in pr.get_files()]
    logging.debug(f"Changed files: {changed_files}")

    required_codeowner_entities = get_required_codeowners(changed_files, repo, pr)
    logging.info(f"Required codeowners: {required_codeowner_entities}")

    reviews = list(reviews)
    logging.info(f"Found {len(reviews)} reviews for PR {pr_number} ({pr.title}):")

    approved_codeowners = []
    logging.info("Reviews: ")

    for review in reviews:
        user_teams = get_user_teams(gh_org, review.user.login, org_name)
        logging.debug(f"  {review.user.login} {review.state}: teams: {user_teams}")

        if review.state == "APPROVED":
            for team in user_teams:
                if team.name in required_codeowner_entities:
                    if (
                        require_all_approvals_latest_commit == "true"
                        and review.commit_id != pr.head.sha
                    ):
                        logging.info(
                            f"  {review.user.login} {review.state}: at commit: {review.commit_id} for: {team.name} (not the latest commit, ignoring)"
                        )
                        continue
                    required_codeowner_entities[team.name] = True
                    approved_codeowners.append(review.user.login)
                    logging.info(
                        f"  {review.user.login} {review.state}: at commit: {review.commit_id} for: {team.name}"
                    )
            if review.user.login in required_codeowner_entities:
                required_codeowner_entities[review.user.login] = True
                logging.info(
                    f"  {review.user.login} {review.state}: at commit: {review.commit_id}"
                )

        elif review.state == "CHANGES_REQUESTED":
            for team in user_teams:
                if team.name in required_codeowner_entities:
                    required_codeowner_entities[team.name] = False
                    logging.info(
                        f"  {review.user.login} {review.state}: for: {team.name}"
                    )
            if review.user.login in required_codeowner_entities:
                required_codeowner_entities[review.user.login] = False
                logging.info(
                    f"  {review.user.login} {review.state}: for: {review.user.login}"
                )

        else:
            logging.debug(f"  {review.user.login} {review.state}: ignoring")

    all_codeowners_approved = all(required_codeowner_entities.values())
    min_approvals_met = len(set(approved_codeowners)) >= min_approvals

    co_reason = (
        "all codeowners approved"
        if all_codeowners_approved
        else "not all codeowners approved"
    )
    ma_reason = (
        f"total approvals:{len(approved_codeowners)} >= minimum approvals:{min_approvals}"
        if min_approvals_met
        else f"total approvals:{len(approved_codeowners)} < minimum approvals:{min_approvals}"
    )
    reason = f"{co_reason} and {ma_reason}"

    required_approvals = all_codeowners_approved and min_approvals_met

    with open(os.environ["GITHUB_OUTPUT"], "a") as github_output:
        github_output.write(f"approved={str(required_approvals).lower()}")

    if required_approvals:
        logging.info(f"Required approvals met: {reason}")
        exit(0)
    else:
        logging.warning(f"Required approvals not met: {reason}")
        exit(1)


if __name__ == "__main__":
    log_level = os.environ.get("RUNNER_DEBUG", "0")
    logging.basicConfig(
        level=logging.INFO if log_level == "0" else logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logging.info("Starting required-approvals action")
    logging.debug("Debug logging enabled")
    main()
